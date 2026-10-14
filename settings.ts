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
	engine: "standard" | "neural" | "generative" | "long-form";
	speakResponses: boolean;
	talkMode: boolean;
	inputDeviceId: string;
	silenceMs: number;
	useBedrock: boolean;
	bedrockModelId: string;
	systemPrompt: string;
	maxTokens: number;
	temperature: number;
	includeActiveNote: boolean;
	maxNoteChars: number;
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
	engine: "generative",
	speakResponses: true,
	talkMode: false,
	inputDeviceId: "",
	silenceMs: 1500,
	useBedrock: true,
	bedrockModelId: "us.anthropic.claude-sonnet-4-6",
	systemPrompt: "",
	maxTokens: 512,
	temperature: 0.7,
	includeActiveNote: true,
	maxNoteChars: 6000,
};

// Bedrock models verified available in the account (Converse-compatible).
export const BEDROCK_MODELS: { id: string; label: string }[] = [
	{ id: "us.anthropic.claude-sonnet-4-6", label: "Claude Sonnet 4.6 (recommended)" },
	{ id: "us.anthropic.claude-haiku-4-5-20251001-v1:0", label: "Claude Haiku 4.5 (fast)" },
];

// Polly voices per locale, prioritizing the most natural (generative-capable)
// voices verified available in the account via DescribeVoices.
export const VOICES: Record<AgentLanguage, string[]> = {
	"pt-BR": ["Camila", "Vitoria", "Thiago", "Ricardo"],
	"en-US": ["Joanna", "Danielle", "Ruth", "Matthew", "Stephen", "Salli", "Tiffany", "Kimberly"],
};

// Which engines each voice supports (for picking the best natural engine).
export const VOICE_ENGINES: Record<string, string[]> = {
	// pt-BR
	Camila: ["generative", "neural", "standard"],
	Vitoria: ["neural", "standard"],
	Thiago: ["neural"],
	Ricardo: ["standard"],
	// en-US
	Joanna: ["generative", "neural", "standard"],
	Danielle: ["generative", "long-form", "neural"],
	Ruth: ["generative", "long-form", "neural"],
	Matthew: ["generative", "neural", "standard"],
	Stephen: ["generative", "neural"],
	Salli: ["generative", "neural", "standard"],
	Tiffany: ["generative"],
	Kimberly: ["neural", "standard"],
};

export const ENGINE_LABELS: Record<string, string> = {
	generative: "Generative (most natural)",
	"long-form": "Long-form",
	neural: "Neural",
	standard: "Standard",
};

export const LANGUAGE_LABELS: Record<AgentLanguage, string> = {
	"pt-BR": "Português (Brasil)",
	"en-US": "English (US)",
};
