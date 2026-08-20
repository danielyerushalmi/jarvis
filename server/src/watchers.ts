// Folder watching: "tell me when a file lands in Downloads".
//
// Same spirit as proactive.ts — a trigger costs ZERO tokens (it fires a desktop
// toast), and only escalates to an LLM turn when the watch was created with
// speak=true. Watches persist to ~/.jarvis/watches.json and re-arm on restart.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";
import chokidar, { type FSWatcher } from "chokidar";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { injectIfConnected, notify } from "./proactive";

const WATCHES_FILE = process.env.JARVIS_WATCHES_FILE ?? join(homedir(), ".jarvis", "watches.json");

export type Watch = {
  id: string;
  folder: string;
  /** Only fire for filenames containing this substring (case-insensitive); null = any file. */
  contains: string | null;
  /** If true, Jarvis takes a turn about it; otherwise it's just a toast (free). */
  speak: boolean;
  createdAt: string;
};

let watches: Watch[] = [];
const watchers = new Map<string, FSWatcher>();

async function save() {
  mkdirSync(dirname(WATCHES_FILE), { recursive: true });
  await writeFile(WATCHES_FILE, JSON.stringify(watches, null, 2), "utf8");
}

function onNewFile(watch: Watch, filePath: string) {
  const name = basename(filePath);
  if (watch.contains && !name.toLowerCase().includes(watch.contains.toLowerCase())) return;
  console.log(`[watch] ${watch.id}: new file ${name} in ${watch.folder}`);
  notify("Jarvis — folder watch", `New file in ${basename(watch.folder)}: ${name}`);
  if (watch.speak) {
    injectIfConnected(
      `[Folder watch fired: a new file "${name}" appeared in ${watch.folder}.]\n` +
        `Mention it briefly and offer to help. This was triggered automatically, not typed by the user.`,
      `new file: ${name}`,
    );
  }
}

function arm(watch: Watch) {
  if (!existsSync(watch.folder)) {
    console.error(`[watch] ${watch.id}: folder does not exist: ${watch.folder}`);
    return;
  }
  // depth:0 = this folder only; awaitWriteFinish so we don't fire on a half-written
  // file; ignoreInitial so existing files don't all fire on startup.
  const w = chokidar.watch(watch.folder, {
    ignoreInitial: true,
    depth: 0,
    awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 200 },
  });
  w.on("add", (p: string) => onNewFile(watch, p));
  w.on("error", (err: unknown) => console.error(`[watch] ${watch.id} error:`, err));
  watchers.set(watch.id, w);
}

/** Load persisted watches and re-arm them so they survive a restart. */
export async function initWatchers() {
  if (existsSync(WATCHES_FILE)) {
    try {
      watches = JSON.parse(await readFile(WATCHES_FILE, "utf8")) as Watch[];
    } catch {
      watches = [];
    }
  }
  watches.forEach(arm);
  console.log(`[watch] ${watches.length} folder watch(es) armed`);
}

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
const fail = (e: unknown) => ({
  content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }],
  isError: true,
});

const watchTool = tool(
  "watch_folder",
  "Watch a folder and get notified when a new file appears there — e.g. 'tell me when a PDF lands in Downloads'. Set speak=true to have Jarvis actually react (costs a turn); leave it false for a plain desktop notification (free). Watches survive restarts.",
  {
    folder: z.string().describe("Absolute path to the folder to watch"),
    contains: z.string().optional().describe("Only fire for filenames containing this text (e.g. 'invoice')"),
    speak: z.boolean().optional().describe("If true, Jarvis takes a turn when a file appears; costs tokens"),
  },
  async ({ folder, contains, speak }) => {
    try {
      if (!existsSync(folder)) return fail(new Error(`folder does not exist: ${folder}`));
      const watch: Watch = {
        id: randomUUID().slice(0, 8),
        folder,
        contains: contains ?? null,
        speak: speak ?? false,
        createdAt: new Date().toISOString(),
      };
      watches.push(watch);
      arm(watch);
      await save();
      return ok(
        `Watching ${folder}${watch.contains ? ` for files containing "${watch.contains}"` : ""} [${watch.id}]` +
          `${watch.speak ? " (will react)" : " (toast only)"}.`,
      );
    } catch (e) {
      return fail(e);
    }
  },
);

const listTool = tool("list_watches", "List active folder watches.", {}, async () => {
  if (!watches.length) return ok("No folder watches.");
  return ok(
    watches
      .map(
        (w) =>
          `[${w.id}] ${w.folder}${w.contains ? ` (contains "${w.contains}")` : ""}${w.speak ? " · reacts" : ""}` +
          // A watch whose folder has since disappeared stays in the list but has
          // no watcher behind it. Say so instead of reporting it as live.
          (watchers.has(w.id) ? "" : " · NOT ACTIVE (folder missing — recreate it)"),
      )
      .join("\n"),
  );
});

const unwatchTool = tool(
  "unwatch",
  "Stop a folder watch by its id (ids come from list_watches).",
  { id: z.string() },
  async ({ id }) => {
    try {
      const w = watchers.get(id);
      if (w) {
        await w.close();
        watchers.delete(id);
      }
      const before = watches.length;
      watches = watches.filter((x) => x.id !== id);
      if (watches.length === before) return ok(`No watch with id ${id}.`);
      await save();
      return ok(`Stopped watch ${id}.`);
    } catch (e) {
      return fail(e);
    }
  },
);

export const watcherServer = createSdkMcpServer({
  name: "watcher",
  version: "0.1.0",
  instructions:
    "Lets Jarvis watch folders for new files. Use `watch_folder` (speak=false is a free toast; speak=true spends a turn to react), `list_watches`, and `unwatch`. Watches persist across restarts.",
  tools: [watchTool, listTool, unwatchTool],
});
