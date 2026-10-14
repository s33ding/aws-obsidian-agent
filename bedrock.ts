import {
	BedrockRuntimeClient,
	ConverseCommand,
	ConverseStreamCommand,
	ConversationRole,
	Message,
	Tool,
	ToolConfiguration,
} from "@aws-sdk/client-bedrock-runtime";
import { AgentLanguage, AgentSettings } from "./settings";
import { NoteEdit } from "./edit";

export interface ChatTurn {
	role: "user" | "assistant";
	text: string;
}

/** Result of a tool-enabled turn: spoken text and an optional note edit. */
export interface ToolReply {
	text: string;
	edit: NoteEdit | null;
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
			? "Você é um agente de voz dentro do Obsidian. Seja prático, direto e autônomo. Fale como numa conversa (sua resposta é lida em voz alta): frases curtas, sem markdown nem listas longas. Aja de imediato em vez de pedir confirmação ou fazer perguntas desnecessárias. Se faltar um detalhe pequeno, assuma o mais razoável e siga."
			: "You are a voice agent inside Obsidian. Be practical, direct, and autonomous. Speak conversationally (your reply is read aloud): short sentences, no markdown or long lists. Act immediately instead of asking for confirmation or unnecessary questions. If a small detail is missing, assume the most reasonable option and proceed.";

		if (!this.settings.allowEditing) return base;

		const editProtocol =
			lang === "pt-BR"
				? `\n\nVocê edita a nota ativa com a ferramenta edit_note. Se o usuário pedir qualquer alteração na nota (escrever, adicionar, corrigir, reorganizar, reescrever), CHAME edit_note direto — não peça permissão e não repita o conteúdo na fala. Prefira "replace" para trechos e "append"/"prepend" para adicionar; "replace_all" só para reescrever tudo. Depois, confirme em uma frase curta (ex.: "Pronto, adicionei.").`
				: `\n\nYou edit the active note with the edit_note tool. If the user asks for any change to the note (write, add, fix, reorganize, rewrite), CALL edit_note directly — don't ask permission and don't repeat the content in speech. Prefer "replace" for snippets and "append"/"prepend" to add; "replace_all" only to rewrite everything. Then confirm in one short sentence (e.g., "Done, added it.").`;

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

	/** Tool definition for editing the active note. */
	private editToolConfig(): ToolConfiguration {
		const tool: Tool = {
			toolSpec: {
				name: "edit_note",
				description:
					"Edit the user's active Obsidian note. Use this whenever the user asks to write, add, change, fix, rewrite, or remove text in the note. Prefer 'replace' for targeted changes and 'append'/'prepend' to add text; use 'replace_all' only to rewrite the whole note.",
				inputSchema: {
					json: {
						type: "object",
						properties: {
							op: {
								type: "string",
								enum: ["append", "prepend", "replace", "replace_all"],
								description: "The kind of edit to perform.",
							},
							content: {
								type: "string",
								description:
									"Text to add (for append/prepend) or the full new note (for replace_all).",
							},
							find: {
								type: "string",
								description: "For 'replace': the exact existing text to find.",
							},
							with: {
								type: "string",
								description: "For 'replace': the text to replace it with.",
							},
						},
						required: ["op"],
					},
				},
			},
		};
		return { tools: [tool] };
	}

	/**
	 * Tool-enabled turn used when note editing is allowed. The model either
	 * replies with text (spoken) or calls the edit_note tool with structured
	 * arguments — far more reliable than parsing JSON out of the text.
	 */
	async converseWithTools(
		userText: string,
		history: ChatTurn[],
		lang: AgentLanguage,
		context?: string
	): Promise<ToolReply> {
		const messages: Message[] = [];
		for (const turn of history) {
			messages.push({
				role: turn.role === "user" ? ConversationRole.USER : ConversationRole.ASSISTANT,
				content: [{ text: turn.text }],
			});
		}
		const userContent = context?.trim()
			? [{ text: context.trim() }, { text: userText }]
			: [{ text: userText }];
		messages.push({ role: ConversationRole.USER, content: userContent });

		const command = new ConverseCommand({
			modelId: this.settings.bedrockModelId,
			messages,
			system: [{ text: this.systemPrompt(lang) }],
			inferenceConfig: {
				maxTokens: this.settings.maxTokens,
				temperature: this.settings.temperature,
			},
			toolConfig: this.editToolConfig(),
		});

		const response = await this.getClient().send(command);
		const blocks = response.output?.message?.content ?? [];

		let text = "";
		let edit: NoteEdit | null = null;
		for (const b of blocks) {
			if ("text" in b && b.text) {
				text += b.text;
			} else if ("toolUse" in b && b.toolUse) {
				edit = toNoteEdit(b.toolUse.input);
			}
		}
		text = text.trim();
		if (!text) {
			// Provide a short spoken confirmation if the model only called the tool.
			text = edit
				? lang === "pt-BR"
					? "Pronto, atualizei a nota."
					: "Done, I updated the note."
				: lang === "pt-BR"
				? "Certo."
				: "Okay.";
		}
		return { text, edit };
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

/** Convert a tool_use input object into a validated NoteEdit, or null. */
function toNoteEdit(input: unknown): NoteEdit | null {
	if (!input || typeof input !== "object") return null;
	const o = input as Record<string, unknown>;
	switch (o.op) {
		case "replace_all":
			return typeof o.content === "string" ? { op: "replace_all", content: o.content } : null;
		case "append":
			return typeof o.content === "string" ? { op: "append", content: o.content } : null;
		case "prepend":
			return typeof o.content === "string" ? { op: "prepend", content: o.content } : null;
		case "replace":
			return typeof o.find === "string" && typeof o.with === "string"
				? { op: "replace", find: o.find, with: o.with }
				: null;
		default:
			return null;
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

