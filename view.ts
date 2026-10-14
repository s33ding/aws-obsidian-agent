import { ItemView, Notice, WorkspaceLeaf } from "obsidian";
import { Agent } from "./agent";
import { PollyService } from "./polly";
import { AgentLanguage, AgentSettings, LANGUAGE_LABELS } from "./settings";
import { SpeechInput, isSpeechRecognitionSupported } from "./speech";

export const VIEW_TYPE_AGENT = "aws-obsidian-agent-view";

export class AgentView extends ItemView {
	private agent: Agent;
	private polly: PollyService;
	private settings: AgentSettings;

	private messagesEl!: HTMLElement;
	private inputEl!: HTMLTextAreaElement;
	private langSelectEl!: HTMLSelectElement;
	private talkBtn!: HTMLButtonElement;
	private statusEl!: HTMLElement;

	private speech: SpeechInput | null = null;
	private talkOn = false;
	/** True while the agent is generating/speaking a reply. */
	private busy = false;

	constructor(
		leaf: WorkspaceLeaf,
		settings: AgentSettings,
		agent: Agent,
		polly: PollyService
	) {
		super(leaf);
		this.settings = settings;
		this.agent = agent;
		this.polly = polly;
	}

	getViewType(): string {
		return VIEW_TYPE_AGENT;
	}

	getDisplayText(): string {
		return "AWS Agent";
	}

	getIcon(): string {
		return "bot";
	}

