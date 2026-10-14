import { AgentLanguage, AgentSettings } from "./settings";
import { TranscribeStream } from "./transcribe";
import { workletModuleUrl, TARGET_RATE } from "./worklet";

export interface AudioInputDevice {
	deviceId: string;
	label: string;
}

/** Enumerate available audio input devices (microphones). */
export async function listAudioInputDevices(): Promise<AudioInputDevice[]> {
	if (!navigator.mediaDevices?.enumerateDevices) return [];
	const devices = await navigator.mediaDevices.enumerateDevices();
	return devices
		.filter((d) => d.kind === "audioinput")
		.map((d, i) => ({
			deviceId: d.deviceId,
			label: d.label || `Microphone ${i + 1}`,
		}));
}

/**
 * Transcription is handled by Amazon Transcribe (see transcribe.ts), so the
 * Web Speech API is no longer required. This stays true as long as the mic
 * stream can be opened.
 */
export function isSpeechRecognitionSupported(): boolean {
	return !!navigator.mediaDevices?.getUserMedia;
}

export interface SpeechCallbacks {
	/** Fired with the final transcript when a turn ends (silence). */
	onFinal: (text: string) => void;
	/** Fired continuously with the current partial transcript. */
	onInterim?: (text: string) => void;
	/** Microphone is open and listening. */
	onStart?: () => void;
	/** Microphone fully stopped. */
	onEnd?: () => void;
	/** A recoverable or fatal error occurred. */
	onError?: (error: string) => void;
	/** Real-time input level in 0..1, for the mic animation. */
	onLevel?: (level: number) => void;
	/** Fired when Transcribe detects the spoken language (auto-detect mode). */
	onLanguage?: (lang: AgentLanguage) => void;
	/** Fired when sustained user speech is detected while suspended (barge-in). */
	onBargeIn?: () => void;
}

/**
 * Hands-free voice input using a persistent microphone stream plus Amazon
 * Transcribe streaming for recognition.
 *
 * - One getUserMedia stream stays open while talk mode is on (no KDE flicker).
 * - A Web Audio AnalyserNode drives the level animation.
 * - A ScriptProcessor taps raw PCM frames and feeds them to Transcribe.
 * - Silence-based endpointing flushes the accumulated transcript as one turn.
 */
export class SpeechInput {
	private lang: AgentLanguage;
	private callbacks: SpeechCallbacks;
	private deviceId: string | undefined;
	private silenceMs: number;
	private autoDetect: boolean;

	private stream: MediaStream | null = null;
	private audioCtx: AudioContext | null = null;
	private analyser: AnalyserNode | null = null;
	private processor: ScriptProcessorNode | null = null;
	private workletNode: AudioWorkletNode | null = null;
	private sourceNode: MediaStreamAudioSourceNode | null = null;
	private levelRaf: number | null = null;

	private transcribe: TranscribeStream;

	private active = false;
	private suspended = false;

	// Turn buffering + endpointing.
	private finalBuffer = "";
	private partialBuffer = "";
	private silenceTimer: number | null = null;
	private speaking = false;

	// Barge-in: accumulate ms of loud input while suspended, fire once.
	private bargeInLoudMs = 0;
	private bargeInFired = false;
	private lastTickTs = 0;
	private bargeInLogCount = 0;

	constructor(
		lang: AgentLanguage,
		callbacks: SpeechCallbacks,
		settings: AgentSettings,
		opts: { deviceId?: string; silenceMs?: number; autoDetect?: boolean } = {}
	) {
		this.lang = lang;
		this.callbacks = callbacks;
		this.deviceId = opts.deviceId;
		this.silenceMs = opts.silenceMs ?? 1500;
		this.autoDetect = opts.autoDetect ?? false;
		this.transcribe = new TranscribeStream(settings);
	}

	setLanguage(lang: AgentLanguage): void {
		if (this.lang === lang) return;
		this.lang = lang;
		// Restart the transcription session in the new language.
		if (this.active && !this.suspended) {
			this.restartTranscription();
		}
	}

	setDevice(deviceId: string | undefined): void {
		if (this.deviceId === deviceId) return;
		this.deviceId = deviceId;
		if (this.active) void this.restartStream();
	}

	isActive(): boolean {
		return this.active;
	}

	async start(): Promise<void> {
		if (this.active) return;
		this.active = true;
		this.suspended = false;
		await this.openStream();
		this.startTranscription();
	}

	stop(): void {
		this.active = false;
		this.suspended = false;
		this.clearSilenceTimer();
		this.transcribe.stop();
		this.closeStream();
		this.finalBuffer = "";
		this.partialBuffer = "";
		this.callbacks.onEnd?.();
	}

