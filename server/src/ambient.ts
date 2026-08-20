// Ambient awareness — the part of Jarvis that notices things without being asked.
//
// This whole loop costs ZERO Claude tokens: it polls Win32 idle state directly
// and reacts with native notifications. The model is only involved if you turn
// on greetings (`JARVIS_AMBIENT_GREET=on`), which spends a turn.
import { getPresence, type Presence } from "./computer";
import { notify } from "./proactive";

const POLL_MS = 60_000;
const BREAK_AFTER_MIN = Number(process.env.JARVIS_BREAK_MINUTES ?? 90);
/** Treat a gap this long as "they actually left", not just a coffee refill. */
const AWAY_MIN_FOR_WELCOME = 10;

let lastState: Presence["state"] | "unknown" = "unknown";
let activeSince: number | null = null;
let awaySince: number | null = null;
let lastNudgeAt = 0;
let timer: NodeJS.Timeout | null = null;
/** Idle seconds seen on the PREVIOUS poll. Once they're back, the current
 *  reading is near zero, so this is what tells us how long the gap really was. */
let lastIdleSeconds = 0;

/** Set by index.ts so we can optionally have Jarvis actually say hello. */
let greeter: ((prompt: string, label: string) => void) | null = null;
export function setGreeter(fn: ((prompt: string, label: string) => void) | null) {
  greeter = fn;
}
/** Clear the greeter only if it's still the one we set (see clearInjector). */
export function clearGreeter(fn: (prompt: string, label: string) => void) {
  if (greeter === fn) greeter = null;
}

async function tick() {
  let p: Presence;
  try {
    p = await getPresence();
  } catch {
    return; // never let ambient polling break anything
  }

  const now = Date.now();

  // Came back after a real absence. `awaySince` is only stamped when a poll
  // NOTICES the absence — already 5 minutes after their last input, plus up to
  // another minute of poll lag — so prefer the gap the OS actually reports.
  if (lastState === "away" && p.state === "active") {
    const noticedMins = awaySince ? (now - awaySince) / 60_000 : 0;
    const awayMins = Math.max(noticedMins, lastIdleSeconds / 60);
    if (awayMins >= AWAY_MIN_FOR_WELCOME) {
      notify("Jarvis", `Welcome back — you were away about ${Math.round(awayMins)} minutes.`);
      if (process.env.JARVIS_AMBIENT_GREET === "on" && greeter) {
        greeter(
          `[The user just returned after ~${Math.round(awayMins)} minutes away. Greet them in one short line and, if anything is scheduled or outstanding, mention it briefly.]`,
          "welcome back",
        );
      }
    }
    activeSince = now;
    awaySince = null;
  }

  if (p.state === "active") {
    if (activeSince === null) activeSince = now;
    const focusedMins = (now - activeSince) / 60_000;
    const sinceNudge = (now - lastNudgeAt) / 60_000;
    if (focusedMins >= BREAK_AFTER_MIN && sinceNudge >= BREAK_AFTER_MIN) {
      notify("Jarvis", `You've been heads-down for ${Math.round(focusedMins)} minutes. Worth standing up?`);
      lastNudgeAt = now;
      activeSince = now; // restart the streak so it doesn't nag repeatedly
    }
  } else if (p.state === "away") {
    if (awaySince === null) awaySince = now;
    activeSince = null;
  }

  lastState = p.state;
  lastIdleSeconds = p.idleSeconds;
}

export function startAmbient() {
  if (process.env.JARVIS_AMBIENT === "off") {
    console.log("[ambient] disabled (JARVIS_AMBIENT=off)");
    return;
  }
  if (timer) return;
  timer = setInterval(() => void tick(), POLL_MS);
  void tick();
  console.log(`[ambient] watching presence (break nudge after ${BREAK_AFTER_MIN}m of focus)`);
}

export function stopAmbient() {
  if (timer) clearInterval(timer);
  timer = null;
}
