import {
	BedrockRuntimeClient,
	ConverseCommand,
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
}
