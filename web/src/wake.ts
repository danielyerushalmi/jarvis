// Wake word "Jarvis" — no account, no cloud, no extra models.
//
// A tiny built-in energy VAD (Web Audio) notices when you speak; each utterance
// is transcribed by the same local Whisper we already use, and if it opens with
// "Jarvis" the rest is treated as a command. Everything runs locally and works
// in any browser (Zen/Firefox included).
//
// We deliberately avoid a neural VAD (Silero/ONNX) here: it dragged in a 26 MB
// onnxruntime-web wasm bundle whose dynamic import fights the Vite dev server.
// An RMS gate is cruder, but false triggers just cost a wasted local transcription
// that won't match "Jarvis" — no spurious commands — so it's the right trade.
import { encodeWav, transcribe } from "./stt";
import { tapStream } from "./audiolevel";

export const wakeSupported =
  typeof navigator !== "undefined" &&
  !!navigator.mediaDevices?.getUserMedia &&
  (typeof AudioContext !== "undefined" || typeof (globalThis as { webkitAudioContext?: unknown }).webkitAudioContext !== "undefined");

export type WakeHandlers = {
  onWake: () => void; // "Jarvis" recognized — command incoming (UI feedback)
  onCommand: (text: string) => void; // the command to run
  onError: (message: string) => void; // mic denied / audio init failure
};

// VAD tuning (RMS on normalized samples).
const SPEECH_RMS = 0.018; // above this, a frame counts as speech
const SILENCE_MS = 800; // end the utterance after this much trailing quiet
const MIN_SPEECH_MS = 250; // ignore blips (clicks, coughs)
const MAX_MS = 9000; // hard cap on one utterance
const PREROLL_FRAMES = 3; // keep a little audio before speech starts, so it isn't clipped
// After a bare "Jarvis", the NEXT utterance is taken as the command for this long.
const ARMED_MS = 8000;

function rmsOf(frame: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
  return Math.sqrt(sum / frame.length);
}

/** Levenshtein distance — only used on single short tokens. */
function editDistance(a: string, b: string): number {
  const dp: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
  return dp[a.length][b.length];
}

/** Does this utterance open with the wake word? Returns the trailing command. */
function matchWake(text: string): { matched: boolean; rest: string } {
  let norm = text
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(hey|ok|okay|hi)\s+/, ""); // optional "hey Jarvis"
  const tokens = norm.split(" ").filter(Boolean);
  if (!tokens.length) return { matched: false, rest: "" };
  let first = tokens[0].replace(/'s$/, "");
  let consumed = 1;
  if (first === "jarv" && tokens[1] === "is") {
    first = "jarvis"; // Whisper sometimes splits it as "jarv is"
    consumed = 2;
  }
  // Tight enough to skip "Travis"/"service" (distance 2), loose enough for "Jervis".
  const isWake = first.startsWith("jarvi") || editDistance(first, "jarvis") <= 1;
  if (!isWake) return { matched: false, rest: "" };
  return { matched: true, rest: tokens.slice(consumed).join(" ") };
}

export class WakeListener {
  private handlers: WakeHandlers;
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private node: ScriptProcessorNode | null = null;
  private isRunning = false;
  private busy = false; // don't overlap transcriptions
  private armed = false;
  private armedAt = 0;

  // VAD state
  private rate = 48000;
  private speaking = false;
  private speechMs = 0;
  private silenceMs = 0;
  private seg: Float32Array[] = [];
  private preroll: Float32Array[] = [];

  constructor(handlers: WakeHandlers) {
    this.handlers = handlers;
  }

  get running(): boolean {
    return this.isRunning;
  }

