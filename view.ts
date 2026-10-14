import { ItemView, Notice, WorkspaceLeaf } from "obsidian";
import { Agent } from "./agent";
import { PollyService } from "./polly";
import { AgentLanguage, AgentSettings, LANGUAGE_LABELS } from "./settings";
import {
	SpeechInput,
	isSpeechRecognitionSupported,
	listAudioInputDevices,
} from "./speech";
import {
	NoteEdit,
	applyEditToFile,
	describeEdit,
	parseReply,
} from "./edit";

export const VIEW_TYPE_AGENT = "aws-obsidian-agent-view";

export class AgentView extends ItemView {
	private agent: Agent;
	private polly: PollyService;
	private settings: AgentSettings;
	private saveSettings: () => Promise<void>;

	private messagesEl!: HTMLElement;
	private inputEl!: HTMLTextAreaElement;
	private langSelectEl!: HTMLSelectElement;
	private deviceSelectEl!: HTMLSelectElement;
	private talkBtn!: HTMLButtonElement;
	private stopBtn!: HTMLButtonElement;
	private statusEl!: HTMLElement;
	private meterEl!: HTMLElement;
	private meterFillEl!: HTMLElement;

	private speech: SpeechInput | null = null;
	private talkOn = false;
	private busy = false;
	private speechInterrupted = false;

