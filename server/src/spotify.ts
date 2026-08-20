// Spotify playback control, exposed to Jarvis as an in-process MCP server.
//
// Auth is PKCE (client ID only, no client secret) so there's nothing sensitive
// to keep server-side besides the user's own tokens. Uses the built-in global
// `fetch` — no SDK dependency.
//
// Wired up in index.ts (the /spotify/* routes) and agent.ts (mcpServers).
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const CONFIG_FILE = process.env.JARVIS_SPOTIFY_CONFIG_FILE ?? join(homedir(), ".jarvis", "spotify.json");
const TOKENS_FILE = process.env.JARVIS_SPOTIFY_TOKENS_FILE ?? join(homedir(), ".jarvis", "spotify-tokens.json");
const REDIRECT_URI = "http://127.0.0.1:8787/spotify/callback";
const SCOPES = "user-read-playback-state user-modify-playback-state user-read-currently-playing";

type SpotifyTokens = { accessToken: string; refreshToken: string; expiresAt: number };

/** Stashed between beginAuth() and handleAuthCallback(). Single-user app, so one
 *  in-flight auth attempt at a time is fine. `state` ties the callback back to
 *  the request we actually started, so a drive-by hit on /spotify/callback with
 *  someone else's code can't be mistaken for ours. */
let pendingAuth: { verifier: string; state: string } | null = null;

function getClientId(): string | undefined {
  if (process.env.JARVIS_SPOTIFY_CLIENT_ID) return process.env.JARVIS_SPOTIFY_CLIENT_ID;
  if (!existsSync(CONFIG_FILE)) return undefined;
  try {
    const cfg = JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as { clientId?: string };
    return cfg.clientId;
  } catch {
    return undefined;
  }
}

export function spotifyConfigured(): boolean {
  return !!getClientId();
}

function loadTokensSync(): SpotifyTokens | null {
  if (!existsSync(TOKENS_FILE)) return null;
  try {
    return JSON.parse(readFileSync(TOKENS_FILE, "utf8")) as SpotifyTokens;
  } catch {
    return null;
  }
}

export function isConnected(): boolean {
  return !!loadTokensSync()?.refreshToken;
}

async function loadTokens(): Promise<SpotifyTokens | null> {
  if (!existsSync(TOKENS_FILE)) return null;
  try {
    return JSON.parse(await readFile(TOKENS_FILE, "utf8")) as SpotifyTokens;
  } catch {
    return null;
  }
}

async function saveTokens(tokens: SpotifyTokens): Promise<void> {
  mkdirSync(dirname(TOKENS_FILE), { recursive: true });
  await writeFile(TOKENS_FILE, JSON.stringify(tokens, null, 2), "utf8");
}

/* -------------------------------- PKCE auth ------------------------------ */

export function beginAuth(): { url: string } {
  const clientId = getClientId();
  if (!clientId) {
    throw new Error("Spotify client ID not configured — set JARVIS_SPOTIFY_CLIENT_ID or ~/.jarvis/spotify.json.");
  }

  // 48 random bytes -> 64 base64url chars with no padding.
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(16).toString("base64url");
  pendingAuth = { verifier, state };

  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    code_challenge_method: "S256",
    code_challenge: challenge,
    state,
  });
  return { url: `https://accounts.spotify.com/authorize?${params.toString()}` };
}

/** Constant-time compare that tolerates length differences. */
function sameState(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export async function handleAuthCallback(code: string, state?: string): Promise<void> {
  const clientId = getClientId();
  if (!clientId) {
    throw new Error("Spotify client ID not configured — set JARVIS_SPOTIFY_CLIENT_ID or ~/.jarvis/spotify.json.");
  }
  if (!pendingAuth) {
    throw new Error("No Spotify auth flow in progress — start the connect flow from Settings first.");
  }
  const { verifier, state: expected } = pendingAuth;
  // Consumed either way: a mismatched callback must not leave the flow open for
  // a second attempt to guess at.
  pendingAuth = null;
  if (!state || !sameState(state, expected)) {
    throw new Error("Spotify auth state didn't match — start the connect flow again from Settings.");
  }

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
    client_id: clientId,
    code_verifier: verifier,
  });

  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Spotify token exchange failed (${res.status}): ${text}`);
  }
  const data = (await res.json()) as { access_token: string; refresh_token: string; expires_in: number };
  await saveTokens({
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  });
}

async function refreshAccessToken(tokens: SpotifyTokens): Promise<SpotifyTokens> {
  const clientId = getClientId();
  if (!clientId) {
    throw new Error("Spotify client ID not configured — set JARVIS_SPOTIFY_CLIENT_ID or ~/.jarvis/spotify.json.");
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: tokens.refreshToken,
    client_id: clientId,
  });
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Spotify token refresh failed (${res.status}): ${text}`);
  }
  // Spotify doesn't always rotate the refresh token — keep the old one if absent.
  const data = (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number };
  const next: SpotifyTokens = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? tokens.refreshToken,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  await saveTokens(next);
  return next;
}

