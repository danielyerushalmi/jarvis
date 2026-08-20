// Cross-browser speech input: record with MediaRecorder, decode + resample to
// 16 kHz mono WAV in the browser (Web Audio API), then POST to the backend for
// local Whisper transcription.
//
// Why not the Web Speech API? It's Chromium-only — Firefox (and therefore Zen)
// has no SpeechRecognition at all. This path works in every browser, offline,
// and costs no tokens.
import { tapStream as tapMic } from "./audiolevel";
import { apiFetch } from "./api";

export const micSupported =
  typeof navigator !== "undefined" &&
  !!navigator.mediaDevices?.getUserMedia &&
  typeof MediaRecorder !== "undefined";

export function micDiagnosis(): string | null {
  if (typeof navigator === "undefined") return "no browser environment";
  if (typeof window !== "undefined" && !window.isSecureContext) {
    return `Not a secure context (${location.origin}). Open the app at http://localhost:5173.`;
  }
  if (!navigator.mediaDevices?.getUserMedia) return "This browser can't access the microphone.";
  if (typeof MediaRecorder === "undefined") return "This browser has no MediaRecorder.";
  return null;
}

/** Encode mono Float32 samples as a 16-bit PCM WAV blob. */
export function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // format = PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeStr(36, "data");
  view.setUint32(40, samples.length * 2, true);
  let o = 44;
  for (let i = 0; i < samples.length; i++, o += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buffer], { type: "audio/wav" });
}

/** Decode whatever MediaRecorder produced and resample to 16 kHz mono WAV. */
async function toWav16k(blob: Blob): Promise<Blob> {
  const bytes = await blob.arrayBuffer();
  const ctx = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await ctx.decodeAudioData(bytes);
  } finally {
    void ctx.close();
  }
  const frames = Math.max(1, Math.ceil(decoded.duration * 16000));
  const offline = new OfflineAudioContext(1, frames, 16000);
  const src = offline.createBufferSource();
  src.buffer = decoded;
  src.connect(offline.destination);
  src.start();
  const rendered = await offline.startRendering();
  return encodeWav(rendered.getChannelData(0), 16000);
}

/** Push-to-talk recorder: start(), then stop() resolves with the transcript. */
export class MicRecorder {
  private stream: MediaStream | null = null;
  private rec: MediaRecorder | null = null;
  private chunks: Blob[] = [];

  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    tapMic(this.stream); // feed the analyser so the reactor reacts to your voice
    this.chunks = [];
    this.rec = new MediaRecorder(this.stream);
    this.rec.ondataavailable = (e) => {
      if (e.data.size) this.chunks.push(e.data);
    };
    this.rec.start();
  }

  /** Stop recording and return the raw audio as a 16 kHz WAV. */
  async stop(): Promise<Blob | null> {
    const rec = this.rec;
    if (!rec) return null;
    const done = new Promise<void>((resolve) => {
      rec.onstop = () => resolve();
    });
    rec.stop();
    await done;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.rec = null;
    if (!this.chunks.length) return null;
    return toWav16k(new Blob(this.chunks, { type: this.chunks[0].type || "audio/webm" }));
  }
}

/** Send a WAV to the backend for local Whisper transcription. */
export async function transcribe(wav: Blob): Promise<string> {
  const res = await apiFetch("/stt", {
    method: "POST",
    headers: { "Content-Type": "audio/wav" },
    body: wav,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error ?? "transcription failed");
  }
  const { text } = (await res.json()) as { text: string };
  return (text ?? "").trim();
}
