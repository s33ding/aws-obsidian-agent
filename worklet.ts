/**
 * Source for the AudioWorklet processor, loaded at runtime via a Blob URL
 * (Obsidian/Electron can't serve a separate .js worklet file). This runs on
 * the dedicated audio rendering thread — off the main thread.
 *
 * To keep the main thread fast, the worklet does the heavy lifting itself:
 *   - computes RMS loudness (for meter + barge-in),
 *   - downsamples the mic audio to 16 kHz,
 *   - batches ~100 ms of 16 kHz samples before posting,
 * so the main thread receives ~10 messages/second instead of ~370, already
 * in the sample rate Transcribe wants.
 *
 * Messages posted to the main thread:
 *   { type: "audio", samples: Float32Array }  — batched 16 kHz mono audio
 *   { type: "level", rms: number }            — loudness for meter/barge-in
 */
export const TARGET_RATE = 16000;

export const WORKLET_SOURCE = `
const TARGET_RATE = ${TARGET_RATE};
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._ratio = sampleRate / TARGET_RATE;      // e.g. 48000/16000 = 3
    this._acc = [];                               // downsampled samples buffer
    this._phase = 0;                              // fractional read position within the stream
    this._batch = Math.round(TARGET_RATE * 0.1);  // ~100 ms per message
    this._levelFrame = 0;
  }
  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const ch = input[0];
    if (!ch || ch.length === 0) return true;

    // RMS loudness on the raw frame (cheap, needed for barge-in while playing).
    let sum = 0;
    for (let i = 0; i < ch.length; i++) sum += ch[i] * ch[i];
    const rms = Math.sqrt(sum / ch.length);
    if ((this._levelFrame++ % 8) === 0) {
      this.port.postMessage({ type: "level", rms });
    }

    // Downsample to 16 kHz by sampling at integer positions, carrying the
    // fractional phase across frames so there's no drift or gaps.
    while (this._phase < ch.length) {
      this._acc.push(ch[Math.floor(this._phase)]);
      this._phase += this._ratio;
    }
    this._phase -= ch.length; // carry remainder into the next frame

    // Flush in ~100 ms batches to keep main-thread messaging light.
    if (this._acc.length >= this._batch) {
      const out = new Float32Array(this._acc.length);
      out.set(this._acc);
      this._acc.length = 0;
      this.port.postMessage({ type: "audio", samples: out }, [out.buffer]);
    }
    return true;
  }
}
registerProcessor("capture-processor", CaptureProcessor);
`;

/** Create a Blob URL for the worklet module so AudioContext can load it. */
export function workletModuleUrl(): string {
	const blob = new Blob([WORKLET_SOURCE], { type: "application/javascript" });
	return URL.createObjectURL(blob);
}