	async onOpen(): Promise<void> {
		const container = this.contentEl;
		container.empty();
		container.addClass("aws-agent-view");

		// Header with language switcher.
		const header = container.createDiv({ cls: "aws-agent-header" });
		header.createSpan({ text: "Agent", cls: "aws-agent-title" });

		this.langSelectEl = header.createEl("select", { cls: "aws-agent-lang" });
		(Object.keys(LANGUAGE_LABELS) as AgentLanguage[]).forEach((lang) => {
			const opt = this.langSelectEl.createEl("option", {
				text: LANGUAGE_LABELS[lang],
				value: lang,
			});
			if (lang === this.settings.language) opt.selected = true;
		});
		this.langSelectEl.addEventListener("change", () => {
			const lang = this.langSelectEl.value as AgentLanguage;
			this.setLanguage(lang);
		});

		const stopBtn = header.createEl("button", { text: "Stop audio", cls: "aws-agent-stop" });
		stopBtn.addEventListener("click", () => this.polly.stop());

		// Messages area.
		this.messagesEl = container.createDiv({ cls: "aws-agent-messages" });

		// Status / interim transcript line.
		this.statusEl = container.createDiv({ cls: "aws-agent-status" });
		this.statusEl.hide();

		// Input row with Talk mode toggle.
		const inputRow = container.createDiv({ cls: "aws-agent-input-row" });

		this.talkBtn = inputRow.createEl("button", {
			cls: "aws-agent-talk",
			attr: { "aria-label": "Toggle talk mode" },
		});
		this.updateTalkButton();
		this.talkBtn.addEventListener("click", () => this.toggleTalk());

		this.inputEl = inputRow.createEl("textarea", {
			cls: "aws-agent-input",
			attr: { rows: "2", placeholder: "Type a message, or press the mic to talk..." },
		});
		this.inputEl.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault();
				void this.handleSend(this.inputEl.value);
			}
		});

		const sendBtn = inputRow.createEl("button", { text: "Send", cls: "aws-agent-send" });
		sendBtn.addEventListener("click", () => void this.handleSend(this.inputEl.value));

		// Greeting.
		const greeting = this.agent.greeting();
		this.addMessage("agent", greeting.text);
		if (this.settings.speakResponses) {
			void this.speak(greeting.text, greeting.lang);
		}

		// Auto-start talk mode if enabled in settings.
		if (this.settings.talkMode) {
			this.startTalk();
		}
	}

	async onClose(): Promise<void> {
		this.polly.stop();
		this.speech?.stop();
		this.speech = null;
	}

	setLanguage(lang: AgentLanguage): void {
		this.settings.language = lang;
		this.agent.setLanguage(lang);
		this.speech?.setLanguage(lang);
		if (this.langSelectEl && this.langSelectEl.value !== lang) {
			this.langSelectEl.value = lang;
		}
		const note =
			lang === "pt-BR" ? "Idioma alterado para Português." : "Language switched to English.";
		this.addMessage("system", note);
	}

	// ---- Talk mode ---------------------------------------------------------

	private toggleTalk(): void {
		if (this.talkOn) {
			this.stopTalk();
		} else {
			this.startTalk();
		}
	}

	/** Public entry for the command palette toggle. */
	toggleTalkPublic(): void {
		this.toggleTalk();
	}

	private startTalk(): void {
		if (this.talkOn) return;

		if (!isSpeechRecognitionSupported()) {
			new Notice("Speech recognition is not available in this environment.");
			this.addMessage(
				"system",
				this.settings.language === "pt-BR"
					? "Reconhecimento de voz indisponível neste ambiente."
					: "Speech recognition is unavailable here."
			);
			return;
		}

		this.speech = new SpeechInput(this.settings.language, {
			onFinal: (text) => this.onUtterance(text),
			onInterim: (text) => this.showInterim(text),
			onStart: () => this.setListeningUI(true),
			onEnd: () => this.setListeningUI(false),
			onError: (err) => {
				if (err === "not-allowed" || err === "service-not-allowed") {
					new Notice("Microphone permission denied.");
					this.stopTalk();
				}
			},
		});

		this.talkOn = true;
		this.settings.talkMode = true;
		this.speech.start();
		this.updateTalkButton();
		this.setListeningUI(true);
	}

	private stopTalk(): void {
		this.talkOn = false;
		this.settings.talkMode = false;
		this.speech?.stop();
		this.speech = null;
		this.updateTalkButton();
		this.setListeningUI(false);
		this.statusEl.hide();
	}

	/** Called when the recognizer produces a final utterance. */
	private onUtterance(text: string): void {
		const trimmed = text.trim();
		if (!trimmed) return;
		// Ignore speech captured while the agent is busy/speaking.
		if (this.busy) return;
		this.statusEl.hide();
		void this.handleSend(trimmed);
	}

	private showInterim(text: string): void {
		if (!this.talkOn) return;
		this.statusEl.show();
		this.statusEl.setText(
			(this.settings.language === "pt-BR" ? "Ouvindo: " : "Listening: ") + text
		);
	}

	private setListeningUI(listening: boolean): void {
		this.talkBtn.toggleClass("is-listening", listening && this.talkOn);
		if (this.talkOn && listening) {
			this.statusEl.show();
			if (!this.statusEl.getText()) {
				this.statusEl.setText(
					this.settings.language === "pt-BR" ? "Ouvindo..." : "Listening..."
				);
			}
		}
	}

	private updateTalkButton(): void {
		const pt = this.settings.language === "pt-BR";
		this.talkBtn.toggleClass("is-active", this.talkOn);
		this.talkBtn.setText(
			this.talkOn ? (pt ? "🎙️ Talk: ON" : "🎙️ Talk: ON") : (pt ? "🎤 Talk" : "🎤 Talk")
		);
	}

	// ---- Messaging ---------------------------------------------------------

	private async handleSend(raw: string): Promise<void> {
		const text = raw.trim();
		if (!text || this.busy) return;
		this.inputEl.value = "";
		this.busy = true;

		// While processing/speaking, suspend the mic to avoid feedback.
		this.speech?.suspend();

		this.addMessage("user", text);

		try {
			const reply = await this.agent.respond(text);
			this.addMessage("agent", reply.text);
			if (this.settings.speakResponses) {
				await this.speak(reply.text, reply.lang);
			}
		} catch (err) {
			console.error(err);
			this.addMessage("system", `Error: ${(err as Error).message}`);
		} finally {
			this.busy = false;
			// Resume listening after we finished speaking.
			if (this.talkOn) {
				this.speech?.resume();
			}
		}
	}

	private async speak(text: string, lang: AgentLanguage): Promise<void> {
		try {
			// Make sure the mic is suspended during playback.
			this.speech?.suspend();
			await this.polly.speak(text, lang);
		} catch (err) {
			console.error(err);
			new Notice(`Polly error: ${(err as Error).message}`);
			this.addMessage("system", `Speech error: ${(err as Error).message}`);
		}
	}

	private addMessage(role: "user" | "agent" | "system", text: string): void {
		const row = this.messagesEl.createDiv({ cls: `aws-agent-msg aws-agent-msg-${role}` });
		row.createDiv({ cls: "aws-agent-msg-text", text });
		this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
	}
}