	suspend(): void {
		if (!this.active || this.suspended) return;
		this.suspended = true;
		this.clearSilenceTimer();
		this.transcribe.stop();
		// Arm barge-in detection for this playback window.
		this.bargeInLoudMs = 0;
		this.bargeInFired = false;
		this.lastTickTs = 0;
		this.callbacks.onLevel?.(0);
	}

	resume(): void {
		if (!this.active || !this.suspended) return;
		this.suspended = false;
		this.bargeInLoudMs = 0;
		this.bargeInFired = false;
		this.finalBuffer = "";
		this.partialBuffer = "";
		this.startTranscription();
	}

	// ---- Mic stream + metering + PCM tap ----------------------------------

	private async openStream(): Promise<void> {
		if (!navigator.mediaDevices?.getUserMedia) {
			this.callbacks.onError?.("getUserMedia not available in this environment.");
			this.active = false;
			return;
		}
		try {
			const constraints: MediaStreamConstraints = {
				audio: this.deviceId
					? {
							deviceId: { exact: this.deviceId },
							echoCancellation: true,
							noiseSuppression: true,
					  }
					: { echoCancellation: true, noiseSuppression: true },
			};
			this.stream = await navigator.mediaDevices.getUserMedia(constraints);
		} catch (err) {
			this.callbacks.onError?.(
				(err as Error).name === "NotAllowedError"
					? "not-allowed"
					: `mic error: ${(err as Error).message}`
			);
			this.active = false;
			return;
		}

		const Ctx =
			window.AudioContext ||
			(window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
		this.audioCtx = new Ctx();
		// Autoplay policy can start the context suspended; resume it so audio
		// actually flows (fixes "no audio captured").
		if (this.audioCtx.state === "suspended") {
			try {
				await this.audioCtx.resume();
			} catch (e) {
				console.warn("[agent] audioCtx.resume failed", e);
			}
		}
		console.log("[agent] audioCtx state:", this.audioCtx.state, "sampleRate:", this.audioCtx.sampleRate);
		this.sourceNode = this.audioCtx.createMediaStreamSource(this.stream);

		// Load the AudioWorklet (runs capture + level on the audio thread, off
		// the main thread) so UI/Polly/Bedrock never block microphone capture.
		try {
			const url = workletModuleUrl();
			await this.audioCtx.audioWorklet.addModule(url);
			URL.revokeObjectURL(url);
			this.workletNode = new AudioWorkletNode(this.audioCtx, "capture-processor", {
				numberOfInputs: 1,
				numberOfOutputs: 0,
				channelCount: 1,
			});
			let frameLog = 0;
			this.workletNode.port.onmessage = (ev: MessageEvent) => {
				const msg = ev.data as
					| { type: "audio"; samples: Float32Array }
					| { type: "level"; rms: number };
				if (msg.type === "level") {
					this.onAudioLevel(msg.rms);
				} else if (msg.type === "audio") {
					if (!this.active || this.suspended) return;
					if (frameLog++ % 25 === 0) {
						let peak = 0;
						for (let i = 0; i < msg.samples.length; i++)
							peak = Math.max(peak, Math.abs(msg.samples[i]));
						console.log(
							`[agent] worklet frame peak=${peak.toFixed(3)} transcribeRunning=${this.transcribe.isRunning()}`
						);
					}
					if (this.transcribe.isRunning()) {
						// Worklet already downsampled to TARGET_RATE (16 kHz).
						this.transcribe.pushAudio(msg.samples, TARGET_RATE);
					}
				}
			};
			this.sourceNode.connect(this.workletNode);
			console.log("[agent] AudioWorklet capture started");
		} catch (err) {
			console.error("[agent] AudioWorklet failed, falling back to ScriptProcessor", err);
			this.startScriptProcessorFallback();
		}

		this.callbacks.onStart?.();
	}

	/** Legacy capture path if AudioWorklet is unavailable. */
	private startScriptProcessorFallback(): void {
		if (!this.audioCtx || !this.sourceNode) return;
		const processor = this.audioCtx.createScriptProcessor(4096, 1, 1);
		processor.onaudioprocess = (e: AudioProcessingEvent) => {
			const input = e.inputBuffer.getChannelData(0);
			let sum = 0;
			for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
			this.onAudioLevel(Math.sqrt(sum / input.length));
			if (!this.active || this.suspended) return;
			if (this.transcribe.isRunning()) {
				this.transcribe.pushAudio(new Float32Array(input), this.audioCtx!.sampleRate);
			}
		};
		this.sourceNode.connect(processor);
		const mute = this.audioCtx.createGain();
		mute.gain.value = 0;
		processor.connect(mute);
		mute.connect(this.audioCtx.destination);
		this.processor = processor;
	}

	private async restartStream(): Promise<void> {
		this.transcribe.stop();
		this.closeStream();
		await this.openStream();
		if (this.active && !this.suspended) this.startTranscription();
	}

	private closeStream(): void {
		if (this.levelRaf !== null) {
			cancelAnimationFrame(this.levelRaf);
			this.levelRaf = null;
		}
		if (this.workletNode) {
			this.workletNode.port.onmessage = null;
			try {
				this.workletNode.disconnect();
			} catch {
				/* ignore */
			}
			this.workletNode = null;
		}
		if (this.processor) {
			this.processor.onaudioprocess = null;
			try {
				this.processor.disconnect();
			} catch {
				/* ignore */
			}
			this.processor = null;
		}
		if (this.sourceNode) {
			try {
				this.sourceNode.disconnect();
			} catch {
				/* ignore */
			}
			this.sourceNode = null;
		}
		this.analyser = null;
		if (this.audioCtx) {
			void this.audioCtx.close().catch(() => undefined);
			this.audioCtx = null;
		}
		if (this.stream) {
			this.stream.getTracks().forEach((t) => t.stop());
			this.stream = null;
		}
		this.callbacks.onLevel?.(0);
	}

	/**
	 * Handle a loudness sample from the audio worklet. Drives the UI meter and
	 * VAD endpointing while listening, and barge-in detection while suspended
	 * (agent speaking). Runs off worklet messages, not requestAnimationFrame,
	 * so it keeps working even if the main thread is busy.
	 */
	private onAudioLevel(rms: number): void {
		const SPEECH_THRESHOLD = 0.015;
		const BARGE_IN_THRESHOLD = 0.04;
		const BARGE_IN_MS = 250;

		if (!this.suspended) {
			this.callbacks.onLevel?.(Math.min(1, rms * 4));
			this.handleVad(rms > SPEECH_THRESHOLD);
		} else {
			if (this.bargeInLogCount++ % 15 === 0) {
				console.log(
					`[agent] barge-in watch rms=${rms.toFixed(4)} (threshold ${BARGE_IN_THRESHOLD})`
				);
			}
			this.detectBargeIn(rms > BARGE_IN_THRESHOLD, BARGE_IN_MS);
		}
	}

	/** Accumulate loud time while suspended; fire onBargeIn once past the threshold. */
	private detectBargeIn(loud: boolean, neededMs: number): void {
		if (this.bargeInFired) return;
		const now = performance.now();
		const dt = this.lastTickTs ? now - this.lastTickTs : 16;
		this.lastTickTs = now;
		if (loud) {
			this.bargeInLoudMs += dt;
			if (this.bargeInLoudMs >= neededMs) {
				this.bargeInFired = true;
				this.bargeInLoudMs = 0;
				console.log("[agent] BARGE-IN fired — interrupting playback");
				this.callbacks.onBargeIn?.();
			}
		} else {
			// Decay quickly so brief noises don't accumulate.
			this.bargeInLoudMs = Math.max(0, this.bargeInLoudMs - dt);
		}
	}

	// ---- Endpointing -------------------------------------------------------

	private handleVad(isSpeech: boolean): void {
		if (isSpeech) {
			this.speaking = true;
			this.clearSilenceTimer();
		} else if (this.speaking && this.silenceTimer === null) {
			this.silenceTimer = window.setTimeout(() => {
				this.silenceTimer = null;
				this.flushTurn();
			}, this.silenceMs);
		}
	}

	private clearSilenceTimer(): void {
		if (this.silenceTimer !== null) {
			clearTimeout(this.silenceTimer);
			this.silenceTimer = null;
		}
	}

	private flushTurn(): void {
		this.speaking = false;
		const text = (this.finalBuffer || this.partialBuffer).trim();
		this.finalBuffer = "";
		this.partialBuffer = "";
		if (text) this.callbacks.onFinal(text);
	}

	// ---- Transcription -----------------------------------------------------

	private startTranscription(): void {
		if (!this.active || this.suspended || this.transcribe.isRunning()) return;
		void this.transcribe.start(
			this.lang,
			{
				onPartial: (text) => {
					this.partialBuffer = text;
					this.callbacks.onInterim?.(text);
				},
				onFinal: (text) => {
					this.finalBuffer = (this.finalBuffer + " " + text).trim();
				},
				onError: (msg) => {
					this.callbacks.onError?.(msg);
				},
				onLanguage: (lang) => {
					this.callbacks.onLanguage?.(lang);
				},
			},
			this.autoDetect
		);
	}

	private restartTranscription(): void {
		this.transcribe.stop();
		// Give the stream a tick to unwind before restarting.
		window.setTimeout(() => this.startTranscription(), 200);
	}
}
