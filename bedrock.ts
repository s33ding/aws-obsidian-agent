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
import { NoteEdit, toNoteEdit } from "./edit";
import { AgentAction } from "./actions";

export interface ChatTurn {
	role: "user" | "assistant";
	text: string;
}

/** Result of a tool-enabled turn: spoken text and any actions to perform. */
export interface ToolReply {
	text: string;
	actions: AgentAction[];
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
			? "Você é um agente de voz dentro do Obsidian. Seja prático, direto e autônomo. Fale como numa conversa (sua resposta é lida em voz alta): frases curtas, sem markdown nem listas longas. Em saudações, responda só com algo curto como \"Oi!\". Aja de imediato em vez de pedir confirmação ou fazer perguntas desnecessárias. Se faltar um detalhe pequeno, assuma o mais razoável e siga."
			: "You are a voice agent inside Obsidian. Be practical, direct, and autonomous. Speak conversationally (your reply is read aloud): short sentences, no markdown or long lists. For greetings, reply with just a short \"Hello!\". Act immediately instead of asking for confirmation or unnecessary questions. If a small detail is missing, assume the most reasonable option and proceed.";

		if (!this.settings.allowEditing) return base;

		const editProtocol =
			lang === "pt-BR"
				? `\n\nFerramentas disponíveis — CHAME direto, sem pedir permissão nem repetir o conteúdo na fala:
- edit_note: alterar a nota ativa (add_list_item, insert_under_heading, toggle_task, replace, append/prepend, replace_all).
- create_note: criar uma nota nova (name, content opcional) e abri-la.
- open_note: abrir/trocar para outra nota existente.
- rename_note: renomear uma nota (name, newName).
- delete_note: excluir uma nota (vai para a lixeira; só quando o usuário pedir claramente).
- set_view_mode: trocar a aba entre edição ("source") e leitura ("preview").
- add_link: melhorar o grafo adicionando um [[link]] da nota ativa para outra nota.
- research_media: pesquisar na internet e inserir na nota — imagem/vídeo (embed) ou informação atual (preços AWS, estatísticas, notícias) como texto.
Para melhorar o grafo do Obsidian, conecte notas relacionadas com add_link (links formam o grafo). Depois confirme em uma frase curta.`
				: `\n\nAvailable tools — CALL them directly, don't ask permission or repeat the content in speech:
- edit_note: change the active note (add_list_item, insert_under_heading, toggle_task, replace, append/prepend, replace_all).
- create_note: create a new note (name, optional content) and open it.
- open_note: open/switch to another existing note.
- rename_note: rename a note (name, newName).
- delete_note: delete a note (moves to trash; only when the user clearly asks).
- set_view_mode: switch the tab between editing ("source") and reading ("preview").
- add_link: improve the graph by adding a [[link]] from the active note to another note.
- research_media: search the internet and insert into the note — image/video (embed) or current info (AWS prices, statistics, news) as text.
To improve the Obsidian graph, connect related notes with add_link (links form the graph). Then confirm in one short sentence.`;

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
					"Edit the user's active Obsidian markdown note. Use whenever the user asks to write, add, change, fix, rewrite, check off, or organize content. Choose the most structural operation that fits: add_list_item for bullets/tasks, insert_under_heading to put content in a section, toggle_task to check/uncheck, replace for targeted text edits, append/prepend to add at the ends, replace_all only to rewrite the whole note.",
				inputSchema: {
					json: {
						type: "object",
						properties: {
							op: {
								type: "string",
								enum: [
									"append",
									"prepend",
									"replace",
									"replace_all",
									"insert_under_heading",
									"add_list_item",
									"toggle_task",
								],
								description: "The kind of markdown edit to perform.",
							},
							content: {
								type: "string",
								description:
									"Markdown text. For append/prepend/replace_all, or the body for insert_under_heading.",
							},
							find: {
								type: "string",
								description: "For 'replace': the exact existing text to find.",
							},
							with: {
								type: "string",
								description: "For 'replace': the text to replace it with.",
							},
							heading: {
								type: "string",
								description:
									"Heading title (without #) for insert_under_heading, or optional section for add_list_item.",
							},
							text: {
								type: "string",
								description: "For add_list_item/toggle_task: the item or task text.",
							},
							task: {
								type: "boolean",
								description: "For add_list_item: true to make it a checkbox task '- [ ]'.",
							},
							checked: {
								type: "boolean",
								description: "For toggle_task: true to check, false to uncheck.",
							},
						},
						required: ["op"],
					},
				},
			},
		};
		const setViewMode: Tool = {
			toolSpec: {
				name: "set_view_mode",
				description:
					"Switch the active note's tab between editing and reading view. Use when the user asks to read/preview or to edit/write mode.",
				inputSchema: {
					json: {
						type: "object",
						properties: {
							mode: {
								type: "string",
								enum: ["source", "preview"],
								description: "'source' = editing view, 'preview' = reading view.",
							},
						},
						required: ["mode"],
					},
				},
			},
		};
		const addLink: Tool = {
			toolSpec: {
				name: "add_link",
				description:
					"Improve the knowledge graph by adding a [[wikilink]] from the active note to another note. Use when the user wants to connect notes or reduce orphan notes.",
				inputSchema: {
					json: {
						type: "object",
						properties: {
							target: {
								type: "string",
								description: "The note name to link to (without brackets).",
							},
							alias: {
								type: "string",
								description: "Optional display text for the link.",
							},
						},
						required: ["target"],
					},
				},
			},
		};
		const createNoteTool: Tool = {
			toolSpec: {
				name: "create_note",
				description:
					"Create a new markdown note and open it. By default it is placed in the SAME folder as the note the user is currently working on (same topic → same folder). The user doesn't need to specify a folder; only include one in 'name' (as a path like 'Folder/Sub/Note') if they explicitly want a different location.",
				inputSchema: {
					json: {
						type: "object",
						properties: {
							name: {
								type: "string",
								description:
									"Note title, or a path like 'Folder/Note' only if a specific folder is requested. No need to add .md.",
							},
							content: {
								type: "string",
								description: "Optional initial markdown content.",
							},
						},
						required: ["name"],
					},
				},
			},
		};
		const openNoteTool: Tool = {
			toolSpec: {
				name: "open_note",
				description:
					"Open an existing note, switching the view to it. Use when the user asks to go to, open, or show another note.",
				inputSchema: {
					json: {
						type: "object",
						properties: {
							name: {
								type: "string",
								description: "Name or path of the note to open.",
							},
						},
						required: ["name"],
					},
				},
			},
		};
		const renameNoteTool: Tool = {
			toolSpec: {
				name: "rename_note",
				description:
					"Rename a note (backlinks update automatically). Use when the user asks to rename or retitle a file.",
				inputSchema: {
					json: {
						type: "object",
						properties: {
							name: { type: "string", description: "Current note name/path." },
							newName: { type: "string", description: "New name (or path to also move it)." },
						},
						required: ["name", "newName"],
					},
				},
			},
		};
		const deleteNoteTool: Tool = {
			toolSpec: {
				name: "delete_note",
				description:
					"Delete a note (moved to trash, recoverable). Use only when the user clearly asks to delete/remove a file.",
				inputSchema: {
					json: {
						type: "object",
						properties: {
							name: { type: "string", description: "Name or path of the note to delete." },
						},
						required: ["name"],
					},
				},
			},
		};
		const researchMediaTool: Tool = {
			toolSpec: {
				name: "research_media",
				description:
					"Search the internet and insert the result into the active note. Use for 'find an image/video of X and put it here', or for current factual info (AWS prices, statistics, news). mediaType 'image' or 'video' embeds media; 'fact' inserts researched text.",
				inputSchema: {
					json: {
						type: "object",
						properties: {
							query: {
								type: "string",
								description: "What to search for.",
							},
							mediaType: {
								type: "string",
								enum: ["image", "video", "fact"],
								description: "image/video to embed media; fact for text info.",
							},
						},
						required: ["query", "mediaType"],
					},
				},
			},
		};
		return {
			tools: [
				tool,
				setViewMode,
				addLink,
				createNoteTool,
				openNoteTool,
				renameNoteTool,
				deleteNoteTool,
				researchMediaTool,
			],
		};
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
		const actions: AgentAction[] = [];
		for (const b of blocks) {
			if ("text" in b && b.text) {
				text += b.text;
			} else if ("toolUse" in b && b.toolUse) {
				const action = toAgentAction(b.toolUse.name, b.toolUse.input);
				if (action) actions.push(action);
			}
		}
		text = text.trim();
		if (!text) {
			text =
				actions.length > 0
					? lang === "pt-BR"
						? "Pronto."
						: "Done."
					: lang === "pt-BR"
					? "Certo."
					: "Okay.";
		}
		return { text, actions };
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

