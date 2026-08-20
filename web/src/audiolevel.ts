// Shared audio analysis so the reactor can react to *real* sound — the mic while
// you're talking, and Jarvis's own voice while it speaks.
//
// One AnalyserNode fed by whatever's live. It is never connected onward, so it's
// a pure "listener": the mic feeds it (no speaker echo), and TTS audio elements
// feed both it and the speakers. Tapping is best-effort — if it fails, audio
// still plays; the reactor just won't dance.

let ctx: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let freq: Uint8Array<ArrayBuffer> | null = null;
const tapped = new WeakSet<HTMLMediaElement>();

function ensure(): { ctx: AudioContext; analyser: AnalyserNode } {
  if (!ctx || !analyser) {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    ctx = new AC();
    analyser = ctx.createAnalyser();
    analyser.fftSize = 128; // 64 frequency bins — plenty for a visualizer
    analyser.smoothingTimeConstant = 0.8;
    freq = new Uint8Array(analyser.frequencyBinCount);
  }
  return { ctx, analyser };
}

export function resumeAudio(): void {
  try {
    void ensure().ctx.resume();
  } catch {
    /* not yet allowed — will resume on the next user gesture */
  }
}

/**
 * Route a playing <audio> element through the analyser AND the speakers.
 * Returns a disposer that detaches the node again — TTS creates one element per
 * spoken sentence, and without this the graph grows a node per sentence for the
 * life of the page. Returns null if tapping wasn't possible.
 */
export function tapElement(el: HTMLMediaElement): (() => void) | null {
  try {
    if (tapped.has(el)) return null;
    const { ctx, analyser } = ensure();
    void ctx.resume();
    const src = ctx.createMediaElementSource(el);
    src.connect(ctx.destination); // keep it audible…
    src.connect(analyser); // …and analyzed
    tapped.add(el);
    return () => {
      try {
        src.disconnect();
      } catch {
        /* already gone */
      }
      tapped.delete(el);
    };
  } catch {
    return null; // element already routed / unsupported — leave playback alone
  }
}

/** Feed a mic stream into the analyser only (never the speakers). */
export function tapStream(stream: MediaStream): MediaStreamAudioSourceNode | null {
  try {
    const { ctx, analyser } = ensure();
    void ctx.resume();
    const src = ctx.createMediaStreamSource(stream);
    src.connect(analyser);
    return src;
  } catch {
    return null;
  }
}

/** `count` normalized bar heights (0..1) across the low-mid spectrum. */
export function sampleBars(count: number): number[] {
  if (!analyser || !freq) return new Array(count).fill(0);
  analyser.getByteFrequencyData(freq);
  const use = Math.min(freq.length, 46); // top bins are usually empty
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    // Mirror-ish mapping so the ring looks balanced rather than lopsided.
    const t = Math.abs((i / (count - 1)) * 2 - 1); // 1 → 0 → 1
    out.push(freq[Math.floor((1 - t) * (use - 1))] / 255);
  }
  return out;
}
