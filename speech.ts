import { AgentLanguage } from "./settings";

// The Web Speech API is not in the default TS DOM lib in all setups, so we
// declare the minimal surface we use.
interface SpeechRecognitionAlternativeLike {
	transcript: string;
}
interface SpeechRecognitionResultLike {
	readonly isFinal: boolean;
	readonly length: number;
	item(index: number): SpeechRecognitionAlternativeLike;
	[index: number]: SpeechRecognitionAlternativeLike;
}
interface SpeechRecognitionResultListLike {
	readonly length: number;
	item(index: number): SpeechRecognitionResultLike;
	[index: number]: SpeechRecognitionResultLike;
}
interface SpeechRecognitionEventLike extends Event {
	readonly resultIndex: number;
	readonly results: SpeechRecognitionResultListLike;
}
interface SpeechRecognitionErrorEventLike extends Event {
	readonly error: string;
	readonly message: string;
}
interface SpeechRecognitionLike extends EventTarget {
	lang: string;
	continuous: boolean;
	interimResults: boolean;
	maxAlternatives: number;
	start(): void;
	stop(): void;
	abort(): void;
	onresult: ((e: SpeechRecognitionEventLike) => void) | null;
	onerror: ((e: SpeechRecognitionErrorEventLike) => void) | null;
	onend: (() => void) | null;
	onstart: (() => void) | null;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getRecognitionCtor(): SpeechRecognitionCtor | null {
	const w = window as unknown as {
		SpeechRecognition?: SpeechRecognitionCtor;
		webkitSpeechRecognition?: SpeechRecognitionCtor;
	};
	return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function isSpeechRecognitionSupported(): boolean {
	return getRecognitionCtor() !== null;
}

const LOCALE: Record<AgentLanguage, string> = {
	"pt-BR": "pt-BR",
	"en-US": "en-US",
};

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

export interface SpeechCallbacks {
	/** Fired with the stabilized final transcript when a turn ends (silence). */
	onFinal: (text: string) => void;
	/** Fired continuously with the current interim (not yet final) text. */
	onInterim?: (text: string) => void;
	/** Microphone is open and listening. */
	onStart?: () => void;
	/** Microphone fully stopped. */
	onEnd?: () => void;
	/** A recoverable or fatal error occurred. */
	onError?: (error: string) => void;
	/** Real-time input level in 0..1, for the mic animation. */
	onLevel?: (level: number) => void;
}

/**
 * Hands-free voice input.
 *
 * Keeps a single persistent microphone stream (getUserMedia) open while talk
 * mode is on — this avoids the rapid open/close cycling that made the KDE mic
 * indicator flicker. A Web Audio AnalyserNode drives both the level animation
 * and silence-based endpointing (knowing when the user stopped talking). The
 * Web Speech API runs on top for transcription and is only re-armed when the
 * mic stream is still alive, never in a tight loop.
 */
export class SpeechInput {
	private lang: AgentLanguage;
	private callbacks: SpeechCallbacks;
	private deviceId: string | undefined;
	private silenceMs: number;

	// Mic / audio graph.
	private stream: MediaStream | null = null;
	private audioCtx: AudioContext | null = null;
	private analyser: AnalyserNode | null = null;
	private levelRaf: number | null = null;

	// Recognition.
	private recognition: SpeechRecognitionLike | null = null;

	// State.
	private active = false; // talk mode on
	private suspended = false; // paused during TTS
	private running = false; // recognition engine running

	// Turn buffering + endpointing.
	private finalBuffer = "";
	private interimBuffer = "";
	private silenceTimer: number | null = null;
	private speaking = false; // currently above the speech threshold

	constructor(
		lang: AgentLanguage,
		callbacks: SpeechCallbacks,
		opts: { deviceId?: string; silenceMs?: number } = {}
	) {
		this.lang = lang;
		this.callbacks = callbacks;
		this.deviceId = opts.deviceId;
		this.silenceMs = opts.silenceMs ?? 1500;
	}

	setLanguage(lang: AgentLanguage): void {
		this.lang = lang;
		if (this.recognition) this.recognition.lang = LOCALE[lang];
	}

	setDevice(deviceId: string | undefined): void {
		if (this.deviceId === deviceId) return;
		this.deviceId = deviceId;
		// Reopen the stream on the new device if we're currently active.
		if (this.active) {
			void this.restartStream();
		}
	}

	isActive(): boolean {
		return this.active;
	}

	/** Turn talk mode on: open the mic once and keep it open. */
	async start(): Promise<void> {
		if (this.active) return;
		this.active = true;
		this.suspended = false;
		await this.openStream();
		this.startRecognition();
	}

	/** Turn talk mode off: tear everything down (mic indicator goes away). */
	stop(): void {
		this.active = false;
		this.suspended = false;
		this.clearSilenceTimer();
		this.stopRecognition();
		this.closeStream();
		this.finalBuffer = "";
		this.interimBuffer = "";
		this.callbacks.onEnd?.();
	}

	/** Pause recognition during TTS WITHOUT closing the mic stream. */
	suspend(): void {
		if (!this.active || this.suspended) return;
		this.suspended = true;
		this.clearSilenceTimer();
		this.stopRecognition();
		// Keep the stream + analyser open so the device indicator stays stable;
		// just mute the level animation.
		this.callbacks.onLevel?.(0);
	}

	/** Resume recognition after suspend(). */
	resume(): void {
		if (!this.active || !this.suspended) return;
		this.suspended = false;
		this.finalBuffer = "";
		this.interimBuffer = "";
		this.startRecognition();
	}

	// ---- Microphone stream + metering -------------------------------------

	private async openStream(): Promise<void> {
		if (!navigator.mediaDevices?.getUserMedia) {
			this.callbacks.onError?.("getUserMedia not available in this environment.");
			this.active = false;
			return;
		}
		try {
			const constraints: MediaStreamConstraints = {
				audio: this.deviceId
					? { deviceId: { exact: this.deviceId }, echoCancellation: true, noiseSuppression: true }
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

		// Build the analyser graph for level metering + silence detection.
		const Ctx = (window.AudioContext ||
			(window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext);
		this.audioCtx = new Ctx();
		const source = this.audioCtx.createMediaStreamSource(this.stream);
		const analyser = this.audioCtx.createAnalyser();
		analyser.fftSize = 512;
		analyser.smoothingTimeConstant = 0.6;
		source.connect(analyser);
		this.analyser = analyser;
		this.startLevelLoop();
		this.callbacks.onStart?.();
	}

	private async restartStream(): Promise<void> {
		this.stopRecognition();
		this.closeStream();
		await this.openStream();
		if (this.active && !this.suspended) this.startRecognition();
	}

	private closeStream(): void {
		if (this.levelRaf !== null) {
			cancelAnimationFrame(this.levelRaf);
			this.levelRaf = null;
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
		const SPEECH_THRESHOLD = 0.06; // RMS above this counts as speech

		const tick = () => {
			if (!this.analyser) return;
			this.analyser.getByteTimeDomainData(data);
			// Compute RMS of the waveform centered at 128.
			let sum = 0;
			for (let i = 0; i < data.length; i++) {
				const v = (data[i] - 128) / 128;
				sum += v * v;
			}
			const rms = Math.sqrt(sum / data.length);
			const level = Math.min(1, rms * 3); // scale for display

			if (!this.suspended) {
				this.callbacks.onLevel?.(level);
				this.handleVad(rms > SPEECH_THRESHOLD);
			}

			this.levelRaf = requestAnimationFrame(tick);
		};
		this.levelRaf = requestAnimationFrame(tick);
	}

	/** Voice-activity-based endpointing: fire a turn after a pause. */
	private handleVad(isSpeech: boolean): void {
		if (isSpeech) {
			this.speaking = true;
			this.clearSilenceTimer();
		} else if (this.speaking && this.silenceTimer === null) {
			// We were speaking and just went quiet: start the end-of-turn timer.
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

	/** End the current turn: emit the best transcript we have. */
	private flushTurn(): void {
		this.speaking = false;
		const text = (this.finalBuffer || this.interimBuffer).trim();
		this.finalBuffer = "";
		this.interimBuffer = "";
		if (text) this.callbacks.onFinal(text);
	}

	// ---- Speech recognition (transcription) -------------------------------

	private startRecognition(): void {
		if (!this.active || this.suspended || this.running) return;
		const Ctor = getRecognitionCtor();
		if (!Ctor) {
			// No transcription available, but metering/VAD still works.
			this.callbacks.onError?.("Speech recognition not supported; transcription disabled.");
			return;
		}

		const rec = new Ctor();
		rec.lang = LOCALE[this.lang];
		rec.continuous = true;
		rec.interimResults = true;
		rec.maxAlternatives = 1;

		rec.onstart = () => {
			this.running = true;
		};

		rec.onresult = (e: SpeechRecognitionEventLike) => {
			let interim = "";
			for (let i = e.resultIndex; i < e.results.length; i++) {
				const result = e.results[i];
				const transcript = result[0]?.transcript ?? "";
				if (result.isFinal) {
					this.finalBuffer = (this.finalBuffer + " " + transcript).trim();
				} else {
					interim += transcript;
				}
			}
			this.interimBuffer = interim.trim();
			if (this.interimBuffer) this.callbacks.onInterim?.(this.interimBuffer);
		};

		rec.onerror = (e: SpeechRecognitionErrorEventLike) => {
			if (e.error !== "no-speech" && e.error !== "aborted") {
				this.callbacks.onError?.(e.error || "speech recognition error");
			}
			if (e.error === "not-allowed" || e.error === "service-not-allowed") {
				this.active = false;
			}
		};

		rec.onend = () => {
			this.running = false;
			// Only re-arm if the mic stream is still alive and we're actively
			// listening. This avoids the open/close flicker: the mic stream
			// itself never closed, we're just restarting the recognizer on top.
			if (this.active && !this.suspended && this.stream) {
				window.setTimeout(() => this.startRecognition(), 300);
			}
		};

		this.recognition = rec;
		try {
			rec.start();
		} catch {
			this.running = false;
		}
	}

	private stopRecognition(): void {
		this.running = false;
		if (this.recognition) {
			this.recognition.onend = null;
			this.recognition.onresult = null;
			this.recognition.onerror = null;
			try {
				this.recognition.abort();
			} catch {
				/* ignore */
			}
			this.recognition = null;
		}
	}
}
