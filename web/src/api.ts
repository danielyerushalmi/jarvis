// Talking to the backend, which now requires an access token on every call.
//
// Two ways the token gets here, and you normally use the first:
//
//  1. LOCAL DEV — you never see a token. The Vite proxy reads ~/.jarvis/auth.json
//     and attaches the Authorization header to everything it forwards, so the
//     browser holds no secret at all. `token()` returns null and that's correct.
//
//  2. DIRECT / REMOTE — you opened the backend straight (a phone over Tailscale,
//     or http://127.0.0.1:8787 with no Vite in front). Then the token arrives
//     once as `?token=…` in the URL; we stash it and scrub it out of the address
//     bar so it isn't left sitting in history or shoulder-view.

const KEY = "jarvis.token";

function bootstrap(): string | null {
  try {
    const url = new URL(location.href);
    const fromUrl = url.searchParams.get("token");
    if (fromUrl) {
      localStorage.setItem(KEY, fromUrl);
      // Drop it from the visible URL, but keep the rest of the location intact.
      url.searchParams.delete("token");
      history.replaceState(null, "", url.toString());
      return fromUrl;
    }
    return localStorage.getItem(KEY);
  } catch {
    return null; // storage disabled — dev proxy path still works
  }
}

let cached: string | null = bootstrap();

/** The token, or null when the dev proxy is supplying it for us. */
export function token(): string | null {
  return cached;
}

export function clearToken(): void {
  cached = null;
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing to clear */
  }
}

/** Authorization header, or nothing when the proxy is handling it. */
export function authHeaders(): Record<string, string> {
  return cached ? { Authorization: `Bearer ${cached}` } : {};
}

/** Append the token to a URL — for WebSockets and for links we open in a tab,
 *  neither of which can carry a header. */
export function withToken(path: string): string {
  if (!cached) return path;
  return path + (path.includes("?") ? "&" : "?") + `token=${encodeURIComponent(cached)}`;
}

export class Unauthorized extends Error {
  constructor() {
    super("not authorized — open the tokenized URL printed in the server's startup log");
    this.name = "Unauthorized";
  }
}

/** fetch() with the token attached and a recognizable error on 401. */
export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(path, {
    ...init,
    headers: { ...(init.headers as Record<string, string> | undefined), ...authHeaders() },
  });
  if (res.status === 401) throw new Unauthorized();
  return res;
}
