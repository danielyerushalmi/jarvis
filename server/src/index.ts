import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { JarvisSession } from "./agent";
import { preloadWhisper, transcribe } from "./stt";
import { preloadTTS, synthesize } from "./tts";
import { MEMORY_PATH, forgetMemory, listMemories, memoryStats, preloadMemory, pruneSuperseded } from "./memory";
import { cancelJob, clearInjector, initProactive, listJobs, notify, setInjector } from "./proactive";
import { clearGreeter, setGreeter, startAmbient } from "./ambient";
import { initWatchers } from "./watchers";
import { beginAuth, handleAuthCallback, isConnected, spotifyConfigured } from "./spotify";
import { LocalSession, listOllamaModels } from "./local";
import { startHotkey } from "./hotkey";
import { focusWindowByTitle, getSystemStats, type SystemStats } from "./computer";
import { describeExternalMcp } from "./mcp-external";
import { describeSkills, skillPlugins } from "./skills";
import { AUTH_FILE_PATH, authToken, isAuthorized, PUBLIC_ROUTES } from "./auth";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

const PORT = Number(process.env.PORT ?? 8787);
// Loopback only, unless you deliberately say otherwise. Set JARVIS_HOST to
// 0.0.0.0 (or a Tailscale address) to reach Jarvis from your phone — every
// request needs the access token either way. See the warning at startup.
const HOST = process.env.JARVIS_HOST ?? "127.0.0.1";
const isLoopbackHost = HOST === "127.0.0.1" || HOST === "::1" || HOST === "localhost";
// The agent's working directory — where Read/Write/Bash operate, and what bare
// relative paths resolve against. Defaults to wherever the server was started
// from (i.e. `server/`), which means Jarvis's own source is its working
// directory: writes there are held for approval by policy.ts. Point this at a
// dedicated folder to scope it properly — see README, "The agent's workspace".
// Note this is NOT a sandbox: absolute paths reach the whole machine, and the
// approval policy, not the workspace, is what gates that.
const WORKSPACE = process.env.JARVIS_WORKSPACE ?? process.cwd();

// Local fallback brains, discovered at boot and refreshed as connections open,
// so starting Ollama later is picked up without a server restart. Empty if
// Ollama isn't running.
let localModels = await listOllamaModels();
async function refreshLocalModels() {
  try {
    localModels = await listOllamaModels();
  } catch {
    /* keep the last known list */
  }
}

/**
 * Second line of defence behind the token. Browsers always send an Origin, so a
 * drive-by page on this machine is rejected here before the socket opens; a
 * non-browser client sends no Origin and is allowed.
 *
 * A remote browser (your phone over Tailscale) legitimately sends a non-local
 * Origin, so that case is permitted only when the request also carries a valid
 * token — which a drive-by page cannot know. The token is the real
 * authenticator; this check just keeps the local attack surface small.
 */
function originAllowed(origin: string | undefined, authorized: boolean): boolean {
  if (!origin) return true;
  try {
    const { hostname } = new URL(origin);
    if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]") {
      return true;
    }
    return authorized;
  } catch {
    return false;
  }
}

// Global hotkey → raise the Jarvis window and start listening, from anywhere.
let onHotkey: (() => void) | null = null;
startHotkey(() => {
  void focusWindowByTitle("JARVIS").catch(() => {});
  onHotkey?.();
});

/** Heuristic for "Claude is out of usage" so we can fall back automatically. */
function looksLikeUsageLimit(msg: string): boolean {
  return /usage limit|rate.?limit|quota|too many requests|429|credit balance|exceeded your/i.test(msg);
}

const app = Fastify({ bodyLimit: 25 * 1024 * 1024 }); // room for ~30s of 16kHz WAV

// Reject unauthenticated or cross-origin WebSocket upgrades at the handshake,
// before the socket opens. Browsers can't set headers on a WebSocket, so the
// token rides in the query string here.
await app.register(websocket, {
  options: {
    verifyClient: (
      info: { origin?: string; req: { url?: string; headers: Record<string, unknown> } },
      next: (ok: boolean, code?: number, message?: string) => void,
    ) => {
      const query = Object.fromEntries(new URL(info.req.url ?? "/", "http://localhost").searchParams);
      const authorized = isAuthorized(info.req.headers, query);
      if (!authorized) return next(false, 401, "missing or invalid token");
      if (!originAllowed(info.origin, authorized)) return next(false, 403, "origin not allowed");
      next(true);
    },
  },
});

/**
 * Every HTTP route needs the token, except the short PUBLIC_ROUTES list. This
 * runs before any handler, so a new endpoint is protected by default rather than
 * by remembering to protect it.
 */
app.addHook("onRequest", async (req, reply) => {
  const path = req.url.split("?")[0];
  if (PUBLIC_ROUTES.has(path)) return;
  if (isAuthorized(req.headers as Record<string, unknown>, req.query)) return;
  reply.code(401).send({ error: "missing or invalid token — see [auth] in the server startup log" });
});