/** Map a tool_use (name + input) to a structured AgentAction, or null. */
function toAgentAction(name: string | undefined, input: unknown): AgentAction | null {
	const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
	switch (name) {
		case "edit_note": {
			const edit = toNoteEdit(input);
			return edit ? { kind: "edit", edit } : null;
		}
		case "set_view_mode":
			return o.mode === "source" || o.mode === "preview"
				? { kind: "set_view_mode", mode: o.mode }
				: null;
		case "add_link":
			return typeof o.target === "string"
				? {
						kind: "add_link",
						target: o.target,
						alias: typeof o.alias === "string" ? o.alias : undefined,
				  }
				: null;
		case "create_note":
			return typeof o.name === "string"
				? {
						kind: "create_note",
						name: o.name,
						content: typeof o.content === "string" ? o.content : undefined,
				  }
				: null;
		case "open_note":
			return typeof o.name === "string" ? { kind: "open_note", name: o.name } : null;
		case "rename_note":
			return typeof o.name === "string" && typeof o.newName === "string"
				? { kind: "rename_note", name: o.name, newName: o.newName }
				: null;
		case "delete_note":
			return typeof o.name === "string" ? { kind: "delete_note", name: o.name } : null;
		case "research_media":
			return typeof o.query === "string" &&
				(o.mediaType === "image" || o.mediaType === "video" || o.mediaType === "fact")
				? { kind: "research_media", query: o.query, mediaType: o.mediaType }
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

