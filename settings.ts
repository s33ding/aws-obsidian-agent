export type AgentLanguage = "pt-BR" | "en-US";

export interface AgentSettings {
	awsRegion: string;
	awsAccessKeyId: string;
	awsSecretAccessKey: string;
	awsSessionToken: string;
	useAmbientCredentials: boolean;
	language: AgentLanguage;
	voicePtBr: string;
	voiceEnUs: string;
	engine: "standard" | "neural";
	speakResponses: boolean;
	talkMode: boolean;
	inputDeviceId: string;
	silenceMs: number;
	useBedrock: boolean;
	bedrockModelId: string;
	systemPrompt: string;
	maxTokens: number;
	temperature: number;
}

export const DEFAULT_SETTINGS: AgentSettings = {
	awsRegion: "us-east-1",
	awsAccessKeyId: "",
	awsSecretAccessKey: "",
	awsSessionToken: "",
	useAmbientCredentials: true,
	language: "en-US",
	voicePtBr: "Camila",
	voiceEnUs: "Joanna",
	engine: "neural",
	speakResponses: true,
	talkMode: false,
	inputDeviceId: "",
	silenceMs: 1500,
	useBedrock: true,
	bedrockModelId: "us.anthropic.claude-sonnet-4-6",
	systemPrompt: "",
	maxTokens: 512,
	temperature: 0.7,
};

// Bedrock models verified available in the account (Converse-compatible).
export const BEDROCK_MODELS: { id: string; label: string }[] = [
	{ id: "us.anthropic.claude-sonnet-4-6", label: "Claude Sonnet 4.6 (recommended)" },
	{ id: "us.anthropic.claude-haiku-4-5-20251001-v1:0", label: "Claude Haiku 4.5 (fast)" },
];

// Common Polly voices per locale. These are the neural-capable voices
// most relevant to the two supported languages.
export const VOICES: Record<AgentLanguage, string[]> = {
	"pt-BR": ["Camila", "Vitoria", "Ricardo"],
	"en-US": ["Joanna", "Matthew", "Ivy", "Kendra", "Kimberly", "Salli", "Joey", "Justin"],
};

export const LANGUAGE_LABELS: Record<AgentLanguage, string> = {
	"pt-BR": "Português (Brasil)",
	"en-US": "English (US)",
};
