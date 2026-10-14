import { ItemView, Notice, WorkspaceLeaf } from "obsidian";
import { Agent } from "./agent";
import { PollyService } from "./polly";
import { AgentLanguage, AgentSettings, LANGUAGE_LABELS } from "./settings";
import {
	SpeechInput,
	isSpeechRecognitionSupported,
	listAudioInputDevices,
} from "./speech";

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
	private statusEl!: HTMLElement;
	private meterEl!: HTMLElement;
	private meterFillEl!: HTMLElement;

	private speech: SpeechInput | null = null;
	private talkOn = false;
	private busy = false;

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

		const stopBtn = header.createEl("button", { text: "Stop audio", cls: "aws-agent-stop" });
		stopBtn.addEventListener("click", () => this.polly.stop());

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
				onBargeIn: () => this.onBargeIn(),
			},
			this.settings,
			{
				deviceId: this.settings.inputDeviceId || undefined,
				silenceMs: this.settings.silenceMs,
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

	/**
	 * User started speaking while the agent was talking: stop the agent's
	 * audio immediately and start listening. The ongoing speak()/handleSend
	 * flow resumes the mic in its finally block once playback is torn down.
	 */
	private onBargeIn(): void {
		if (!this.talkOn) return;
		this.polly.stop();
		this.statusEl.show();
		this.statusEl.setText(
			this.settings.language === "pt-BR" ? "Pode falar..." : "Go ahead..."
		);
		// Resume recognition right away so we capture the interrupting speech.
		this.speech?.resume();
	}

	// ---- Messaging ---------------------------------------------------------

	private async handleSend(raw: string): Promise<void> {
		const text = raw.trim();
		if (!text || this.busy) return;
		this.inputEl.value = "";
		this.busy = true;
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
			if (this.talkOn) this.speech?.resume();
		}
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

	private addMessage(role: "user" | "agent" | "system", text: string): void {
		const row = this.messagesEl.createDiv({ cls: `aws-agent-msg aws-agent-msg-${role}` });
		row.createDiv({ cls: "aws-agent-msg-text", text });
		this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
	}
}
