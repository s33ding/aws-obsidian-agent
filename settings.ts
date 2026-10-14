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
};

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