/** In-flight refresh, shared by concurrent callers. Two parallel tool calls past
 *  expiry used to each POST a refresh, and Spotify may rotate the refresh token —
 *  invalidating whichever reply landed second. */
let refreshInFlight: Promise<SpotifyTokens> | null = null;

async function getAccessToken(): Promise<string> {
  const tokens = await loadTokens();
  if (!tokens?.refreshToken) {
    throw new Error("Spotify not connected — ask the user to connect it in Settings.");
  }
  if (Date.now() <= tokens.expiresAt - 60_000) return tokens.accessToken;

  refreshInFlight ??= refreshAccessToken(tokens).finally(() => {
    refreshInFlight = null;
  });
  return (await refreshInFlight).accessToken;
}

/* --------------------------------- API ----------------------------------- */

/**
 * Call the Spotify Web API. Handles 204 (no content) and throws a readable
 * Error carrying Spotify's own message on failure — including a friendly
 * nudge when there's no active device, the most common failure mode.
 */
async function api(path: string, init: { method?: string; body?: string } = {}): Promise<unknown> {
  const token = await getAccessToken();
  const res = await fetch(`https://api.spotify.com/v1${path}`, {
    method: init.method,
    body: init.body,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });

  if (res.status === 204) return null;

  if (!res.ok) {
    const raw = await res.text().catch(() => "");
    let message = raw;
    try {
      const parsed = JSON.parse(raw) as { error?: { message?: string; reason?: string } };
      message = parsed.error?.message ?? raw;
    } catch {
      /* not JSON — use the raw text */
    }
    if (res.status === 404 || (res.status === 403 && /device/i.test(message))) {
      throw new Error(
        `No active Spotify device (${message || "NO_ACTIVE_DEVICE"}). Ask the user to open Spotify on a device — phone, desktop app, or web player — and start playback there once, then try again.`,
      );
    }
    if (res.status === 403) {
      throw new Error(`Spotify Premium is required for playback control (${message || "FORBIDDEN"}).`);
    }
    throw new Error(`Spotify API error (${res.status}): ${message || res.statusText}`);
  }

  const text = await res.text();
  if (!text) return null;
  return JSON.parse(text);
}

/* ------------------------------ MCP tools -------------------------------- */

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
const fail = (e: unknown) => ({
  content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }],
  isError: true,
});

type SpotifyArtist = { name: string };
type SpotifyTrack = { name: string; uri: string; artists: SpotifyArtist[] };
type SpotifyAlbum = { name: string; uri: string; artists: SpotifyArtist[] };
type SpotifyPlaylist = { name: string; uri: string; owner?: { display_name?: string } };
type SpotifyArtistItem = { name: string; uri: string };

/* --- Shared playback logic (used by the MCP tools AND the local-model loop) --- */

export async function spotifySearchAndPlay(query: string, type: "track" | "album" | "playlist" | "artist" = "track"): Promise<string> {
  const data = (await api(`/search?q=${encodeURIComponent(query)}&type=${type}&limit=1`)) as Record<
    string,
    { items: unknown[] } | undefined
  >;
  const item = data[`${type}s`]?.items?.[0];
  if (!item) return `No ${type} found for "${query}".`;
  if (type === "track") {
    const track = item as SpotifyTrack;
    await api("/me/player/play", { method: "PUT", body: JSON.stringify({ uris: [track.uri] }) });
    return `Playing: ${track.name} — ${track.artists.map((a) => a.name).join(", ")}`;
  }
  const context = item as SpotifyAlbum | SpotifyPlaylist | SpotifyArtistItem;
  await api("/me/player/play", { method: "PUT", body: JSON.stringify({ context_uri: context.uri }) });
  const label =
    type === "album"
      ? `${context.name} — ${(context as SpotifyAlbum).artists.map((a) => a.name).join(", ")}`
      : type === "playlist"
        ? `${context.name}${(context as SpotifyPlaylist).owner?.display_name ? ` by ${(context as SpotifyPlaylist).owner!.display_name}` : ""}`
        : context.name;
  return `Playing ${type}: ${label}`;
}

export async function spotifyTransport(action: "play" | "pause" | "next" | "previous"): Promise<string> {
  switch (action) {
    case "play":
      await api("/me/player/play", { method: "PUT" });
      return "Resumed playback.";
    case "pause":
      await api("/me/player/pause", { method: "PUT" });
      return "Paused playback.";
    case "next":
      await api("/me/player/next", { method: "POST" });
      return "Skipped to the next track.";
    case "previous":
      await api("/me/player/previous", { method: "POST" });
      return "Skipped to the previous track.";
  }
}

