// Text-to-speech for Jarvis's replies.
//
// Primary path: a local neural voice (Kokoro) synthesized on the backend and
// streamed back as WAV — natural-sounding, offline, zero tokens. Sentences are
// spoken in order; each one's audio is fetched as soon as it's queued (so the
// next is generating while the current plays). If the backend TTS is
// unavailable, we fall back to the browser's speechSynthesis so speech never
// silently dies.
//
// Speech *input* lives in ./stt.ts (local Whisper).

import { resumeAudio, tapElement } from "./audiolevel";
import { apiFetch } from "./api";

/** Warm the backend model when the user turns spoken replies on, so the first
 *  sentence isn't slow. */
export function warmupTts() {
  resumeAudio(); // this runs from the toggle click (a user gesture), so audio is unlocked
  void apiFetch("/tts/warmup").catch(() => {});
}

export const ttsSupported = true; // backend voice with a browser fallback

// --- speaking-state broadcast (drives the reactor orb) ---
const speakingListeners = new Set<(v: boolean) => void>();
export function onSpeaking(fn: (v: boolean) => void): () => void {
  speakingListeners.add(fn);
  return () => speakingListeners.delete(fn);
}
let lastSpeaking = false;
function notifySpeaking() {
  const s = queue.length > 0 || current !== null;
  if (s !== lastSpeaking) {
    lastSpeaking = s;
    speakingListeners.forEach((f) => f(s));
  }
}

// Strip markdown so the synthesizer doesn't read "asterisk asterisk".
function stripForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " (code block) ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/[*_#>~]/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

type Job = { text: string; ctrl: AbortController; audio: Promise<Blob | null> };

let queue: Job[] = [];
let draining = false;
let current: HTMLAudioElement | null = null;
let currentUrl: string | null = null;

async function fetchTTS(text: string, signal: AbortSignal): Promise<Blob | null> {
  try {
    const res = await apiFetch("/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal,
    });
    if (!res.ok) return null; // fall back to browser speech
    const blob = await res.blob();
    return blob.size > 0 ? blob : null;
  } catch {
    return null; // aborted or network/tts failure
  }
}

export function speak(text: string) {
  const clean = stripForSpeech(text);
  if (!clean) return;
  const ctrl = new AbortController();
  const job: Job = { text: clean, ctrl, audio: fetchTTS(clean, ctrl.signal) }; // prefetch immediately
  queue.push(job);
  notifySpeaking();
  void drain();
}

async function drain() {
  if (draining) return;
  draining = true;
  while (queue.length) {
    const job = queue[0];
    let blob: Blob | null = null;
    try {
      blob = await job.audio;
    } catch {
      blob = null;
    }
    if (!job.ctrl.signal.aborted) {
      if (blob) await playBlob(blob, job.ctrl.signal);
      else await speakFallback(job.text, job.ctrl.signal);
    }
    if (queue[0] === job) queue.shift();
    notifySpeaking();
  }
  draining = false;
  notifySpeaking();
}

function playBlob(blob: Blob, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    // Route through the analyser so the reactor reacts to the voice. The disposer
    // detaches it again on the way out — one element per sentence would otherwise
    // leave a node behind in the audio graph each time.
    const untap = tapElement(audio);
    current = audio;
    currentUrl = url;
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      untap?.();
      if (currentUrl === url) {
        URL.revokeObjectURL(url);
        currentUrl = null;
      }
      if (current === audio) current = null;
      resolve();
    };
    audio.onended = done;
    audio.onerror = done;
    signal.addEventListener(
      "abort",
      () => {
        audio.pause();
        done();
      },
      { once: true },
    );
    notifySpeaking();
    void audio.play().catch(done); // autoplay blocked / decode error → move on
  });
}

/* ---------------- browser-speech fallback ---------------- */

let cachedVoice: SpeechSynthesisVoice | null = null;
let voiceResolved = false;
const VOICE_PREFERENCES = ["Google UK English Male", "Microsoft Guy Online", "Microsoft David", "Daniel", "Arthur"];

function pickVoice(): SpeechSynthesisVoice | null {
  if (voiceResolved) return cachedVoice;
  const voices = window.speechSynthesis?.getVoices() ?? [];
  if (voices.length === 0) return null;
  voiceResolved = true;
  for (const name of VOICE_PREFERENCES) {
    const v = voices.find((x) => x.name === name);
    if (v) return (cachedVoice = v);
  }
  cachedVoice =
    voices.find((v) => v.lang.startsWith("en") && /male|guy|david|daniel|arthur/i.test(v.name)) ??
    voices.find((v) => v.lang.startsWith("en")) ??
    voices[0] ??
    null;
  return cachedVoice;
}

if (typeof window !== "undefined" && window.speechSynthesis) {
  window.speechSynthesis.onvoiceschanged = () => {
    voiceResolved = false;
    pickVoice();
  };
}

function speakFallback(text: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (!window.speechSynthesis || signal.aborted) return resolve();
    const u = new SpeechSynthesisUtterance(text);
    const v = pickVoice();
    if (v) u.voice = v;
    u.rate = 1.02;
    u.pitch = 0.9;
    let settled = false;
    const done = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    u.onend = done;
    u.onerror = done;
    signal.addEventListener(
      "abort",
      () => {
        window.speechSynthesis.cancel();
        done();
      },
      { once: true },
    );
    window.speechSynthesis.speak(u);
  });
}

/** Barge-in: stop everything, cancel pending synthesis, clear the queue. */
export function cancelSpeech() {
  for (const job of queue) job.ctrl.abort();
  queue = [];
  if (current) {
    current.pause();
    current.src = "";
  }
  if (currentUrl) {
    URL.revokeObjectURL(currentUrl);
    currentUrl = null;
  }
  current = null;
  window.speechSynthesis?.cancel();
  notifySpeaking();
}
