import { ItemView, Notice, WorkspaceLeaf } from "obsidian";
import { Agent } from "./agent";
import { PollyService } from "./polly";
import { AgentLanguage, AgentSettings, LANGUAGE_LABELS } from "./settings";

export const VIEW_TYPE_AGENT = "aws-obsidian-agent-view";

export class AgentView extends ItemView {
	private agent: Agent;
	private polly: PollyService;
	private settings: AgentSettings;

	private messagesEl!: HTMLElement;
	private inputEl!: HTMLTextAreaElement;
	private langSelectEl!: HTMLSelectElement;

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

		// Input row.
		const inputRow = container.createDiv({ cls: "aws-agent-input-row" });
		this.inputEl = inputRow.createEl("textarea", {
			cls: "aws-agent-input",
			attr: { rows: "2", placeholder: "Type a message and press Enter..." },
		});
		this.inputEl.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault();
				void this.handleSend();
			}
		});

		const sendBtn = inputRow.createEl("button", { text: "Send", cls: "aws-agent-send" });
		sendBtn.addEventListener("click", () => void this.handleSend());

		// Greeting.
		const greeting = this.agent.greeting();
		this.addMessage("agent", greeting.text);
		if (this.settings.speakResponses) {
			void this.speak(greeting.text, greeting.lang);
		}
	}

	async onClose(): Promise<void> {
		this.polly.stop();
	}

	setLanguage(lang: AgentLanguage): void {
		this.settings.language = lang;
		this.agent.setLanguage(lang);
		if (this.langSelectEl && this.langSelectEl.value !== lang) {
			this.langSelectEl.value = lang;
		}
		const note =
			lang === "pt-BR" ? "Idioma alterado para Português." : "Language switched to English.";
		this.addMessage("system", note);
	}

	private async handleSend(): Promise<void> {
		const text = this.inputEl.value.trim();
		if (!text) return;
		this.inputEl.value = "";

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
		}
	}

	private async speak(text: string, lang: AgentLanguage): Promise<void> {
		try {
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
