import { App, Notice, Plugin, PluginSettingTab, Setting, WorkspaceLeaf } from "obsidian";
import { Agent } from "./agent";
import { PollyService } from "./polly";
import {
	AgentLanguage,
	AgentSettings,
	BEDROCK_MODELS,
	DEFAULT_SETTINGS,
	LANGUAGE_LABELS,
	VOICES,
} from "./settings";
import { AgentView, VIEW_TYPE_AGENT } from "./view";

export default class AwsObsidianAgentPlugin extends Plugin {
	settings!: AgentSettings;
	agent!: Agent;
	polly!: PollyService;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.agent = new Agent(this.settings);
		this.polly = new PollyService(this.settings);

		this.registerView(
			VIEW_TYPE_AGENT,
			(leaf) =>
				new AgentView(
					leaf,
					this.settings,
					this.agent,
					this.polly,
					() => this.saveSettings()
				)
		);

		this.addRibbonIcon("bot", "Open AWS Agent", () => {
			void this.activateView();
		});

		this.addCommand({
			id: "open-aws-agent",
			name: "Open AWS Agent",
			callback: () => void this.activateView(),
		});

		this.addCommand({
			id: "toggle-agent-language",
			name: "Toggle agent language (pt-BR / en-US)",
			callback: () => {
				const next: AgentLanguage =
					this.settings.language === "pt-BR" ? "en-US" : "pt-BR";
				this.setLanguage(next);
			},
		});

		this.addCommand({
			id: "test-edit-active-note",
			name: "Test: write a line to the active note",
			callback: async () => {
				const file = this.app.workspace.getActiveFile();
				if (!file || file.extension !== "md") {
					new Notice("Open a markdown note first.");
					return;
				}
				try {
					const current = await this.app.vault.read(file);
					const stamp = new Date().toLocaleTimeString();
					await this.app.vault.modify(file, current + `\n> [agent test] ${stamp}`);
					new Notice("Test edit written to the note.");
				} catch (e) {
					new Notice("Test edit FAILED: " + (e as Error).message);
					console.error("[agent] test edit failed", e);
				}
			},
		});

		this.addCommand({
			id: "stop-agent-audio",
			name: "Stop agent audio",
			callback: () => this.polly.stop(),
		});

		this.addCommand({
			id: "toggle-talk-mode",
			name: "Toggle talk mode (hands-free voice)",
			callback: () => {
				void this.activateView().then(() => {
					const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_AGENT);
					const view = leaves[0]?.view;
					if (view instanceof AgentView) view.toggleTalkPublic();
				});
			},
		});

		this.addSettingTab(new AgentSettingTab(this.app, this));
	}

	onunload(): void {
		this.polly?.stop();
	}

	async activateView(): Promise<void> {
		const { workspace } = this.app;
		let leaf: WorkspaceLeaf | null = null;
		const existing = workspace.getLeavesOfType(VIEW_TYPE_AGENT);

		if (existing.length > 0) {
			leaf = existing[0];
		} else {
			leaf = workspace.getRightLeaf(false);
			await leaf?.setViewState({ type: VIEW_TYPE_AGENT, active: true });
		}

		if (leaf) workspace.revealLeaf(leaf);
	}

	setLanguage(lang: AgentLanguage): void {
		this.settings.language = lang;
		this.agent.setLanguage(lang);
		void this.saveSettings();

		// Update any open view.
		this.app.workspace.getLeavesOfType(VIEW_TYPE_AGENT).forEach((leaf) => {
			const view = leaf.view;
			if (view instanceof AgentView) view.setLanguage(lang);
		});
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}

class AgentSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: AwsObsidianAgentPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "AWS Obsidian Agent" });

		new Setting(containerEl)
			.setName("Language")
			.setDesc("Active language for the agent and Polly voice (used as the default/preferred when auto-detect is on).")
			.addDropdown((dd) => {
				(Object.keys(LANGUAGE_LABELS) as AgentLanguage[]).forEach((lang) => {
					dd.addOption(lang, LANGUAGE_LABELS[lang]);
				});
				dd.setValue(this.plugin.settings.language).onChange((value) => {
					this.plugin.setLanguage(value as AgentLanguage);
				});
			});

		new Setting(containerEl)
			.setName("Auto-detect spoken language")
			.setDesc("Automatically switch between pt-BR and en-US based on what you say (hands-free voice).")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.autoDetectLanguage).onChange(async (v) => {
					this.plugin.settings.autoDetectLanguage = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Speak responses")
			.setDesc("Automatically read agent replies aloud with Polly.")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.speakResponses).onChange(async (v) => {
					this.plugin.settings.speakResponses = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Talk mode on open")
			.setDesc("Start hands-free voice listening automatically when the agent opens.")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.talkMode).onChange(async (v) => {
					this.plugin.settings.talkMode = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("End-of-turn silence (ms)")
			.setDesc("How long of a pause ends your turn and sends what you said. Lower = snappier.")
			.addSlider((s) =>
				s
					.setLimits(600, 3000, 100)
					.setValue(this.plugin.settings.silenceMs)
					.setDynamicTooltip()
					.onChange(async (v) => {
						this.plugin.settings.silenceMs = v;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Polly engine")
			.setDesc("Generative is the most natural. Neural is a good balance; standard is cheapest. Availability depends on the selected voice.")
			.addDropdown((dd) => {
				dd.addOption("generative", "Generative (most natural)");
				dd.addOption("long-form", "Long-form");
				dd.addOption("neural", "Neural");
				dd.addOption("standard", "Standard");
				dd.setValue(this.plugin.settings.engine).onChange(async (v) => {
					this.plugin.settings.engine = v as
						| "standard"
						| "neural"
						| "generative"
						| "long-form";
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName("Voice (pt-BR)")
			.setDesc("Polly voice used for Portuguese.")
			.addDropdown((dd) => {
				VOICES["pt-BR"].forEach((v) => dd.addOption(v, v));
				dd.setValue(this.plugin.settings.voicePtBr).onChange(async (v) => {
					this.plugin.settings.voicePtBr = v;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName("Voice (en-US)")
			.setDesc("Polly voice used for English.")
			.addDropdown((dd) => {
				VOICES["en-US"].forEach((v) => dd.addOption(v, v));
				dd.setValue(this.plugin.settings.voiceEnUs).onChange(async (v) => {
					this.plugin.settings.voiceEnUs = v;
					await this.plugin.saveSettings();
				});
			});

		containerEl.createEl("h3", { text: "Intelligence (Amazon Bedrock)" });

		new Setting(containerEl)
			.setName("Use Bedrock")
			.setDesc("Power the agent's replies with an Amazon Bedrock model. Off = simple built-in replies.")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.useBedrock).onChange(async (v) => {
					this.plugin.settings.useBedrock = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Model")
			.setDesc("Bedrock model used to generate replies.")
			.addDropdown((dd) => {
				BEDROCK_MODELS.forEach((m) => dd.addOption(m.id, m.label));
				// Allow a custom id already set that isn't in the list.
				if (!BEDROCK_MODELS.some((m) => m.id === this.plugin.settings.bedrockModelId)) {
					dd.addOption(this.plugin.settings.bedrockModelId, this.plugin.settings.bedrockModelId);
				}
				dd.setValue(this.plugin.settings.bedrockModelId).onChange(async (v) => {
					this.plugin.settings.bedrockModelId = v;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName("System prompt (optional)")
			.setDesc("Override the default persona. Leave blank to use the built-in voice-friendly prompt.")
			.addTextArea((ta) => {
				ta.setValue(this.plugin.settings.systemPrompt).onChange(async (v) => {
					this.plugin.settings.systemPrompt = v;
					await this.plugin.saveSettings();
				});
				ta.inputEl.rows = 3;
			});

		new Setting(containerEl)
			.setName("Temperature")
			.setDesc("Higher = more creative, lower = more focused.")
			.addSlider((s) =>
				s
					.setLimits(0, 1, 0.1)
					.setValue(this.plugin.settings.temperature)
					.setDynamicTooltip()
					.onChange(async (v) => {
						this.plugin.settings.temperature = v;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Max tokens")
			.setDesc("Maximum length of each reply.")
			.addSlider((s) =>
				s
					.setLimits(128, 2048, 64)
					.setValue(this.plugin.settings.maxTokens)
					.setDynamicTooltip()
					.onChange(async (v) => {
						this.plugin.settings.maxTokens = v;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Use active note as context")
			.setDesc("Let the agent read the markdown note in the current tab so it can answer about what you're viewing.")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.includeActiveNote).onChange(async (v) => {
					this.plugin.settings.includeActiveNote = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Max note characters")
			.setDesc("Cap how much of the active note is sent as context (controls token usage).")
			.addSlider((s) =>
				s
					.setLimits(1000, 20000, 1000)
					.setValue(this.plugin.settings.maxNoteChars)
					.setDynamicTooltip()
					.onChange(async (v) => {
						this.plugin.settings.maxNoteChars = v;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Allow note editing")
			.setDesc("Let the agent modify the active note when you ask it to.")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.allowEditing).onChange(async (v) => {
					this.plugin.settings.allowEditing = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Confirm edits before applying")
			.setDesc("Show an Apply/Reject card before writing changes to the note (recommended).")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.confirmEdits).onChange(async (v) => {
					this.plugin.settings.confirmEdits = v;
					await this.plugin.saveSettings();
				})
			);

		containerEl.createEl("h3", { text: "AWS credentials" });

		new Setting(containerEl)
			.setName("Use ambient credentials")
			.setDesc(
				"Use credentials from the environment / AWS profile (recommended on desktop). " +
					"Disable to enter keys manually below."
			)
			.addToggle((t) =>
				t.setValue(this.plugin.settings.useAmbientCredentials).onChange(async (v) => {
					this.plugin.settings.useAmbientCredentials = v;
					await this.plugin.saveSettings();
					this.display();
				})
			);

		new Setting(containerEl)
			.setName("AWS region")
			.addText((txt) =>
				txt
					.setPlaceholder("us-east-1")
					.setValue(this.plugin.settings.awsRegion)
					.onChange(async (v) => {
						this.plugin.settings.awsRegion = v.trim();
						await this.plugin.saveSettings();
					})
			);

		if (!this.plugin.settings.useAmbientCredentials) {
			new Setting(containerEl).setName("Access key ID").addText((txt) =>
				txt.setValue(this.plugin.settings.awsAccessKeyId).onChange(async (v) => {
					this.plugin.settings.awsAccessKeyId = v.trim();
					await this.plugin.saveSettings();
				})
			);

			new Setting(containerEl).setName("Secret access key").addText((txt) => {
				txt.setValue(this.plugin.settings.awsSecretAccessKey).onChange(async (v) => {
					this.plugin.settings.awsSecretAccessKey = v.trim();
					await this.plugin.saveSettings();
				});
				txt.inputEl.type = "password";
			});

			new Setting(containerEl)
				.setName("Session token")
				.setDesc("Optional, for temporary credentials.")
				.addText((txt) => {
					txt.setValue(this.plugin.settings.awsSessionToken).onChange(async (v) => {
						this.plugin.settings.awsSessionToken = v.trim();
						await this.plugin.saveSettings();
					});
					txt.inputEl.type = "password";
				});
		}
	}
}
