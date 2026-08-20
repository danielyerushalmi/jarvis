import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The backend requires an access token on every request. Rather than making you
// paste one into the browser during local development, the dev proxy reads the
// same file the server writes and attaches the header on the way through — so
// the browser never holds a secret and the backend is still fully authenticated.
//
// Read PER REQUEST, not at config load: `npm run dev` starts Vite and the server
// together, and on a first-ever run the server hasn't written the token yet when
// Vite boots. By the time a request is actually proxied, it has.
const AUTH_FILE = process.env.JARVIS_AUTH_FILE ?? join(homedir(), ".jarvis", "auth.json");

let cached: { token: string; at: number } | null = null;

function readToken(): string | null {
  if (process.env.JARVIS_TOKEN) return process.env.JARVIS_TOKEN;
  if (cached && Date.now() - cached.at < 5000) return cached.token;
  try {
    if (!existsSync(AUTH_FILE)) return null;
    const { token } = JSON.parse(readFileSync(AUTH_FILE, "utf8")) as { token?: string };
    if (!token) return null;
    cached = { token, at: Date.now() };
    return token;
  } catch {
    return null; // unreadable — the request will 401 and the UI will say so
  }
}

/**
 * Attach the token to both plain requests and WebSocket upgrades.
 * Typed as `unknown` because Vite's ProxyServer type doesn't surface the
 * EventEmitter methods, and a function taking `unknown` still satisfies its
 * `configure` signature.
 */
type ProxyLike = {
  on: (event: string, cb: (req: { setHeader: (k: string, v: string) => void }) => void) => void;
};

function withAuth(proxy: unknown) {
  const p = proxy as ProxyLike;
  const attach = (proxyReq: { setHeader: (k: string, v: string) => void }) => {
    const token = readToken();
    if (!token) return;
    try {
      proxyReq.setHeader("Authorization", `Bearer ${token}`);
    } catch {
      /* headers already sent — nothing useful to do */
    }
  };
  p.on("proxyReq", attach);
  p.on("proxyReqWs", attach);
}

const backend = "http://127.0.0.1:8787";
const httpRoute = { target: backend, configure: withAuth };

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Proxy to the Jarvis backend so the browser reaches it via localhost:5173
    // without knowing the backend port — and without handling the token.
    proxy: {
      "/ws": { target: "ws://127.0.0.1:8787", ws: true, configure: withAuth },
      "/stt": httpRoute,
      "/tts": httpRoute,
      "/memory": httpRoute,
      "/jobs": httpRoute,
      "/upload": httpRoute,
      "/spotify": httpRoute,
      "/system": httpRoute,
    },
  },
});