	constructor(
		leaf: WorkspaceLeaf,
		settings: AgentSettings,
		agent: Agent,
		polly: PollyService,
		saveSettings: () => Promise<void>
	) {
		super(leaf);
		this.settings = settings;
		this.agent = agent;
		this.polly = polly;
		this.saveSettings = saveSettings;
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

		// Header: language + device selectors.
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
			this.setLanguage(this.langSelectEl.value as AgentLanguage);
		});

		const stopBtn = header.createEl("button", {
			text: this.settings.language === "pt-BR" ? "⏹ Parar fala" : "⏹ Stop",
			cls: "aws-agent-stop mod-warning",
			attr: { "aria-label": "Stop speaking" },
		});
		this.stopBtn = stopBtn;
		stopBtn.addEventListener("click", () => this.stopSpeaking());

		// Device row (microphone selector + live meter).
		const deviceRow = container.createDiv({ cls: "aws-agent-device-row" });
		deviceRow.createSpan({ text: "🎙️", cls: "aws-agent-device-icon" });
		this.deviceSelectEl = deviceRow.createEl("select", { cls: "aws-agent-device" });
		this.deviceSelectEl.createEl("option", { text: "Default microphone", value: "" });
		this.deviceSelectEl.addEventListener("change", () => {
			const id = this.deviceSelectEl.value;
			this.settings.inputDeviceId = id;
			void this.saveSettings();
			this.speech?.setDevice(id || undefined);
		});

		// Live mic level meter (animation).
		this.meterEl = deviceRow.createDiv({ cls: "aws-agent-meter" });
		this.meterFillEl = this.meterEl.createDiv({ cls: "aws-agent-meter-fill" });
		this.setLevel(0);

		void this.populateDevices();

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
		this.talkBtn.addEventListener("click", () => void this.toggleTalk());

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

		if (this.settings.talkMode) {
			void this.startTalk();
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
		void this.saveSettings();
		if (this.langSelectEl && this.langSelectEl.value !== lang) {
			this.langSelectEl.value = lang;
		}
		this.updateTalkButton();
		const note =
			lang === "pt-BR" ? "Idioma alterado para Português." : "Language switched to English.";
		this.addMessage("system", note);
	}

	/**
	 * Called when Transcribe auto-detects the spoken language. Switches the
	 * agent + Polly voice to match, WITHOUT restarting the recognition stream
	 * (auto-detect mode already listens for both languages).
	 */
	private onDetectedLanguage(lang: AgentLanguage): void {
		if (this.settings.language === lang) return;
		this.settings.language = lang;
		this.agent.setLanguage(lang);
		void this.saveSettings();
		if (this.langSelectEl && this.langSelectEl.value !== lang) {
			this.langSelectEl.value = lang;
		}
		this.updateTalkButton();
	}

	// ---- Devices + meter ---------------------------------------------------

	private async populateDevices(): Promise<void> {
		try {
			const devices = await listAudioInputDevices();
			// Clear all but the default option.
			while (this.deviceSelectEl.options.length > 1) {
				this.deviceSelectEl.remove(1);
			}
			devices.forEach((d) => {
				const opt = this.deviceSelectEl.createEl("option", {
					text: d.label,
					value: d.deviceId,
				});
				if (d.deviceId === this.settings.inputDeviceId) opt.selected = true;
			});
		} catch (err) {
			console.error("Failed to enumerate devices", err);
		}
	}

	private setLevel(level: number): void {
		const pct = Math.round(Math.max(0, Math.min(1, level)) * 100);
		this.meterFillEl.style.width = `${pct}%`;
		this.talkBtn?.toggleClass("is-loud", level > 0.2);
	}

	// ---- Talk mode ---------------------------------------------------------

	private async toggleTalk(): Promise<void> {
		if (this.talkOn) this.stopTalk();
		else await this.startTalk();
	}

	/** Public entry for the command palette toggle. */
	toggleTalkPublic(): void {
		void this.toggleTalk();
	}

	private async startTalk(): Promise<void> {
		if (this.talkOn) return;

		this.speech = new SpeechInput(
			this.settings.language,
			{
				onFinal: (text) => this.onUtterance(text),
				onInterim: (text) => this.showInterim(text),
				onLevel: (lvl) => this.setLevel(lvl),
				onStart: () => this.setListeningUI(true),
				onEnd: () => this.setListeningUI(false),
				onError: (err) => this.onSpeechError(err),
				onLanguage: (lang) => this.onDetectedLanguage(lang),
			},
			this.settings,
			{
				deviceId: this.settings.inputDeviceId || undefined,
				silenceMs: this.settings.silenceMs,
				autoDetect: this.settings.autoDetectLanguage,
			}
		);

		if (!isSpeechRecognitionSupported()) {
			new Notice("Microphone not available in this environment.");
		}

		this.talkOn = true;
		this.settings.talkMode = true;
		void this.saveSettings();
		this.updateTalkButton();
		await this.speech.start();
		// Re-populate device labels (labels are only exposed after permission).
		void this.populateDevices();
	}

	private stopTalk(): void {
		this.talkOn = false;
		this.settings.talkMode = false;
		void this.saveSettings();
		this.speech?.stop();
		this.speech = null;
		this.updateTalkButton();
		this.setListeningUI(false);
		this.setLevel(0);
		this.statusEl.hide();
	}

	private onSpeechError(err: string): void {
		if (err === "not-allowed" || err === "service-not-allowed") {
			new Notice("Microphone permission denied.");
			this.stopTalk();
			return;
		}
		if (err.startsWith("mic error")) {
			new Notice(err);
			this.stopTalk();
		}
	}

	private onUtterance(text: string): void {
		const trimmed = text.trim();
		if (!trimmed || this.busy) return;
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
		this.talkBtn.toggleClass("is-active", this.talkOn);
		this.talkBtn.setText(this.talkOn ? "🎙️ Talk: ON" : "🎤 Talk");
	}

	// ---- Messaging ---------------------------------------------------------

	private async handleSend(raw: string): Promise<void> {
		const text = raw.trim();
		if (!text || this.busy) return;
		this.inputEl.value = "";
		this.busy = true;
		this.speechInterrupted = false;
		this.speech?.suspend();
		this.addMessage("user", text);

		const lang = this.settings.language;
		const speak = this.settings.speakResponses;

		// Gather context from the active markdown note, if enabled.
		const context = await this.buildNoteContext();

		// Create a live agent message bubble we append sentences to.
		const bubble = this.addMessage("agent", "");

		if (speak) this.polly.beginStream();

		try {
			const reply = await this.agent.respondStream(
				text,
				(sentence) => {
					// Append to the visible bubble as it streams in.
					bubble.textContent =
						(bubble.textContent ? bubble.textContent + " " : "") + sentence;
					this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
					// Pipe each sentence into the audio queue immediately.
					if (speak && !this.speechInterrupted) this.polly.enqueue(sentence, lang);
				},
				context
			);
			// Parse out any <edit> blocks; show only the clean spoken text.
			const parsed = parseReply(reply.text);
			bubble.textContent = parsed.spokenText || reply.text;
			if (speak) await this.polly.endStream();

			// Handle note edits if the agent proposed any.
			if (parsed.edits.length > 0) {
				await this.handleEdits(parsed.edits);
			}
		} catch (err) {
			console.error(err);
			this.addMessage("system", `Error: ${(err as Error).message}`);
		} finally {
			this.busy = false;
			if (this.talkOn) this.speech?.resume();
		}
	}

	/** Stop the agent's current speech/playback immediately. */
	stopSpeaking(): void {
		this.speechInterrupted = true;
		this.polly.stop();
		const pt = this.settings.language === "pt-BR";
		this.statusEl.show();
		this.statusEl.setText(pt ? "Fala interrompida." : "Speech stopped.");
	}

	private async speak(text: string, lang: AgentLanguage): Promise<void> {
		try {
			this.speech?.suspend();
			await this.polly.speak(text, lang);
		} catch (err) {
			console.error(err);
			new Notice(`Polly error: ${(err as Error).message}`);
			this.addMessage("system", `Speech error: ${(err as Error).message}`);
		}
	}

	/**
	 * Read the active markdown note (the current tab) and format it as context
	 * for the model. Returns undefined if disabled or no note is active.
	 */
	private async buildNoteContext(): Promise<string | undefined> {
		if (!this.settings.includeActiveNote) return undefined;

		const file = this.app.workspace.getActiveFile();
		if (!file || file.extension !== "md") return undefined;

		let content: string;
		try {
			content = await this.app.vault.read(file);
		} catch (err) {
			console.error("Failed to read active note:", err);
			return undefined;
		}

		const max = this.settings.maxNoteChars;
		let body = content;
		if (body.length > max) {
			body = body.slice(0, max) + "\n...[truncated]";
		}
		if (!body.trim()) return undefined;

		const pt = this.settings.language === "pt-BR";
		const header = pt
			? `Contexto: a nota que o usuário está vendo agora é "${file.basename}". Conteúdo entre as marcas.`
			: `Context: the note the user is currently viewing is "${file.basename}". Content is between the markers.`;
		return `${header}\n<nota>\n${body}\n</nota>`;
	}

	/**
	 * Apply or confirm proposed note edits against the active file.
	 */
	private async handleEdits(edits: NoteEdit[]): Promise<void> {
		const pt = this.settings.language === "pt-BR";
		const file = this.app.workspace.getActiveFile();
		if (!file || file.extension !== "md") {
			this.addMessage(
				"system",
				pt ? "Nenhuma nota ativa para editar." : "No active note to edit."
			);
			return;
		}

		for (const edit of edits) {
			if (this.settings.confirmEdits) {
				await this.confirmAndApply(file, edit, pt);
			} else {
				const ok = await applyEditToFile(this.app, file, edit);
				this.addMessage(
					"system",
					ok
						? (pt ? "✏️ Nota editada: " : "✏️ Note edited: ") + describeEdit(edit)
						: (pt ? "Não consegui aplicar a edição." : "Could not apply the edit.")
				);
			}
		}
	}

	/** Render an inline confirmation card with Apply / Reject buttons. */
	private confirmAndApply(
		file: import("obsidian").TFile,
		edit: NoteEdit,
		pt: boolean
	): Promise<void> {
		return new Promise<void>((resolve) => {
			const card = this.messagesEl.createDiv({ cls: "aws-agent-edit-card" });
			card.createDiv({
				cls: "aws-agent-edit-title",
				text: (pt ? "Edição proposta: " : "Proposed edit: ") + describeEdit(edit),
			});
			const btns = card.createDiv({ cls: "aws-agent-edit-btns" });
			const applyBtn = btns.createEl("button", {
				text: pt ? "Aplicar" : "Apply",
				cls: "mod-cta",
			});
			const rejectBtn = btns.createEl("button", { text: pt ? "Rejeitar" : "Reject" });

			const finish = (msg: string) => {
				card.remove();
				this.addMessage("system", msg);
				resolve();
			};

			applyBtn.addEventListener("click", async () => {
				const ok = await applyEditToFile(this.app, file, edit);
				finish(
					ok
						? (pt ? "✏️ Nota editada." : "✏️ Note edited.")
						: pt
						? "Não consegui aplicar (texto não encontrado)."
						: "Could not apply (text not found)."
				);
			});
			rejectBtn.addEventListener("click", () =>
				finish(pt ? "Edição rejeitada." : "Edit rejected.")
			);
			this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
		});
	}

	private addMessage(role: "user" | "agent" | "system", text: string): HTMLElement {
		const row = this.messagesEl.createDiv({ cls: `aws-agent-msg aws-agent-msg-${role}` });
		const textEl = row.createDiv({ cls: "aws-agent-msg-text", text });
		this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
		return textEl;
	}
}
