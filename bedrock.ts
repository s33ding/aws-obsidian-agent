import {
	BedrockRuntimeClient,
	ConverseCommand,
	ConverseStreamCommand,
	ConversationRole,
	Message,
} from "@aws-sdk/client-bedrock-runtime";
import { AgentLanguage, AgentSettings } from "./settings";

export interface ChatTurn {
	role: "user" | "assistant";
	text: string;
}

/**
 * Wraps the Amazon Bedrock Converse API. The Converse API is model-agnostic,
 * so switching models is just a config change. History is passed as alternating
 * user/assistant turns; a language-aware system prompt keeps replies in the
 * active language and short enough to be spoken aloud.
 */
export class BedrockService {
	private client: BedrockRuntimeClient | null = null;
	private snapshot = "";

	constructor(private settings: AgentSettings) {}

	private getClient(): BedrockRuntimeClient {
		const snap = JSON.stringify({
			r: this.settings.awsRegion,
			a: this.settings.awsAccessKeyId,
			s: this.settings.awsSecretAccessKey,
			t: this.settings.awsSessionToken,
			amb: this.settings.useAmbientCredentials,
		});
		if (!this.client || snap !== this.snapshot) {
			const config: ConstructorParameters<typeof BedrockRuntimeClient>[0] = {
				region: this.settings.awsRegion,
			};
			if (!this.settings.useAmbientCredentials && this.settings.awsAccessKeyId) {
				config.credentials = {
					accessKeyId: this.settings.awsAccessKeyId,
					secretAccessKey: this.settings.awsSecretAccessKey,
					sessionToken: this.settings.awsSessionToken || undefined,
				};
			}
			this.client = new BedrockRuntimeClient(config);
			this.snapshot = snap;
		}
		return this.client;
	}

	private systemPrompt(lang: AgentLanguage): string {
		const base = this.settings.systemPrompt?.trim()
			? this.settings.systemPrompt.trim()
			: lang === "pt-BR"
			? "Você é um assistente de voz útil dentro do Obsidian. Responda em português do Brasil, de forma natural, concisa e conversacional, pois sua resposta será lida em voz alta. Evite listas longas, markdown e blocos de código a menos que sejam pedidos."
			: "You are a helpful voice assistant inside Obsidian. Reply in English, naturally, concisely and conversationally, since your reply will be read aloud. Avoid long lists, markdown, and code blocks unless explicitly requested.";

		if (!this.settings.allowEditing) return base;

		const editProtocol =
			lang === "pt-BR"
				? `\n\nVocê pode editar a nota ativa do usuário. Quando o usuário pedir para alterar, escrever ou corrigir a nota, inclua UM bloco de edição no formato exato abaixo, além de uma frase curta falada confirmando a ação. NÃO leia o JSON em voz alta; coloque-o apenas dentro das marcas <edit>.
Formatos válidos (JSON dentro de <edit></edit>):
<edit>{"op":"append","content":"texto a adicionar ao final"}</edit>
<edit>{"op":"prepend","content":"texto a adicionar no início"}</edit>
<edit>{"op":"replace","find":"texto exato existente","with":"novo texto"}</edit>
<edit>{"op":"replace_all","content":"novo conteúdo completo da nota"}</edit>
Use "replace" para mudanças pontuais (o "find" deve existir exatamente na nota). Só use "replace_all" quando reescrever a nota inteira. Faça no máximo uma edição por resposta.`
				: `\n\nYou can edit the user's active note. When the user asks to change, write, or fix the note, include ONE edit block in the exact format below, plus a short spoken sentence confirming the action. Do NOT read the JSON aloud; put it only inside the <edit> markers.
Valid formats (JSON inside <edit></edit>):
<edit>{"op":"append","content":"text to add at the end"}</edit>
<edit>{"op":"prepend","content":"text to add at the start"}</edit>
<edit>{"op":"replace","find":"exact existing text","with":"new text"}</edit>
<edit>{"op":"replace_all","content":"the full new note content"}</edit>
Use "replace" for targeted changes (the "find" must exist exactly in the note). Only use "replace_all" when rewriting the whole note. Make at most one edit per reply.`;

		return base + editProtocol;
	}

