import { AgentLanguage, AgentSettings } from "./settings";
import { TranscribeStream } from "./transcribe";

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

	private stream: MediaStream | null = null;
	private audioCtx: AudioContext | null = null;
	private analyser: AnalyserNode | null = null;
	private processor: ScriptProcessorNode | null = null;
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

	// Barge-in: consecutive loud frames while suspended trigger an interrupt.
	private bargeInFrames = 0;
	private bargeInFired = false;

	constructor(
		lang: AgentLanguage,
		callbacks: SpeechCallbacks,
		settings: AgentSettings,
		opts: { deviceId?: string; silenceMs?: number } = {}
	) {
		this.lang = lang;
		this.callbacks = callbacks;
		this.deviceId = opts.deviceId;
		this.silenceMs = opts.silenceMs ?? 1500;
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
		this.bargeInFrames = 0;
		this.bargeInFired = false;
		this.callbacks.onLevel?.(0);
	}

	resume(): void {
		if (!this.active || !this.suspended) return;
		this.suspended = false;
		this.bargeInFrames = 0;
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
		this.sourceNode = this.audioCtx.createMediaStreamSource(this.stream);

		// Analyser for the level meter.
		this.analyser = this.audioCtx.createAnalyser();
		this.analyser.fftSize = 512;
		this.analyser.smoothingTimeConstant = 0.6;
		this.sourceNode.connect(this.analyser);

		// ScriptProcessor to tap raw PCM frames for Transcribe.
		this.processor = this.audioCtx.createScriptProcessor(4096, 1, 1);
		this.processor.onaudioprocess = (e: AudioProcessingEvent) => {
			if (!this.active || this.suspended) return;
			const input = e.inputBuffer.getChannelData(0);
			if (this.transcribe.isRunning()) {
				// Copy out of the live buffer before handing off.
				this.transcribe.pushAudio(new Float32Array(input), this.audioCtx!.sampleRate);
			}
		};
		this.sourceNode.connect(this.processor);
		// ScriptProcessor must be connected to destination to fire on some engines.
		this.processor.connect(this.audioCtx.destination);

		this.startLevelLoop();
		this.callbacks.onStart?.();
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

	private startLevelLoop(): void {
		const analyser = this.analyser;
		if (!analyser) return;
		const data = new Uint8Array(analyser.fftSize);
		const SPEECH_THRESHOLD = 0.06;
		// Barge-in needs a louder, sustained signal to avoid tripping on the
		// agent's own audio echoing back (echoCancellation also helps here).
		const BARGE_IN_THRESHOLD = 0.14;
		const BARGE_IN_FRAMES = 6; // ~6 animation frames of sustained speech

		const tick = () => {
			if (!this.analyser) return;
			this.analyser.getByteTimeDomainData(data);
			let sum = 0;
			for (let i = 0; i < data.length; i++) {
				const v = (data[i] - 128) / 128;
				sum += v * v;
			}
			const rms = Math.sqrt(sum / data.length);
			const level = Math.min(1, rms * 3);

			if (!this.suspended) {
				this.callbacks.onLevel?.(level);
				this.handleVad(rms > SPEECH_THRESHOLD);
			} else {
				// Suspended = agent is speaking. Watch for the user interrupting.
				this.detectBargeIn(rms > BARGE_IN_THRESHOLD, BARGE_IN_FRAMES);
			}

			this.levelRaf = requestAnimationFrame(tick);
		};
		this.levelRaf = requestAnimationFrame(tick);
	}

	/** Count sustained loud frames while suspended; fire onBargeIn once. */
	private detectBargeIn(loud: boolean, framesNeeded: number): void {
		if (this.bargeInFired) return;
		if (loud) {
			this.bargeInFrames++;
			if (this.bargeInFrames >= framesNeeded) {
				this.bargeInFired = true;
				this.bargeInFrames = 0;
				this.callbacks.onBargeIn?.();
			}
		} else {
			this.bargeInFrames = 0;
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
		void this.transcribe.start(this.lang, {
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
		});
	}

	private restartTranscription(): void {
		this.transcribe.stop();
		// Give the stream a tick to unwind before restarting.
		window.setTimeout(() => this.startTranscription(), 200);
	}
}
