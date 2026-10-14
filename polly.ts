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

	// Pipelined playback queue: each item is a promise resolving to audio bytes
	// (synthesis may still be in flight) so we can prefetch while playing.
	private queue: Promise<Uint8Array>[] = [];
	private playing = false;
	private stopped = false;

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

	private engineValue(): Engine {
		// Use the literal engine string; the installed SDK enum may predate
		// "generative"/"long-form", but the service accepts these values.
		return this.settings.engine as Engine;
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
			Engine: this.engineValue(),
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

	/**
	 * Streaming/pipelined speech. Call `beginStream()`, then `enqueue()` each
	 * sentence as it arrives from the model (synthesis starts immediately and
	 * in parallel), then `endStream()` to await full playback. The first
	 * sentence starts playing as soon as its audio is ready — no need to wait
	 * for the whole reply.
	 */
	beginStream(): void {
		this.stop();
		this.stopped = false;
		this.queue = [];
	}

	/** Queue a sentence for synthesis + sequential playback. */
	enqueue(text: string, lang: AgentLanguage): void {
		if (this.stopped) return;
		const trimmed = text.trim();
		if (!trimmed) return;
		// Kick off synthesis immediately (parallel prefetch).
		this.queue.push(this.synthesize(trimmed, lang));
		if (!this.playing) void this.drainQueue();
	}

	/** Wait until the queue has fully drained (all audio played). */
	async endStream(): Promise<void> {
		// Poll until playback finishes or we're stopped.
		while ((this.playing || this.queue.length > 0) && !this.stopped) {
			await new Promise((r) => setTimeout(r, 50));
		}
	}

	private async drainQueue(): Promise<void> {
		this.playing = true;
		try {
			while (this.queue.length > 0 && !this.stopped) {
				const bytesPromise = this.queue.shift()!;
				let bytes: Uint8Array;
				try {
					bytes = await bytesPromise;
				} catch (err) {
					console.error("Polly synthesis failed for a sentence:", err);
					continue;
				}
				if (this.stopped) return;
				await this.playBytes(bytes);
			}
		} finally {
			this.playing = false;
		}
	}

	private playBytes(bytes: Uint8Array): Promise<void> {
		const blob = new Blob([bytes], { type: "audio/mpeg" });
		const url = URL.createObjectURL(blob);
		const audio = new Audio(url);
		this.currentAudio = audio;
		return new Promise<void>((resolve) => {
			const done = () => {
				URL.revokeObjectURL(url);
				if (this.currentAudio === audio) this.currentAudio = null;
				resolve();
			};
			audio.onended = done;
			audio.onerror = done;
			void audio.play().catch(done);
		});
	}

	/** Stop any currently playing audio and clear the queue. */
	stop(): void {
		this.stopped = true;
		this.queue = [];
		if (this.currentAudio) {
			this.currentAudio.onended = null;
			this.currentAudio.onerror = null;
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