	/**
	 * Send the conversation to the model and return the assistant's reply text.
	 * `history` should NOT include the latest user message; pass that as `userText`.
	 */
	async converse(
		userText: string,
		history: ChatTurn[],
		lang: AgentLanguage
	): Promise<string> {
		const messages: Message[] = [];
		for (const turn of history) {
			messages.push({
				role: turn.role === "user" ? ConversationRole.USER : ConversationRole.ASSISTANT,
				content: [{ text: turn.text }],
			});
		}
		messages.push({ role: ConversationRole.USER, content: [{ text: userText }] });

		const command = new ConverseCommand({
			modelId: this.settings.bedrockModelId,
			messages,
			system: [{ text: this.systemPrompt(lang) }],
			inferenceConfig: {
				maxTokens: this.settings.maxTokens,
				temperature: this.settings.temperature,
			},
		});

		const response = await this.getClient().send(command);
		const content = response.output?.message?.content ?? [];
		const text = content
			.map((block) => ("text" in block ? block.text : ""))
			.join("")
			.trim();

		if (!text) {
			throw new Error("Bedrock returned an empty response.");
		}
		return text;
	}

	/**
	 * Streaming variant. Invokes the model with ConverseStream and calls
	 * `onSentence` as soon as each complete sentence is available, so callers
	 * can start synthesizing/playing audio before the full reply is generated.
	 * Returns the full concatenated reply when the stream completes.
	 */
	async converseStream(
		userText: string,
		history: ChatTurn[],
		lang: AgentLanguage,
		onSentence: (sentence: string) => void,
		context?: string
	): Promise<string> {
		const messages: Message[] = [];
		for (const turn of history) {
			messages.push({
				role: turn.role === "user" ? ConversationRole.USER : ConversationRole.ASSISTANT,
				content: [{ text: turn.text }],
			});
		}

		// If note context is provided, prepend it as a separate text block in
		// the current user turn so the model can reference what the user is
		// looking at. History stores only the raw user message (set by caller).
		const userContent = context?.trim()
			? [{ text: context.trim() }, { text: userText }]
			: [{ text: userText }];
		messages.push({ role: ConversationRole.USER, content: userContent });

		const command = new ConverseStreamCommand({
			modelId: this.settings.bedrockModelId,
			messages,
			system: [{ text: this.systemPrompt(lang) }],
			inferenceConfig: {
				maxTokens: this.settings.maxTokens,
				temperature: this.settings.temperature,
			},
		});

		const response = await this.getClient().send(command);
		if (!response.stream) {
			throw new Error("Bedrock returned no stream.");
		}

		let full = "";
		let buffer = "";
		// Once an <edit> block starts, stop emitting spoken sentences; the edit
		// JSON must never be spoken. (Per the prompt, prose comes before edits.)
		let suppressed = false;

		for await (const event of response.stream) {
			const delta = event.contentBlockDelta?.delta?.text;
			if (!delta) continue;
			full += delta;
			if (suppressed) continue;

			buffer += delta;

			// If an edit block begins, emit any clean prose before it and stop.
			const editStart = buffer.indexOf("<edit");
			if (editStart !== -1) {
				const prose = buffer.slice(0, editStart).trim();
				if (prose) onSentence(prose);
				buffer = "";
				suppressed = true;
				continue;
			}

			// Emit complete sentences as soon as a boundary appears.
			let boundary = findSentenceBoundary(buffer);
			while (boundary > 0) {
				const sentence = buffer.slice(0, boundary).trim();
				if (sentence) onSentence(sentence);
				buffer = buffer.slice(boundary);
				boundary = findSentenceBoundary(buffer);
			}
		}

		// Flush trailing text only if we never entered an edit block.
		if (!suppressed) {
			const tail = buffer.trim();
			if (tail) onSentence(tail);
		}

		const result = full.trim();
		if (!result) {
			throw new Error("Bedrock returned an empty response.");
		}
		return result;
	}
}

/**
 * Return the index just past the first sentence-ending boundary in `text`,
 * or 0 if none. Avoids splitting on decimals/abbreviations crudely by
 * requiring the punctuation to be followed by a space or end of buffer.
 */
function findSentenceBoundary(text: string): number {
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (c === "." || c === "!" || c === "?" || c === "\n") {
			const next = text[i + 1];
			if (next === undefined || next === " " || next === "\n") {
				return i + 1;
			}
		}
	}
	return 0;
}

