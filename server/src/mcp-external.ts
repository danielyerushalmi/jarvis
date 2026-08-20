// External MCP servers — capabilities Jarvis gains without any code being written.
//
// Everything in `computer.ts`, `memory.ts`, `spotify.ts` and friends is an
// IN-PROCESS MCP server: a module we wrote. That doesn't scale to "do anything",
// because every new capability is another module. The Agent SDK's `mcpServers`
// option also accepts servers it spawns or connects to itself
// (`McpStdioServerConfig | McpSSEServerConfig | McpHttpServerConfig`), so a
// third-party server is a few lines of JSON instead of a file of TypeScript.
//
// Config lives at ~/.jarvis/mcp.json and uses the same `mcpServers` key as the
// rest of the ecosystem, so a config you already have elsewhere can be pasted in:
//
//   {
//     "mcpServers": {
//       "filesystem": {
//         "command": "npx",
//         "args": ["-y", "@modelcontextprotocol/server-filesystem", "C:/Users/me/notes"]
//       },
//       "some-http-server": { "type": "http", "url": "https://example.com/mcp" },
//       "not-right-now": { "command": "npx", "args": ["..."], "disabled": true }
//     }
//   }
//
// SAFETY: tools from these servers are third-party code with parameters we know
// nothing about. `policy.ts` therefore treats any `mcp__<server>__*` tool whose
// server is NOT in BUILT_IN_MCP_SERVERS below as untrusted, and scans every
// string in its input. Adding a new in-process server means adding its name to
// that list — otherwise its ordinary calls start getting flagged.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";

const CONFIG_FILE = process.env.JARVIS_MCP_FILE ?? join(homedir(), ".jarvis", "mcp.json");

/**
 * The in-process servers registered in `agent.ts`. Tools from these are ours and
 * are inspected by the targeted rules in policy.ts. Anything else is external
 * and gets the full deep scan. KEEP IN SYNC with agent.ts's mcpServers.
 */
export const BUILT_IN_MCP_SERVERS = [
  "computer",
  "memory",
  "proactive",
  "briefing",
  "watcher",
  "spotify",
  "govee",
] as const;

/** A config entry as it appears in the file, before validation. */
type RawEntry = Record<string, unknown> & { disabled?: boolean };

let cache: Record<string, McpServerConfig> | null = null;
let lastSummary: string[] = [];

function isValid(name: string, entry: RawEntry): string | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name)) {
    return "name must start alphanumeric and contain only letters, digits, _ . -";
  }
  // A collision would silently shadow one of our own servers.
  if ((BUILT_IN_MCP_SERVERS as readonly string[]).includes(name)) {
    return "name collides with a built-in Jarvis server";
  }
  if (typeof entry !== "object" || entry === null) return "entry is not an object";
  const hasCommand = typeof entry.command === "string" && entry.command.trim().length > 0;
  const hasUrl = typeof entry.url === "string" && entry.url.trim().length > 0;
  if (!hasCommand && !hasUrl) return "needs either a \"command\" (stdio) or a \"url\" (http/sse)";
  if (hasCommand && entry.args !== undefined && !Array.isArray(entry.args)) return "\"args\" must be an array";
  return null;
}

/**
 * Read and validate ~/.jarvis/mcp.json. Never throws: a broken config must not
 * stop Jarvis from starting with the capabilities it already has. Cached after
 * the first call — restart to pick up edits.
 */
export function externalMcpServers(): Record<string, McpServerConfig> {
  if (cache) return cache;
  cache = {};
  lastSummary = [];

  if (!existsSync(CONFIG_FILE)) return cache;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
  } catch (err) {
    console.error(`[mcp] ${CONFIG_FILE} is not valid JSON — ignoring it:`, err instanceof Error ? err.message : err);
    return cache;
  }

  const root = parsed as { mcpServers?: unknown; servers?: unknown };
  const map = (root?.mcpServers ?? root?.servers) as Record<string, RawEntry> | undefined;
  if (!map || typeof map !== "object") {
    console.error(`[mcp] ${CONFIG_FILE} has no "mcpServers" object — ignoring it.`);
    return cache;
  }

  for (const [name, entry] of Object.entries(map)) {
    if (entry?.disabled) {
      lastSummary.push(`${name} (disabled)`);
      continue;
    }
    const problem = isValid(name, entry);
    if (problem) {
      console.error(`[mcp] skipping "${name}": ${problem}`);
      continue;
    }
    const { disabled: _drop, ...config } = entry;
    cache[name] = config as McpServerConfig;
    lastSummary.push(name);
  }
  return cache;
}

/** One line for the boot log, so it's obvious what's attached. */
export function describeExternalMcp(): string {
  const servers = externalMcpServers();
  const count = Object.keys(servers).length;
  if (!lastSummary.length) return `no external MCP servers (add them in ${CONFIG_FILE})`;
  return `${count} external MCP server(s): ${lastSummary.join(", ")}`;
}

export const MCP_CONFIG_PATH = CONFIG_FILE;
