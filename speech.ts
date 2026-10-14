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

export interface SpeechCallbacks {
	/** Fired with the stabilized final transcript for an utterance. */
	onFinal: (text: string) => void;
	/** Fired continuously with the current interim (not yet final) text. */
	onInterim?: (text: string) => void;
	/** Recognition actually started listening. */
	onStart?: () => void;
	/** Recognition stopped (either manually or by the engine). */
	onEnd?: () => void;
	/** A recoverable or fatal recognition error occurred. */
	onError?: (error: string) => void;
}

/**
 * Continuous speech recognition wrapper built on the Web Speech API.
 *
 * Designed for hands-free "talk mode": once started it keeps listening,
 * auto-restarting across the engine's internal end events, until stopped.
 * Call `suspend()` while TTS plays to avoid the agent hearing itself, then
 * `resume()` afterwards.
 */
export class SpeechInput {
	private recognition: SpeechRecognitionLike | null = null;
	private lang: AgentLanguage;
	private callbacks: SpeechCallbacks;

	/** User intends to be listening (talk mode on). */
	private active = false;
	/** Temporarily paused (e.g. while Polly speaks). */
	private suspended = false;
	/** Engine is currently running. */
	private running = false;

	constructor(lang: AgentLanguage, callbacks: SpeechCallbacks) {
		this.lang = lang;
		this.callbacks = callbacks;
	}

	setLanguage(lang: AgentLanguage): void {
		this.lang = lang;
		if (this.recognition) {
			this.recognition.lang = LOCALE[lang];
			// Apply the new locale by cycling the engine if currently running.
			if (this.running) {
				this.restart();
			}
		}
	}

	/** Begin hands-free listening. */
	start(): void {
		if (this.active) return;
		this.active = true;
		this.suspended = false;
		this.ensureStarted();
	}

	/** Stop listening entirely (talk mode off). */
	stop(): void {
		this.active = false;
		this.suspended = false;
		this.running = false;
		if (this.recognition) {
			this.recognition.onend = null;
			try {
				this.recognition.abort();
			} catch {
				/* ignore */
			}
			this.recognition = null;
		}
	}

	/** Pause listening without leaving talk mode (used during TTS playback). */
	suspend(): void {
		if (!this.active || this.suspended) return;
		this.suspended = true;
		if (this.recognition && this.running) {
			try {
				this.recognition.stop();
			} catch {
				/* ignore */
			}
		}
	}

	/** Resume after a suspend(). */
	resume(): void {
		if (!this.active || !this.suspended) return;
		this.suspended = false;
		this.ensureStarted();
	}

	isActive(): boolean {
		return this.active;
	}

	private restart(): void {
		if (this.recognition && this.running) {
			try {
				this.recognition.stop();
			} catch {
				/* ignore */
			}
			// onend will re-create via ensureStarted when active && !suspended.
		}
	}

	private ensureStarted(): void {
		if (!this.active || this.suspended || this.running) return;

		const Ctor = getRecognitionCtor();
		if (!Ctor) {
			this.callbacks.onError?.("Speech recognition not supported in this environment.");
			this.active = false;
			return;
		}

		const rec = new Ctor();
		rec.lang = LOCALE[this.lang];
		rec.continuous = true;
		rec.interimResults = true;
		rec.maxAlternatives = 1;

		rec.onstart = () => {
			this.running = true;
			this.callbacks.onStart?.();
		};

		rec.onresult = (e: SpeechRecognitionEventLike) => {
			let interim = "";
			for (let i = e.resultIndex; i < e.results.length; i++) {
				const result = e.results[i];
				const transcript = result[0]?.transcript ?? "";
				if (result.isFinal) {
					const text = transcript.trim();
					if (text) this.callbacks.onFinal(text);
				} else {
					interim += transcript;
				}
			}
			if (interim && this.callbacks.onInterim) {
				this.callbacks.onInterim(interim.trim());
			}
		};

		rec.onerror = (e: SpeechRecognitionErrorEventLike) => {
			// "no-speech" and "aborted" are routine during continuous listening.
			if (e.error !== "no-speech" && e.error !== "aborted") {
				this.callbacks.onError?.(e.error || "speech recognition error");
			}
			if (e.error === "not-allowed" || e.error === "service-not-allowed") {
				// Permission denied: leave talk mode.
				this.active = false;
			}
		};

		rec.onend = () => {
			this.running = false;
			this.callbacks.onEnd?.();
			// Auto-restart to keep listening unless we were told to stop/suspend.
			if (this.active && !this.suspended) {
				// Small delay avoids tight restart loops on some engines.
				window.setTimeout(() => this.ensureStarted(), 150);
			}
		};

		this.recognition = rec;
		try {
			rec.start();
		} catch (err) {
			// start() throws if called while already starting; ignore and let onend recover.
			this.running = false;
			console.error("SpeechInput start failed", err);
		}
	}
}
