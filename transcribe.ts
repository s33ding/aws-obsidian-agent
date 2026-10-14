import {
	TranscribeStreamingClient,
	StartStreamTranscriptionCommand,
	LanguageCode,
	MediaEncoding,
	AudioStream,
} from "@aws-sdk/client-transcribe-streaming";
import { AgentLanguage, AgentSettings } from "./settings";

const SAMPLE_RATE = 16000;

const LANG_CODE: Record<AgentLanguage, LanguageCode> = {
	"pt-BR": LanguageCode.PT_BR,
	"en-US": LanguageCode.EN_US,
};

export interface TranscribeCallbacks {
	/** Partial (not stabilized) transcript for the current utterance. */
	onPartial?: (text: string) => void;
	/** A completed (stabilized) transcript segment. */
	onFinal: (text: string) => void;
	onError?: (message: string) => void;
}

/**
 * Streams microphone PCM audio to Amazon Transcribe and surfaces partial and
 * final transcripts. Replaces the Web Speech API, which does not function in
 * Obsidian's Electron/Flatpak runtime.
 *
 * The caller feeds raw Float32 audio frames (from a Web Audio processor) via
 * `pushAudio`; this class downsamples to 16 kHz 16-bit PCM and pumps them into
 * the Transcribe streaming request through an async generator.
 */
export class TranscribeStream {
	private client: TranscribeStreamingClient | null = null;
	private running = false;
	private closed = false;

	// Audio frame queue bridging the Web Audio callback and the async stream.
	private queue: Uint8Array[] = [];
	private resolveNext: ((v: void) => void) | null = null;

	constructor(private settings: AgentSettings) {}

	private getClient(): TranscribeStreamingClient {
		if (!this.client) {
			const config: ConstructorParameters<typeof TranscribeStreamingClient>[0] = {
				region: this.settings.awsRegion,
			};
			if (!this.settings.useAmbientCredentials && this.settings.awsAccessKeyId) {
				config.credentials = {
					accessKeyId: this.settings.awsAccessKeyId,
					secretAccessKey: this.settings.awsSecretAccessKey,
					sessionToken: this.settings.awsSessionToken || undefined,
				};
			}
			this.client = new TranscribeStreamingClient(config);
		}
		return this.client;
	}

	get sampleRate(): number {
		return SAMPLE_RATE;
	}

	isRunning(): boolean {
		return this.running;
	}

	/** Push a mono Float32 frame captured at `inputRate` Hz. */
	pushAudio(frame: Float32Array, inputRate: number): void {
		if (!this.running || this.closed) return;
		const pcm = floatTo16BitPCM(downsample(frame, inputRate, SAMPLE_RATE));
		this.queue.push(pcm);
		if (this.resolveNext) {
			const r = this.resolveNext;
			this.resolveNext = null;
			r();
		}
	}

	/** Begin a streaming transcription session for the given language. */
	async start(lang: AgentLanguage, callbacks: TranscribeCallbacks): Promise<void> {
		if (this.running) return;
		this.running = true;
		this.closed = false;
		this.queue = [];

		const audioStream = this.audioGenerator();

		const command = new StartStreamTranscriptionCommand({
			LanguageCode: LANG_CODE[lang],
			MediaEncoding: MediaEncoding.PCM,
			MediaSampleRateHertz: SAMPLE_RATE,
			AudioStream: audioStream,
		});

		try {
			const response = await this.getClient().send(command);
			if (!response.TranscriptResultStream) {
				throw new Error("No transcript stream returned.");
			}
			for await (const event of response.TranscriptResultStream) {
				if (!this.running) break;
				const results = event.TranscriptEvent?.Transcript?.Results ?? [];
				for (const result of results) {
					const alt = result.Alternatives?.[0];
					const text = alt?.Transcript?.trim();
					if (!text) continue;
					if (result.IsPartial) {
						callbacks.onPartial?.(text);
					} else {
						callbacks.onFinal(text);
					}
				}
			}
		} catch (err) {
			if (this.running) {
				callbacks.onError?.((err as Error).message);
			}
		} finally {
			this.running = false;
		}
	}

	/** Stop the streaming session. */
	stop(): void {
		this.running = false;
		this.closed = true;
		// Unblock the generator so it can terminate.
		if (this.resolveNext) {
			const r = this.resolveNext;
			this.resolveNext = null;
			r();
		}
	}

	/** Async generator yielding audio events to the SDK. */
	private async *audioGenerator(): AsyncGenerator<AudioStream> {
		while (this.running && !this.closed) {
			if (this.queue.length === 0) {
				await new Promise<void>((resolve) => {
					this.resolveNext = resolve;
				});
				if (!this.running || this.closed) break;
			}
			const chunk = this.queue.shift();
			if (chunk && chunk.length > 0) {
				yield { AudioEvent: { AudioChunk: chunk } };
			}
		}
	}
}

/** Downsample a Float32 buffer from `inputRate` to `targetRate` (linear). */
function downsample(buffer: Float32Array, inputRate: number, targetRate: number): Float32Array {
	if (targetRate >= inputRate) return buffer;
	const ratio = inputRate / targetRate;
	const newLen = Math.round(buffer.length / ratio);
	const result = new Float32Array(newLen);
	let offsetResult = 0;
	let offsetBuffer = 0;
	while (offsetResult < newLen) {
		const nextOffsetBuffer = Math.round((offsetResult + 1) * ratio);
		let accum = 0;
		let count = 0;
		for (let i = offsetBuffer; i < nextOffsetBuffer && i < buffer.length; i++) {
			accum += buffer[i];
			count++;
		}
		result[offsetResult] = count > 0 ? accum / count : 0;
		offsetResult++;
		offsetBuffer = nextOffsetBuffer;
	}
	return result;
}

/** Convert Float32 [-1,1] samples to little-endian 16-bit PCM bytes. */
function floatTo16BitPCM(input: Float32Array): Uint8Array {
	const out = new Uint8Array(input.length * 2);
	const view = new DataView(out.buffer);
	for (let i = 0; i < input.length; i++) {
		let s = Math.max(-1, Math.min(1, input[i]));
		s = s < 0 ? s * 0x8000 : s * 0x7fff;
		view.setInt16(i * 2, s, true);
	}
	return out;
}
