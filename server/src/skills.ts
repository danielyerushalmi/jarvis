// Skills — capabilities as markdown instead of code.
//
// A skill is a folder with a SKILL.md: a name, a description that says WHEN to
// use it, and a procedure. The model reads the description, decides a skill
// applies, and loads the body on demand. That makes skills the right home for
// anything procedural ("how I want a briefing done") which would otherwise pile
// up in JARVIS_PROMPT — where it costs tokens on every single turn, whether the
// turn is about briefings or not.
//
// Two sources, both optional:
//   1. `server/skills/`      — ships with Jarvis, version-controlled.
//   2. `~/.jarvis/skills/`   — yours. Nothing is auto-created; make it when you
//                              want it. Override the location with
//                              JARVIS_SKILLS_DIR.
//
// Both are loaded as LOCAL PLUGINS rather than via `settingSources`, for two
// reasons: the path stays fixed no matter where JARVIS_WORKSPACE points, and it
// leaves the CLI's own settings discovery exactly as it was.
//
// To add a skill: make `<dir>/skills/<skill-name>/SKILL.md`, then list it in
// `<dir>/.claude-plugin/plugin.json` under "skills", then restart the server.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SdkPluginConfig } from "@anthropic-ai/claude-agent-sdk";

/** Ships with the repo. Resolved from this file so the cwd is irrelevant. */
const SHIPPED_DIR = join(import.meta.dirname, "..", "skills");
/** Yours. Not created for you — its absence is normal. */
const USER_DIR = process.env.JARVIS_SKILLS_DIR ?? join(homedir(), ".jarvis", "skills");

type Source = { label: string; path: string };

const SOURCES: Source[] = [
  { label: "shipped", path: SHIPPED_DIR },
  { label: "yours", path: USER_DIR },
];

let summary: string[] = [];

/**
 * Plugin entries for every skill directory that's actually usable. A directory
 * missing its manifest is skipped with a log rather than throwing: a half-made
 * skills folder must never stop Jarvis from starting.
 */
export function skillPlugins(): SdkPluginConfig[] {
  const plugins: SdkPluginConfig[] = [];
  summary = [];

  for (const { label, path } of SOURCES) {
    if (!existsSync(path)) continue; // nothing there — normal, say nothing
    if (!existsSync(join(path, ".claude-plugin", "plugin.json"))) {
      console.error(`[skills] ${path} has no .claude-plugin/plugin.json — skipping it`);
      continue;
    }
    plugins.push({ type: "local", path });
    summary.push(`${label} (${path})`);
  }
  return plugins;
}

/** One line for the boot log. Call after skillPlugins(). */
export function describeSkills(): string {
  if (!summary.length) return `no skill directories found (add one at ${USER_DIR})`;
  return `${summary.length} skill source(s): ${summary.join(", ")}`;
}

export const USER_SKILLS_PATH = USER_DIR;
