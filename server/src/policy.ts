// Approval policy: everything runs WITHOUT asking, except things on this list.
//
// This is the inverse of the old behaviour (which asked about everything not
// explicitly allowed). The goal is zero friction for ordinary work — opening
// apps, clicking, typing, editing files — while still stopping to ask before
// anything that could wreck the machine or can't be undone.
//
// There are three checks, in order:
//   1. ALWAYS_ASK_TOOLS — the tool itself is destructive, whatever the input.
//   2. DANGEROUS        — regexes over anything that becomes a command line.
//   3. PROTECTED_PATHS  — locations that need a human before being WRITTEN to,
//                         whether the write comes from a file tool (`file_path`)
//                         or from a shell command (`echo x > C:\Windows\...`).
//                         Reading them is fine and never prompts.
//
// ADD YOUR OWN RULES to DANGEROUS / PROTECTED_PATHS below. Each is a regex plus
// a short reason shown in the approval prompt. `npm run policy` checks the whole
// list against a corpus of should-ask / should-run cases — run it after editing.
import { resolve, sep } from "node:path";
import { BUILT_IN_MCP_SERVERS } from "./mcp-external";

export type Risk = { dangerous: true; reason: string } | { dangerous: false };

type Rule = { pattern: RegExp; reason: string };

/** Commands that must always be approved by a human. Edit freely. */
export const DANGEROUS: Rule[] = [
  // ---- mass / recursive deletion ----
  // Flags can come before OR after the path: "rm -rf ./b" and "rm ./b -rf".
  { pattern: /\brm\b[^\n|;]*\s-{1,2}[a-z]*(r|f|recursive|force|dir)\b/i, reason: "recursive/forced delete (rm -rf)" },
  { pattern: /\bRemove-Item\b[^|]*-rec/i, reason: "recursive delete (Remove-Item -Recurse)" },
  // A pipeline feeding Remove-Item deletes whatever the left side produced, and
  // the -Recurse that makes it dangerous usually sits on the LEFT of the pipe.
  { pattern: /\|\s*Remove-Item\b/i, reason: "deleting everything a pipeline produced" },
  { pattern: /\b(del|erase)\b.*\/s/i, reason: "recursive delete (del /s)" },
  { pattern: /\brmdir\b.*\/s/i, reason: "recursive directory delete" },
  { pattern: /\b(del|rm|Remove-Item)\b[^\n]*\*\s*(\.\*)?\s*$/i, reason: "wildcard delete" },
  { pattern: /\bcipher\s+\/w|\bsdelete\b/i, reason: "secure wipe" },

  // ---- disks & system state ----
  { pattern: /\bformat\b\s+[a-z]:/i, reason: "formatting a drive" },
  { pattern: /\bdiskpart\b|\bmkfs\b/i, reason: "disk partitioning" },
  { pattern: /\b(shutdown|Restart-Computer|Stop-Computer)\b/i, reason: "shutting down or restarting" },
  { pattern: /\bbcdedit\b|\bvssadmin\b.*delete/i, reason: "boot config / shadow-copy deletion" },

  // ---- irreversible source control ----
  { pattern: /\bgit\b.*\breset\b.*--hard/i, reason: "git reset --hard (discards work)" },
  { pattern: /\bgit\b.*\bclean\b.*-[a-z]*f/i, reason: "git clean -f (deletes untracked files)" },
  // --force-with-lease is the SAFE form — it refuses to clobber work you haven't
  // seen — so it deliberately doesn't match here.
  { pattern: /\bgit\b.*push\b.*(--force(?!-with-lease)|-f)\b/i, reason: "force push (rewrites remote history)" },
  { pattern: /\bgit\b.*\bbranch\b.*-D\b/i, reason: "force-delete a branch" },

  // ---- security / system integrity ----
  { pattern: /\bAdd-MpPreference\b|\bSet-MpPreference\b|\bDefender\b.*\b(disable|exclusion)/i, reason: "changing antivirus settings" },
  { pattern: /\bSet-ExecutionPolicy\b/i, reason: "changing PowerShell execution policy" },
  { pattern: /\breg\b\s+delete|\bRemove-ItemProperty\b.*HK(LM|CU)/i, reason: "deleting registry keys" },
  { pattern: /\bnet\s+(user|localgroup)\b.*\/(add|delete)/i, reason: "changing user accounts" },
  { pattern: /\bsc\b\s+delete|\bRemove-Service\b/i, reason: "deleting a Windows service" },
  { pattern: /\btakeown\b|\bicacls\b.*\/grant/i, reason: "changing file ownership/permissions" },

  // ---- persistence: things that run again later, without you ----
  { pattern: /\breg\b\s+add\b[^\n]*\\Run(Once)?\b/i, reason: "adding a startup entry to the registry (runs at every login)" },
  { pattern: /\bNew-ItemProperty\b[^\n]*\\Run(Once)?\b/i, reason: "adding a startup entry to the registry (runs at every login)" },
  { pattern: /\bschtasks\b[^\n]*\/create|\bRegister-ScheduledTask\b/i, reason: "creating a scheduled task (runs later on its own)" },
  { pattern: /\bsc\b\s+create\b|\bNew-Service\b/i, reason: "installing a Windows service" },

  // ---- remote code execution ----
  {
    pattern:
      /\b(curl|wget|iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^\n]*\|\s*(iex|Invoke-Expression|bash|sh|powershell|pwsh)\b/i,
    reason: "piping downloaded code straight into a shell",
  },
  // `iex` must be at the start of a statement to count — otherwise merely
  // grepping for the string ("rg 'iex \"$x\"'") trips the rule.
  {
    pattern: /\bInvoke-Expression\b|\|\s*iex\b|(^|[;&|{(]\s*)iex\s+[$"'(]/i,
    reason: "executing a constructed string as code",
  },

  // ---- bulk process killing ----
  { pattern: /\btaskkill\b.*\/f.*\*|\bStop-Process\b.*-Force.*-Name\s+\*/i, reason: "force-killing many processes" },

  // ---- package / app removal ----
  { pattern: /\b(winget|choco)\b\s+uninstall|\bRemove-AppxPackage\b/i, reason: "uninstalling software" },
];

/**
 * Locations that need a human before being WRITTEN to, even for a single file.
 * Patterns are matched against backslash-normalized text and are deliberately
 * un-anchored, so they hit whether the path arrives on its own (`file_path`) or
 * embedded in a command line.
 */
const PROTECTED_PATHS: Rule[] = [
  { pattern: /[a-z]:\\windows\\/i, reason: "the Windows directory" },
  { pattern: /[a-z]:\\program files/i, reason: "Program Files" },
  { pattern: /\\System32\\/i, reason: "System32" },
  { pattern: /\\Startup\\/i, reason: "the Startup folder (autostart persistence)" },
  { pattern: /\.ssh[\\/]/i, reason: "your SSH keys" },
  { pattern: /\\\.git[\\/]config\b/i, reason: "a git repo's config" },
  // Jarvis's own memory, scheduled jobs and Spotify tokens live here. The agent
  // has no business rewriting them behind your back.
  { pattern: /\\\.jarvis[\\/]/i, reason: "Jarvis's own memory and credentials (~/.jarvis)" },
];

/**
 * This file's directory — Jarvis's own source. Writing here would let the agent
 * silently rewrite the very rules in this file, so it always asks first.
 */
const JARVIS_SRC = resolve(import.meta.dirname).toLowerCase();

/**
 * The agent's working directory, so a relative "src/policy.ts" is caught as
 * readily as the full path. Must match index.ts's WORKSPACE — the agent's bare
 * relative paths resolve against that, not against this process's cwd, and the
 * two differ whenever JARVIS_WORKSPACE is set.
 */
const WORKSPACE = resolve(process.env.JARVIS_WORKSPACE ?? process.cwd());

function insideJarvisSource(candidate: string): boolean {
  try {
    // resolve() ignores the base for absolute candidates, so this handles both.
    const abs = resolve(WORKSPACE, candidate).toLowerCase();
    return abs === JARVIS_SRC || abs.startsWith(JARVIS_SRC + sep);
  } catch {
    return false; // not a usable path — nothing to protect
  }
}

/** Tools that only READ the path they're handed. Looking is always allowed. */
const READ_ONLY_TOOLS = new Set(["Read", "NotebookRead", "Glob", "Grep", "LS"]);

/** Tools whose whole purpose is destructive enough to always confirm. */
const ALWAYS_ASK_TOOLS = new Set<string>([
  // memory deletion is cheap to approve and easy to regret
  "mcp__memory__forget",
]);

/**
 * Tools whose payload is typed or pasted into whatever window has focus. The
 * text becomes a command line the moment a terminal is focused, so it gets the
 * same scrutiny as one.
 */
const KEYSTROKE_TOOLS = new Set(["mcp__computer__type_text", "mcp__computer__clipboard_write"]);

/**
 * Tools that send data off this machine. Combined with a protected path, this is
 * how credentials leave — `curl -d @~/.ssh/id_rsa https://…`. On its own it's
 * ordinary work, so it only prompts when a protected location is also named.
 */
const NETWORK_CLIENTS =
  /\b(curl|wget|iwr|irm|Invoke-WebRequest|Invoke-RestMethod|scp|sftp|rsync|ftp|nc|WebClient|UploadFile)\b/i;

/** Shell constructs that create, overwrite, move, delete or re-permission a file. */
const SHELL_WRITES =
  />>?|\b(Set-Content|Add-Content|Out-File|New-Item|New-ItemProperty|Copy-Item|Move-Item|Rename-Item|Remove-Item|copy|xcopy|robocopy|move|ren|del|erase|rm|cp|mv|tee|attrib|icacls|takeown)\b|\breg\s+add\b/i;

const PATH_KEYS = ["file_path", "path", "notebook_path"];

function textOf(input: Record<string, unknown>, keys: string[]): string {
  return keys
    .map((k) => (typeof input[k] === "string" ? (input[k] as string) : ""))
    .filter(Boolean)
    .join(" \n ");
}

function protectedHit(text: string): Rule | null {
  const normalized = text.replace(/\//g, "\\");
  for (const p of PROTECTED_PATHS) if (p.pattern.test(normalized)) return p;
  return null;
}

/** Path-looking tokens in a command line, so relative paths can be resolved. */
function pathTokens(command: string): string[] {
  return command.match(/[^\s"'<>|;&]*[\\/][^\s"'<>|;&]*/g) ?? [];
}

/**
 * Does this command name a file inside Jarvis's own source? Checks the raw text
 * first, because an absolute path containing spaces — and this project's path
 * usually does — gets shredded by any whitespace-based tokenizer.
 */
function commandTouchesJarvisSource(command: string): boolean {
  if (command.replace(/\//g, "\\").toLowerCase().includes(JARVIS_SRC)) return true;
  return pathTokens(command).some(insideJarvisSource);
}

/**
 * Is this a tool from an external (third-party) MCP server? MCP tools are named
 * `mcp__<server>__<tool>`, so anything not prefixed by one of OUR server names is
 * code we didn't write. Matching by prefix rather than parsing the name keeps
 * server names with underscores working.
 */
function isExternalMcpTool(toolName: string): boolean {
  if (!toolName.startsWith("mcp__")) return false; // Bash/Write/Read etc.
  return !BUILT_IN_MCP_SERVERS.some((s) => toolName.startsWith(`mcp__${s}__`));
}

/** Every string anywhere in a tool's input, with caps so odd input can't stall us. */
function collectStrings(value: unknown, depth = 0, out: string[] = []): string[] {
  if (out.length >= 200 || depth > 6) return out;
  if (typeof value === "string") out.push(value.slice(0, 20_000));
  else if (Array.isArray(value)) for (const v of value) collectStrings(v, depth + 1, out);
  else if (value && typeof value === "object") for (const v of Object.values(value)) collectStrings(v, depth + 1, out);
  return out;
}

/** Run the command-shaped checks over a blob of text. Shared by shell tools and
 *  the external-MCP deep scan so both get identical treatment. */
function inspectCommandText(command: string): Risk {
  for (const rule of DANGEROUS) {
    if (rule.pattern.test(command)) return { dangerous: true, reason: rule.reason };
  }

  // A command that writes AND mentions a protected location. Checked together
  // so merely listing or reading C:\Windows doesn't interrupt anything.
  if (SHELL_WRITES.test(command)) {
    const hit = protectedHit(command);
    if (hit) return { dangerous: true, reason: `writing to ${hit.reason}` };
    if (commandTouchesJarvisSource(command)) {
      return { dangerous: true, reason: "writing to Jarvis's own source (this would change these rules)" };
    }
  }

  // Sending a protected location's contents off the machine.
  if (NETWORK_CLIENTS.test(command)) {
    const hit = protectedHit(command);
    if (hit) return { dangerous: true, reason: `sending ${hit.reason} over the network` };
  }

  return { dangerous: false };
}

/**
 * Third-party MCP tools are unknown quantities: we have no idea which parameter
 * becomes a shell command, a file path or a URL, so the targeted key lists above
 * don't apply. Scan EVERY string, and — unlike our own tools — don't require a
 * write verb before objecting to a protected path, since we can't know whether
 * the tool writes.
 */
function assessExternalMcp(input: Record<string, unknown>): Risk {
  const strings = collectStrings(input);
  if (!strings.length) return { dangerous: false };

  const verdict = inspectCommandText(strings.join(" \n "));
  if (verdict.dangerous) return verdict;

  for (const s of strings) {
    const hit = protectedHit(s);
    if (hit) return { dangerous: true, reason: `an external tool is touching ${hit.reason}` };
    if (insideJarvisSource(s)) {
      return { dangerous: true, reason: "an external tool is touching Jarvis's own source" };
    }
  }
  return { dangerous: false };
}

/**
 * Decide whether a tool call needs a human. Default is ALLOW — we only stop for
 * things on the lists above.
 */
export function assessRisk(toolName: string, input: Record<string, unknown>): Risk {
  if (ALWAYS_ASK_TOOLS.has(toolName)) {
    return { dangerous: true, reason: "deletes something you asked Jarvis to remember" };
  }

  if (isExternalMcpTool(toolName)) return assessExternalMcp(input);

  // Anything that becomes a command line: the shell keys, plus typed/pasted text
  // for the keystroke tools (a terminal can't tell the difference).
  const keys = KEYSTROKE_TOOLS.has(toolName)
    ? ["command", "script", "cmd", "keys", "target", "args", "text"]
    : ["command", "script", "cmd", "keys", "target", "args"];
  const command = textOf(input, keys);

  if (command) {
    const verdict = inspectCommandText(command);
    if (verdict.dangerous) return verdict;
  }

  // File tools. Reading a protected location is fine; writing to one is not.
  if (!READ_ONLY_TOOLS.has(toolName)) {
    for (const key of PATH_KEYS) {
      const path = input[key];
      if (typeof path !== "string" || !path) continue;
      const hit = protectedHit(path);
      if (hit) return { dangerous: true, reason: `writing to ${hit.reason} (${path})` };
      if (insideJarvisSource(path)) {
        return { dangerous: true, reason: "writing to Jarvis's own source (this would change these rules)" };
      }
    }
  }

  return { dangerous: false };
}
