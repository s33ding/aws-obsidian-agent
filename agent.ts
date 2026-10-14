import { BedrockService, ChatTurn } from "./bedrock";
import { AgentLanguage, AgentSettings } from "./settings";
import { NoteEdit } from "./edit";

export interface AgentReply {
	text: string;
	lang: AgentLanguage;
	edit?: NoteEdit | null;
}

/**
 * Conversational agent. When Bedrock is enabled it sends the conversation to
 * the configured model via the Converse API and keeps a rolling history. If
 * Bedrock is disabled or errors out, it falls back to localized rule-based
 * replies so the plugin still responds and speaks.
 */
export class Agent {
	private history: ChatTurn[] = [];
	private bedrock: BedrockService;

	constructor(private settings: AgentSettings) {
		this.bedrock = new BedrockService(settings);
	}

	private get lang(): AgentLanguage {
		return this.settings.language;
	}

	setLanguage(_lang: AgentLanguage): void {
		// Language is read from settings; switching context starts a fresh turn
		// stream but we keep history so the conversation continues.
	}

	getLanguage(): AgentLanguage {
		return this.lang;
	}

	/** Clear the conversation history. */
	reset(): void {
		this.history = [];
	}

	greeting(): AgentReply {
		const text =
			this.lang === "pt-BR"
				? "Olá! Eu sou o seu agente. Pode falar comigo e eu respondo em voz alta."
				: "Hi! I'm your agent. Talk to me and I'll answer out loud.";
		return { text, lang: this.lang };
	}

	async respond(message: string): Promise<AgentReply> {
		const msg = message.trim();
		if (!msg) {
			return {
				text: this.lang === "pt-BR" ? "Diga alguma coisa." : "Say something.",
				lang: this.lang,
			};
		}

		if (this.settings.useBedrock) {
			try {
				const reply = await this.bedrock.converse(msg, this.history, this.lang);
				this.history.push({ role: "user", text: msg });
				this.history.push({ role: "assistant", text: reply });
				this.trimHistory();
				return { text: reply, lang: this.lang };
			} catch (err) {
				console.error("Bedrock error, falling back to rules:", err);
				const prefix =
					this.lang === "pt-BR"
						? "(Bedrock indisponível) "
						: "(Bedrock unavailable) ";
				return { text: prefix + this.ruleBasedReply(msg), lang: this.lang };
			}
		}

		return { text: this.ruleBasedReply(msg), lang: this.lang };
	}

	/**
	 * Streaming reply: calls `onSentence` as each sentence is generated so the
	 * caller can synthesize/play audio incrementally. Returns the full reply.
	 * Falls back to a single non-streamed sentence if Bedrock is off/errors.
	 */
	async respondStream(
		message: string,
		onSentence: (sentence: string) => void,
		context?: string
	): Promise<AgentReply> {
		const msg = message.trim();
		if (!msg) {
			const t = this.lang === "pt-BR" ? "Diga alguma coisa." : "Say something.";
			onSentence(t);
			return { text: t, lang: this.lang };
		}

		if (this.settings.useBedrock) {
			try {
				// When editing is allowed, use the tool-enabled (non-streaming)
				// path so the model returns a structured edit instead of prose.
				if (this.settings.allowEditing) {
					const result = await this.bedrock.converseWithTools(
						msg,
						this.history,
						this.lang,
						context
					);
					onSentence(result.text);
					this.history.push({ role: "user", text: msg });
					this.history.push({ role: "assistant", text: result.text });
					this.trimHistory();
					return { text: result.text, lang: this.lang, edit: result.edit };
				}

				const reply = await this.bedrock.converseStream(
					msg,
					this.history,
					this.lang,
					onSentence,
					context
				);
				// Store only the user's own message in history, not the note
				// context (which can change and would bloat later turns).
				this.history.push({ role: "user", text: msg });
				this.history.push({ role: "assistant", text: reply });
				this.trimHistory();
				return { text: reply, lang: this.lang };
			} catch (err) {
				console.error("Bedrock stream error, falling back to rules:", err);
				const t = this.ruleBasedReply(msg);
				onSentence(t);
				return { text: t, lang: this.lang };
			}
		}

		const t = this.ruleBasedReply(msg);
		onSentence(t);
		return { text: t, lang: this.lang };
	}

	/** Keep the last N turns to bound token usage. */
	private trimHistory(): void {
		const MAX_TURNS = 20; // 10 exchanges
		if (this.history.length > MAX_TURNS) {
			this.history = this.history.slice(this.history.length - MAX_TURNS);
		}
	}

	private ruleBasedReply(msg: string): string {
		const lower = msg.toLowerCase();
		const pt = this.lang === "pt-BR";

		if (/\b(oi|ol[aá]|hello|hi|hey)\b/.test(lower)) {
			return pt ? "Olá! Como posso ajudar você hoje?" : "Hello! How can I help you today?";
		}
		if (/\b(obrigad|thanks|thank you)\b/.test(lower)) {
			return pt ? "De nada! Precisa de mais alguma coisa?" : "You're welcome! Anything else?";
		}
		if (/\b(tchau|bye|goodbye|adeus)\b/.test(lower)) {
			return pt ? "Até logo!" : "Goodbye!";
		}
		if (/\b(hora|horas|time)\b/.test(lower)) {
			const now = new Date().toLocaleTimeString(pt ? "pt-BR" : "en-US");
			return pt ? `Agora são ${now}.` : `It's currently ${now}.`;
		}
		return pt
			? `Você disse: "${msg}".`
			: `You said: "${msg}".`;
	}
}