// Raw audio upload for speech-to-text.
app.addContentTypeParser("audio/wav", { parseAs: "buffer" }, (_req, body, done) => done(null, body));
// Raw binary for dropped-file uploads.
app.addContentTypeParser("application/octet-stream", { parseAs: "buffer" }, (_req, body, done) => done(null, body));

app.get("/health", async () => ({ ok: true, workspace: WORKSPACE }));

// --- Live machine vitals for the UI telemetry footer (zero tokens) ---
// Cached so multiple polls (or tabs) don't each spawn a PowerShell. The TTL sits
// just above the UI's 6s poll interval, so a single tab is served from cache on
// most requests instead of paying for a process spawn every time.
const SYS_CACHE_MS = 6500;
let sysCache: { at: number; data: SystemStats } | null = null;
app.get("/system", async () => {
  if (!sysCache || Date.now() - sysCache.at > SYS_CACHE_MS) {
    try {
      sysCache = { at: Date.now(), data: await getSystemStats() };
    } catch {
      if (!sysCache) return { cpu: 0, memUsedGb: 0, memTotalGb: 0, battery: null };
    }
  }
  return sysCache.data;
});

// --- Spotify connect (one-time PKCE auth in the browser) ---
app.get("/spotify/status", async () => ({ configured: spotifyConfigured(), connected: isConnected() }));
app.get("/spotify/login", async (_req, reply) => {
  try {
    return reply.redirect(beginAuth().url);
  } catch (err) {
    reply.code(400);
    return { error: err instanceof Error ? err.message : String(err) };
  }
});
/**
 * Escape text before it goes into one of the HTML replies below. These pages are
 * served from 127.0.0.1:8787, which is same-origin with the backend's own
 * endpoints — so reflecting an unescaped query parameter here would hand a
 * crafted link script access to /memory, /jobs and /upload.
 */
const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

app.get("/spotify/callback", async (req, reply) => {
  const { code, state, error } = req.query as { code?: string; state?: string; error?: string };
  if (error) {
    return reply.type("text/html").send(`<p>Spotify authorization was denied (${escapeHtml(error)}).</p>`);
  }
  if (!code) return reply.code(400).type("text/html").send("<p>Missing authorization code.</p>");
  try {
    await handleAuthCallback(code, state);
    return reply.type("text/html").send("<p>Spotify connected. You can close this tab and return to Jarvis.</p>");
  } catch (err) {
    reply.code(400);
    const message = escapeHtml(err instanceof Error ? err.message : String(err));
    return reply.type("text/html").send(`<p>Couldn't connect Spotify: ${message}</p>`);
  }
});

// --- Memory management (for the Memory tab) ---
app.get("/memory", async () => ({ memories: await listMemories(), stats: await memoryStats() }));
// Registered before /memory/:id so the static path wins the match.
app.delete("/memory/superseded", async () => ({ removed: await pruneSuperseded() }));
app.delete("/memory/:id", async (req) => {
  const { id } = req.params as { id: string };
  return { ok: await forgetMemory(id) };
});

// --- Scheduled jobs (for the Schedule tab) ---
app.get("/jobs", async () => ({ jobs: listJobs() }));
app.delete("/jobs/:id", async (req) => {
  const { id } = req.params as { id: string };
  return { ok: await cancelJob(id) };
});

// --- Dropped-file upload: lands in the agent's workspace so Jarvis can read it ---
app.post("/upload", async (req, reply) => {
  const name = basename(String((req.query as { name?: string }).name ?? "file"));
  const dir = join(WORKSPACE, "dropped");
  await mkdir(dir, { recursive: true });
  const dest = join(dir, name);
  await writeFile(dest, req.body as Buffer);
  return { path: dest };
});

// --- Text-to-speech: local neural voice (Kokoro), returns a WAV the UI plays ---
app.get("/tts/warmup", async () => {
  preloadTTS(); // fire-and-forget; called when the user turns spoken replies on
  return { ok: true };
});
app.post("/tts", async (req, reply) => {
  const { text, voice } = (req.body ?? {}) as { text?: string; voice?: string };
  if (!text || !text.trim()) {
    reply.code(400);
    return { error: "no text" };
  }
  try {
    const wav = await synthesize(text, voice);
    reply.type("audio/wav");
    return reply.send(wav);
  } catch (err) {
    reply.code(500);
    return { error: err instanceof Error ? err.message : String(err) };
  }
});

app.post("/stt", async (req, reply) => {
  try {
    const text = await transcribe(req.body as Buffer);
    return { text };
  } catch (err) {
    reply.code(400);
    return { error: err instanceof Error ? err.message : String(err) };
  }
});