  async start(): Promise<void> {
    if (this.isRunning) return;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      tapStream(this.stream); // reactor reacts to your voice while it's capturing a command
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new Ctx();
      this.rate = this.ctx.sampleRate;
      this.source = this.ctx.createMediaStreamSource(this.stream);
      this.node = this.ctx.createScriptProcessor(4096, 1, 1);
      this.node.onaudioprocess = (e) => {
        // Output silence (don't echo the mic), then process the input frame.
        e.outputBuffer.getChannelData(0).fill(0);
        this.onFrame(e.inputBuffer.getChannelData(0));
      };
      this.source.connect(this.node);
      this.node.connect(this.ctx.destination); // required for onaudioprocess to fire
      this.isRunning = true;
    } catch (err) {
      await this.cleanup();
      this.handlers.onError(err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  async stop(): Promise<void> {
    await this.cleanup();
    this.isRunning = false;
    this.armed = false;
    this.speaking = false;
    this.seg = [];
    this.preroll = [];
  }

  private async cleanup(): Promise<void> {
    try {
      if (this.node) this.node.onaudioprocess = null;
      this.node?.disconnect();
      this.source?.disconnect();
      this.stream?.getTracks().forEach((t) => t.stop());
      await this.ctx?.close();
    } catch {
      /* best-effort */
    }
    this.node = null;
    this.source = null;
    this.stream = null;
    this.ctx = null;
  }

  private onFrame(frame: Float32Array): void {
    const rms = rmsOf(frame);
    const frameMs = (frame.length / this.rate) * 1000;

    if (rms > SPEECH_RMS) {
      if (!this.speaking) {
        this.speaking = true;
        this.seg = [...this.preroll]; // include the pre-speech tail so the start isn't clipped
        this.speechMs = 0;
        this.silenceMs = 0;
      }
      this.seg.push(new Float32Array(frame));
      this.speechMs += frameMs;
      this.silenceMs = 0;
    } else if (this.speaking) {
      this.seg.push(new Float32Array(frame)); // keep trailing quiet so words aren't cut
      this.silenceMs += frameMs;
      if (this.silenceMs >= SILENCE_MS) {
        this.endSegment();
        return;
      }
    } else {
      this.preroll.push(new Float32Array(frame));
      if (this.preroll.length > PREROLL_FRAMES) this.preroll.shift();
    }

    if (this.speaking && this.speechMs + this.silenceMs >= MAX_MS) this.endSegment();
  }

  private endSegment(): void {
    const seg = this.seg;
    const speechMs = this.speechMs;
    this.speaking = false;
    this.seg = [];
    this.speechMs = 0;
    this.silenceMs = 0;
    if (speechMs < MIN_SPEECH_MS) return;
    void this.handleSegment(seg);
  }

  private async handleSegment(frames: Float32Array[]): Promise<void> {
    if (this.busy) return; // drop overlapping utterances rather than pile up stale audio
    this.busy = true;
    try {
      const wav = await this.toWav16k(frames);
      const text = (await transcribe(wav)).trim();
      if (!text) return;
      const wake = matchWake(text);
      if (wake.matched) {
        this.handlers.onWake();
        if (wake.rest) {
          this.armed = false;
          this.handlers.onCommand(wake.rest);
        } else {
          this.armed = true; // just "Jarvis" — the next utterance is the command
          this.armedAt = Date.now();
        }
      } else if (this.armed && Date.now() - this.armedAt < ARMED_MS) {
        this.armed = false;
        this.handlers.onCommand(text);
      }
      // otherwise ambient speech — ignore.
    } catch {
      /* transcription hiccup — never let it kill the listener */
    } finally {
      this.busy = false;
    }
  }

  /** Merge captured frames and resample from the mic rate down to 16 kHz mono WAV. */
  private async toWav16k(frames: Float32Array[]): Promise<Blob> {
    let total = 0;
    for (const f of frames) total += f.length;
    const merged = new Float32Array(total);
    let o = 0;
    for (const f of frames) {
      merged.set(f, o);
      o += f.length;
    }
    if (this.rate === 16000) return encodeWav(merged, 16000);
    const offline = new OfflineAudioContext(1, Math.max(1, Math.ceil((total * 16000) / this.rate)), 16000);
    const buf = offline.createBuffer(1, total, this.rate);
    buf.copyToChannel(merged, 0);
    const src = offline.createBufferSource();
    src.buffer = buf;
    src.connect(offline.destination);
    src.start();
    const rendered = await offline.startRendering();
    return encodeWav(rendered.getChannelData(0), 16000);
  }
}
