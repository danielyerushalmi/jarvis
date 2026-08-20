// Authentication. Until now every endpoint was open to anything running on this
// machine, which was survivable only because the server binds to 127.0.0.1 and
// nothing outside could reach it. The moment you want Jarvis from your phone
// that stops being true — and this backend can move the mouse, type keystrokes
// and run shell commands, so it is not an endpoint to leave open.
//
// One shared secret, checked on every request and on the WebSocket upgrade:
//   - HTTP: `Authorization: Bearer <token>`, or `?token=` for links you click.
//   - WebSocket: `?token=` — browsers can't set headers on a WebSocket.
//
// The token lives in ~/.jarvis/auth.json and is generated on first boot. Set
// JARVIS_TOKEN to supply your own (useful when you'd rather keep it in a
// password manager than on disk).
//
// You will not normally type it: in local development the Vite proxy reads the
// same file and attaches it for you (see web/vite.config.ts), so the browser
// never handles a token at all. It only matters when something talks to the
// backend directly — a phone over Tailscale, or curl.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const AUTH_FILE = process.env.JARVIS_AUTH_FILE ?? join(homedir(), ".jarvis", "auth.json");

let token: string | null = null;

/** The shared secret, generated and persisted on first use. */
export function authToken(): string {
  if (token) return token;

  const fromEnv = process.env.JARVIS_TOKEN?.trim();
  if (fromEnv) {
    token = fromEnv;
    return token;
  }

  if (existsSync(AUTH_FILE)) {
    try {
      const saved = JSON.parse(readFileSync(AUTH_FILE, "utf8")) as { token?: string };
      if (typeof saved.token === "string" && saved.token.length >= 32) {
        token = saved.token;
        return token;
      }
      console.error(`[auth] ${AUTH_FILE} has no usable token — generating a new one`);
    } catch {
      console.error(`[auth] ${AUTH_FILE} is unreadable — generating a new one`);
    }
  }

  token = randomBytes(32).toString("base64url"); // 256 bits
  mkdirSync(dirname(AUTH_FILE), { recursive: true });
  // mode 0600: on Windows this is advisory (ACLs are what actually apply), but
  // it costs nothing and is correct if this ever runs on Linux/macOS.
  writeFileSync(AUTH_FILE, JSON.stringify({ token }, null, 2), { encoding: "utf8", mode: 0o600 });
  console.log(`[auth] generated a new access token at ${AUTH_FILE}`);
  return token;
}

/** Compare in constant time, tolerating length differences. */
function sameToken(candidate: string): boolean {
  const a = Buffer.from(candidate);
  const b = Buffer.from(authToken());
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Pull a token off a request. Header first (what programs should use), then the
 * query string (what a clicked link or a WebSocket can manage).
 */
export function tokenFrom(headers: Record<string, unknown>, query: unknown): string | null {
  const header = headers?.authorization;
  if (typeof header === "string") {
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (match) return match[1].trim();
  }
  const q = (query as { token?: unknown })?.token;
  if (typeof q === "string" && q) return q;
  return null;
}

export function isAuthorized(headers: Record<string, unknown>, query: unknown): boolean {
  const candidate = tokenFrom(headers, query);
  return candidate !== null && sameToken(candidate);
}

/**
 * Routes reachable WITHOUT a token, and why:
 *   /spotify/callback — Spotify redirects the browser here and cannot carry our
 *     token. It's protected instead by the OAuth `state` check, which rejects
 *     any callback that doesn't match a flow we started.
 * Everything else requires the token. Keep this list as short as it is.
 */
export const PUBLIC_ROUTES = new Set(["/spotify/callback"]);

export const AUTH_FILE_PATH = AUTH_FILE;