app.get("/ws", { websocket: true }, (socket, req) => {
  // Cross-origin upgrades are already rejected by verifyClient above.
  const query = req.query as { resume?: string };
  const resume = typeof query?.resume === "string" && query.resume ? query.resume : undefined;
  const send = (event: unknown) => {
    const e = event as { type?: string; error?: string };
    if (e?.type === "error" && typeof e.error === "string" && looksLikeUsageLimit(e.error)) {
      void autoFallback();
    }
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(event));
  };

  /** Claude ran out — drop to a local brain rather than leaving the user stuck. */
  async function autoFallback() {
    if (!localModels.length) await refreshLocalModels(); // Ollama may have started since boot
    if (!localModels.length || brain instanceof LocalSession) return;
    const target = localModels[0].value;
    console.log(`[brain] Claude usage limit hit — falling back to ${target}`);
    notify("Jarvis", "Claude usage limit reached — switched to the local model.");
    await chooseModel(target);
  }

  // Refresh the local-model list in the background so a newly-started Ollama is
  // offered on the next connection — non-blocking, so it doesn't delay this one.
  void refreshLocalModels();

  // The active "brain": Claude via the Agent SDK, or a local Ollama model.
  let brain: JarvisSession | LocalSession = new JarvisSession(send, {
    cwd: WORKSPACE,
    resume,
    extraModels: localModels,
  });

  // Scheduled jobs fire into whichever brain is currently connected. These
  // closures read `brain` live, so they survive a model swap. They're stable
  // references so `close` can tear down ONLY this connection's wiring — a second
  // tab won't have its injector cleared when the first one closes.
  const inject = (text: string, label: string) => brain.injectTurn(text, label);
  const hotkeyFn = () => send({ type: "hotkey" });
  setInjector(inject);
  setGreeter(inject);
  onHotkey = hotkeyFn;

  /** Swap brains when the chosen model crosses the Claude/local boundary. */
  async function chooseModel(model: string) {
    const wantLocal = model.startsWith("ollama:");
    const isLocal = brain instanceof LocalSession;
    if (wantLocal === isLocal) {
      await brain.setModel(model);
      return;
    }
    brain.close();
    brain = wantLocal
      ? new LocalSession(send, model)
      : new JarvisSession(send, { cwd: WORKSPACE, extraModels: localModels });
    // No re-wiring needed: `inject`/`hotkeyFn` read the live `brain` binding.
    if (!wantLocal) await brain.setModel(model);
    // Switching brains starts a fresh conversation — say so rather than
    // letting the history silently vanish.
    send({
      type: "error",
      error: wantLocal
        ? "Switched to the local model — this starts a fresh conversation. Tools and vision work only if the chosen model supports them; computer control stays Claude-only."
        : "Switched back to Claude — starting a fresh conversation.",
    });
    // The brain we just closed may have been mid-turn (this is how the usage-limit
    // fallback fires). That turn will never report a result, so release the UI
    // explicitly instead of leaving it stuck on "thinking".
    send({ type: "turn_end" });
  }

  socket.on("message", (raw: Buffer) => {
    let msg: any;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type === "user_message" && typeof msg.text === "string") {
      const images = Array.isArray(msg.images)
        ? msg.images.filter((i: any) => typeof i?.data === "string" && typeof i?.mediaType === "string")
        : [];
      void brain.sendUserMessage(msg.text, images);
    } else if (msg.type === "permission_response" && typeof msg.id === "string") {
      brain.resolvePermission(msg.id, Boolean(msg.approved), msg.message);
    } else if (msg.type === "set_model" && typeof msg.model === "string") {
      void chooseModel(msg.model);
    } else if (msg.type === "interrupt") {
      void brain.interrupt();
    }
  });

  socket.on("close", () => {
    // Clear only THIS connection's wiring — a still-open tab keeps its own.
    clearInjector(inject);
    clearGreeter(inject);
    if (onHotkey === hotkeyFn) onHotkey = null;
    brain.close();
  });
});

console.log(`[mcp] ${describeExternalMcp()}`); // read once at boot; restart to pick up edits
skillPlugins(); // populates the summary below
console.log(`[skills] ${describeSkills()}`);
preloadWhisper(); // warm the model so the first utterance isn't slow
preloadMemory(); // warm embeddings + load the memory index
await initProactive(); // re-arm reminders that survived a restart
await initWatchers(); // re-arm folder watches that survived a restart
startAmbient(); // presence watching: break nudges + welcome-back (zero tokens)
await app.listen({ port: PORT, host: HOST });
console.log(`Memory: ${MEMORY_PATH}`);
console.log(`Jarvis backend on http://${HOST}:${PORT}  (workspace: ${WORKSPACE})`);

// The token, where to find it, and a ready-made URL. In normal local use you
// never need this — the Vite proxy attaches the token for you — so it's printed
// for the cases that DO need it: a phone, another machine, or curl.
console.log(`[auth] token file: ${AUTH_FILE_PATH}`);
console.log(`[auth] direct URL: http://${isLoopbackHost ? "127.0.0.1" : HOST}:${PORT}/health?token=${authToken()}`);
if (!isLoopbackHost) {
  console.warn(
    `\n[auth] ⚠  LISTENING ON ${HOST} — this machine's Jarvis is reachable off-box.\n` +
      `        Anything with the token can move your mouse, type, and run shell commands.\n` +
      `        Put it behind Tailscale or a VPN; do NOT port-forward this to the internet.\n` +
      `        Rotate by deleting ${AUTH_FILE_PATH} (or setting JARVIS_TOKEN) and restarting.\n`,
  );
}
