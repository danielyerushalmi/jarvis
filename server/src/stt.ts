// Local speech-to-text with Whisper (ONNX via transformers.js).
//
// Runs entirely on this machine: no API key, no tokens, works offline, and —
// unlike the browser's Web Speech API — works in EVERY browser (Firefox/Zen
// included, which is why this exists).
//
// The browser sends 16 kHz mono 16-bit PCM WAV, so there's no ffmpeg/native
// decoding here — just a small RIFF parser.
import { pipeline } from "@huggingface/transformers";

// tiny.en is fast to download and quick on CPU — good for spoken commands.
// Override with JARVIS_WHISPER_MODEL=Xenova/whisper-base.en (or small.en) for
// better accuracy at the cost of speed.
const MODEL = process.env.JARVIS_WHISPER_MODEL ?? "Xenova/whisper-tiny.en";

let transcriberPromise: Promise<unknown> | null = null;

function getTranscriber() {
  if (!transcriberPromise) {
    console.log(`[stt] loading Whisper model "${MODEL}" (first run downloads it — one time)…`);
    transcriberPromise = pipeline("automatic-speech-recognition", MODEL).then((t) => {
      console.log("[stt] Whisper ready");
      return t;
    });
  }
  return transcriberPromise;
}

/** Warm the model at boot so the first utterance isn't slow. */
export function preloadWhisper() {
  void getTranscriber().catch((e) => console.error("[stt] preload failed:", e));
}

/** Minimal RIFF/WAVE parser -> mono Float32 samples. */
export function wavToFloat32(buf: Buffer): { samples: Float32Array; sampleRate: number } {
  if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("not a WAV file");
  }
  let offset = 12;
  let sampleRate = 16000;
  let channels = 1;
  let bits = 16;
  let dataStart = -1;
  let dataLen = 0;

  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt ") {
      channels = buf.readUInt16LE(body + 2);
      sampleRate = buf.readUInt32LE(body + 4);
      bits = buf.readUInt16LE(body + 14);
    } else if (id === "data") {
      dataStart = body;
      dataLen = Math.min(size, buf.length - body);
      break;
    }
    offset = body + size + (size % 2); // chunks are word-aligned
  }
  if (dataStart < 0) throw new Error("no data chunk in WAV");
  if (bits !== 16) throw new Error(`expected 16-bit PCM, got ${bits}-bit`);

  const sampleCount = Math.floor(dataLen / 2 / channels);
  const samples = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    // If stereo somehow arrives, take the first channel.
    const idx = dataStart + i * 2 * channels;
    samples[i] = buf.readInt16LE(idx) / 32768;
  }
  return { samples, sampleRate };
}

/** Transcribe a 16 kHz mono WAV buffer. Returns the recognized text. */
export async function transcribe(wav: Buffer): Promise<string> {
  const { samples, sampleRate } = wavToFloat32(wav);
  if (sampleRate !== 16000) {
    throw new Error(`expected 16 kHz audio, got ${sampleRate} Hz (browser should resample)`);
  }
  if (samples.length < 1600) return ""; // <0.1s — nothing said
  const transcriber = (await getTranscriber()) as (a: Float32Array) => Promise<{ text?: string }>;
  const out = await transcriber(samples);
  return (out?.text ?? "").trim();
}
