// Local neural text-to-speech via Kokoro (ONNX through kokoro-js).
//
// Runs entirely on this machine — no API key, no tokens, offline after the
// one-time model download (~80 MB, q8). Produces a 24 kHz WAV the browser plays.
// Default voice is a British male ("bm_george"); override with JARVIS_TTS_VOICE.
import { KokoroTTS } from "kokoro-js";

const MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";
const DEFAULT_VOICE = process.env.JARVIS_TTS_VOICE ?? "bm_george";

let ttsPromise: Promise<KokoroTTS> | null = null;

function getTTS(): Promise<KokoroTTS> {
  if (!ttsPromise) {
    console.log("[tts] loading Kokoro model (first run downloads it once)…");
    ttsPromise = KokoroTTS.from_pretrained(MODEL, { dtype: "q8", device: "cpu" }).then((t) => {
      console.log("[tts] Kokoro ready");
      return t;
    });
  }
  return ttsPromise;
}

/** Warm the model so the first spoken sentence isn't slow. Safe to call repeatedly. */
export function preloadTTS() {
  void getTTS().catch((e) => console.error("[tts] preload failed:", e));
}

/** Synthesize text to a 16-bit PCM WAV buffer. Throws if the model can't load. */
export async function synthesize(text: string, voice?: string): Promise<Buffer> {
  const tts = await getTTS();
  const chosen = voice && voice in tts.voices ? voice : DEFAULT_VOICE;
  const audio = await tts.generate(text, { voice: chosen as keyof typeof tts.voices });
  return Buffer.from(audio.toWav());
}