export async function spotifyNowPlaying(): Promise<string> {
  const data = (await api("/me/player/currently-playing")) as { item?: SpotifyTrack | null; is_playing?: boolean } | null;
  const item = data?.item;
  if (!item) return "Nothing playing.";
  return `${item.name} — ${item.artists.map((a) => a.name).join(", ")} (${data?.is_playing ? "playing" : "paused"})`;
}

const searchAndPlay = tool(
  "spotify_search_and_play",
  "Search Spotify and immediately start playing the first match — a track, album, playlist, or artist. Requires Spotify Premium and an active device; if it fails because nothing is playing anywhere, ask the user to open Spotify on a device first.",
  {
    query: z.string().describe("What to search for, e.g. 'Hotel California Eagles'"),
    type: z
      .enum(["track", "album", "playlist", "artist"])
      .optional()
      .describe("What kind of result to play (default track)"),
  },
  async ({ query, type }) => {
    try {
      return ok(await spotifySearchAndPlay(query, type ?? "track"));
    } catch (e) {
      return fail(e);
    }
  },
);

const play = tool("spotify_play", "Resume Spotify playback on the active device.", {}, async () => {
  try {
    return ok(await spotifyTransport("play"));
  } catch (e) {
    return fail(e);
  }
});

const pause = tool("spotify_pause", "Pause Spotify playback on the active device.", {}, async () => {
  try {
    return ok(await spotifyTransport("pause"));
  } catch (e) {
    return fail(e);
  }
});

const next = tool("spotify_next", "Skip to the next track.", {}, async () => {
  try {
    return ok(await spotifyTransport("next"));
  } catch (e) {
    return fail(e);
  }
});

const previous = tool("spotify_previous", "Skip to the previous track.", {}, async () => {
  try {
    return ok(await spotifyTransport("previous"));
  } catch (e) {
    return fail(e);
  }
});

const setVolume = tool(
  "spotify_set_volume",
  "Set Spotify playback volume on the active device.",
  { percent: z.number().min(0).max(100).describe("Volume percent, 0-100") },
  async ({ percent }) => {
    try {
      const pct = Math.round(percent);
      await api(`/me/player/volume?volume_percent=${pct}`, { method: "PUT" });
      return ok(`Volume set to ${pct}%.`);
    } catch (e) {
      return fail(e);
    }
  },
);

const nowPlaying = tool(
  "spotify_now_playing",
  "Get what's currently playing on Spotify, if anything.",
  {},
  async () => {
    try {
      return ok(await spotifyNowPlaying());
    } catch (e) {
      return fail(e);
    }
  },
);

const devices = tool(
  "spotify_devices",
  "List available Spotify devices and which one is active.",
  {},
  async () => {
    try {
      const data = (await api("/me/player/devices")) as {
        devices: { name: string; type: string; is_active: boolean }[];
      } | null;
      const list = data?.devices ?? [];
      if (!list.length) return ok("No Spotify devices found. Ask the user to open Spotify somewhere.");
      return ok(list.map((d) => `${d.is_active ? "* " : "  "}${d.name} (${d.type})`).join("\n"));
    } catch (e) {
      return fail(e);
    }
  },
);

const queue = tool(
  "spotify_queue",
  "Search for a track and add it to the end of the playback queue, without interrupting what's currently playing.",
  { query: z.string().describe("Track to search for, e.g. 'Bohemian Rhapsody Queen'") },
  async ({ query }) => {
    try {
      const data = (await api(`/search?q=${encodeURIComponent(query)}&type=track&limit=1`)) as {
        tracks?: { items: SpotifyTrack[] };
      };
      const track = data.tracks?.items?.[0];
      if (!track) return ok(`No track found for "${query}".`);
      await api(`/me/player/queue?uri=${encodeURIComponent(track.uri)}`, { method: "POST" });
      return ok(`Queued: ${track.name} — ${track.artists.map((a) => a.name).join(", ")}`);
    } catch (e) {
      return fail(e);
    }
  },
);

/** In-process MCP server exposing Spotify playback control to the agent. */
export const spotifyServer = createSdkMcpServer({
  name: "spotify",
  version: "0.1.0",
  instructions:
    "Control Spotify playback for the user. Requires Spotify Premium and an active device — if a call fails because nothing is playing anywhere, ask the user to open Spotify on their phone or desktop first. Use `spotify_search_and_play` to start something new, `spotify_play`/`spotify_pause`/`spotify_next`/`spotify_previous` for transport control, `spotify_set_volume` to adjust volume, `spotify_now_playing` to check what's on, `spotify_devices` to see available devices, and `spotify_queue` to add a track without interrupting playback.",
  tools: [searchAndPlay, play, pause, next, previous, setVolume, nowPlaying, devices, queue],
});
