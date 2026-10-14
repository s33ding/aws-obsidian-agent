import {
	PollyClient,
	SynthesizeSpeechCommand,
	Engine,
	OutputFormat,
	TextType,
	VoiceId,
} from "@aws-sdk/client-polly";
import { AgentSettings, AgentLanguage } from "./settings";

/**
 * Thin wrapper around AWS Polly that synthesizes text to speech and plays
 * it back in the browser/Electron environment Obsidian runs in.
 */
export class PollyService {
	private client: PollyClient | null = null;
	private settingsSnapshot = "";
	private currentAudio: HTMLAudioElement | null = null;

	constructor(private settings: AgentSettings) {}

	/** Rebuild the client only when relevant settings change. */
	private getClient(): PollyClient {
		const snapshot = JSON.stringify({
			r: this.settings.awsRegion,
			a: this.settings.awsAccessKeyId,
			s: this.settings.awsSecretAccessKey,
			t: this.settings.awsSessionToken,
			amb: this.settings.useAmbientCredentials,
		});

		if (!this.client || snapshot !== this.settingsSnapshot) {
			const config: ConstructorParameters<typeof PollyClient>[0] = {
				region: this.settings.awsRegion,
			};

			if (!this.settings.useAmbientCredentials && this.settings.awsAccessKeyId) {
				config.credentials = {
					accessKeyId: this.settings.awsAccessKeyId,
					secretAccessKey: this.settings.awsSecretAccessKey,
					sessionToken: this.settings.awsSessionToken || undefined,
				};
			}

			this.client = new PollyClient(config);
			this.settingsSnapshot = snapshot;
		}

		return this.client;
	}

	private voiceFor(lang: AgentLanguage): string {
		return lang === "pt-BR" ? this.settings.voicePtBr : this.settings.voiceEnUs;
	}

	/** Synthesize `text` in the given language and return playable audio bytes. */
	async synthesize(text: string, lang: AgentLanguage): Promise<Uint8Array> {
		const client = this.getClient();
		const command = new SynthesizeSpeechCommand({
			Text: text,
			TextType: TextType.TEXT,
			OutputFormat: OutputFormat.MP3,
			VoiceId: this.voiceFor(lang) as VoiceId,
			LanguageCode: lang,
			Engine: this.settings.engine === "neural" ? Engine.NEURAL : Engine.STANDARD,
		});

		const response = await client.send(command);
		if (!response.AudioStream) {
			throw new Error("Polly returned no audio stream.");
		}

		// AudioStream is a web ReadableStream / SDK stream; normalize to bytes.
		const bytes = await streamToUint8Array(response.AudioStream as unknown);
		return bytes;
	}

	/** Synthesize and immediately play the given text. Stops prior playback. */
	async speak(text: string, lang: AgentLanguage): Promise<void> {
		const bytes = await this.synthesize(text, lang);
		this.stop();

		const blob = new Blob([bytes], { type: "audio/mpeg" });
		const url = URL.createObjectURL(blob);
		const audio = new Audio(url);
		this.currentAudio = audio;

		await new Promise<void>((resolve, reject) => {
			audio.onended = () => {
				URL.revokeObjectURL(url);
				resolve();
			};
			audio.onerror = () => {
				URL.revokeObjectURL(url);
				reject(new Error("Audio playback failed."));
			};
			void audio.play().catch(reject);
		});
	}

	/** Stop any currently playing audio. */
	stop(): void {
		if (this.currentAudio) {
			this.currentAudio.pause();
			this.currentAudio.currentTime = 0;
			this.currentAudio = null;
		}
	}
}

/** Convert the various stream shapes the AWS SDK may return into bytes. */
async function streamToUint8Array(stream: unknown): Promise<Uint8Array> {
	// Node.js Readable (has async iterator)
	if (stream && typeof (stream as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] === "function") {
		const chunks: Uint8Array[] = [];
		for await (const chunk of stream as AsyncIterable<Uint8Array>) {
			chunks.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
		}
		return concat(chunks);
	}

	// Web ReadableStream
	const maybeWeb = stream as ReadableStream<Uint8Array>;
	if (maybeWeb && typeof maybeWeb.getReader === "function") {
		const reader = maybeWeb.getReader();
		const chunks: Uint8Array[] = [];
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (value) chunks.push(value);
		}
		return concat(chunks);
	}

	// Some SDK stream objects expose transformToByteArray()
	const maybeTransform = stream as { transformToByteArray?: () => Promise<Uint8Array> };
	if (maybeTransform && typeof maybeTransform.transformToByteArray === "function") {
		return maybeTransform.transformToByteArray();
	}

	throw new Error("Unsupported audio stream type returned by Polly.");
}

function concat(chunks: Uint8Array[]): Uint8Array {
	const total = chunks.reduce((n, c) => n + c.length, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const c of chunks) {
		out.set(c, offset);
		offset += c.length;
	}
	return out;
}
