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
		if (this.settings.systemPrompt?.trim()) {
			return this.settings.systemPrompt.trim();
		}
		return lang === "pt-BR"
			? "Você é um assistente de voz útil dentro do Obsidian. Responda em português do Brasil, de forma natural, concisa e conversacional, pois sua resposta será lida em voz alta. Evite listas longas, markdown e blocos de código a menos que sejam pedidos."
			: "You are a helpful voice assistant inside Obsidian. Reply in English, naturally, concisely and conversationally, since your reply will be read aloud. Avoid long lists, markdown, and code blocks unless explicitly requested.";
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

		for await (const event of response.stream) {
			const delta = event.contentBlockDelta?.delta?.text;
			if (!delta) continue;
			full += delta;
			buffer += delta;

			// Emit complete sentences as soon as a boundary appears.
			let boundary = findSentenceBoundary(buffer);
			while (boundary > 0) {
				const sentence = buffer.slice(0, boundary).trim();
				if (sentence) onSentence(sentence);
				buffer = buffer.slice(boundary);
				boundary = findSentenceBoundary(buffer);
			}
		}

		// Flush any trailing text that didn't end with punctuation.
		const tail = buffer.trim();
		if (tail) onSentence(tail);

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

