// The proactive layer: lets Jarvis act without being spoken to first.
//
// Three primitives, deliberately built once because reminders, briefings, folder
// watching and break nudges all need the same shape:
//   1. schedule  — one-off timers and recurring cron jobs (node-cron)
//   2. notify    — native Windows toast, so it reaches you with no browser open
//   3. inject    — push a synthetic turn into the live session, if one is connected
//
// Design rule: firing a trigger costs ZERO tokens. We only spend an LLM turn when
// the job explicitly asks Jarvis to say something (`speak: true`).
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import cron from "node-cron";
import notifier from "node-notifier";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const JOBS_FILE = process.env.JARVIS_JOBS_FILE ?? join(homedir(), ".jarvis", "jobs.json");

export type Job = {
  id: string;
  text: string;
  /** Recurring cron expression, or null for a one-off. */
  cron: string | null;
  /** ISO time a one-off should fire. */
  at: string | null;
  /** If true, Jarvis takes a turn about it; otherwise it's just a toast (free). */
  speak: boolean;
  createdAt: string;
};

let jobs: Job[] = [];
const timers = new Map<string, NodeJS.Timeout>();
const crons = new Map<string, ReturnType<typeof cron.schedule>>();

/** Set by index.ts when a browser session is connected. */
let injector: ((prompt: string, label: string) => void) | null = null;
export function setInjector(fn: ((prompt: string, label: string) => void) | null) {
  injector = fn;
}
/** Clear the injector only if it's still the one we set — avoids one closing
 *  connection tearing down another's wiring. */
export function clearInjector(fn: (prompt: string, label: string) => void) {
  if (injector === fn) injector = null;
}

/** Inject a synthetic turn into the live session if a browser is connected.
 *  Returns false if nobody's connected (caller should rely on the toast). Used
 *  by reminders and by the folder watcher. */
export function injectIfConnected(text: string, label: string): boolean {
  if (!injector) return false;
  injector(text, label);
  return true;
}

export function notify(title: string, message: string) {
  try {
    notifier.notify({ title, message, sound: true, wait: false });
  } catch (e) {
    console.error("[proactive] notify failed:", e);
  }
}

async function save() {
  mkdirSync(dirname(JOBS_FILE), { recursive: true });
  await writeFile(JOBS_FILE, JSON.stringify(jobs, null, 2), "utf8");
}

function fire(job: Job) {
  console.log(`[proactive] firing ${job.id}: ${job.text}`);
  notify(job.speak ? "Jarvis" : "Jarvis — reminder", job.text);

  if (job.speak && injector) {
    // Costs a turn, so only when explicitly requested.
    injector(
      `[Scheduled task fired: ${job.text}]\nDo this now and report briefly. This was triggered automatically, not typed by the user.`,
      job.text,
    );
  }

  if (!job.cron) {
    // One-off: clean up.
    timers.delete(job.id);
    jobs = jobs.filter((j) => j.id !== job.id);
    void save();
  }
}

// setTimeout maxes out at ~24.8 days; a longer delay silently fires immediately.
// Re-arm in hops so a far-future one-off ("remind me in 60 days") still fires
// at the right time. Each hop rewrites timers[id], so cancelJob still clears it.
const MAX_TIMEOUT = 2_147_483_647;
function armOneOff(job: Job, when: number) {
  const delay = when - Date.now();
  if (delay <= MAX_TIMEOUT) {
    timers.set(
      job.id,
      setTimeout(() => fire(job), Math.max(0, delay)),
    );
  } else {
    timers.set(
      job.id,
      setTimeout(() => armOneOff(job, when), MAX_TIMEOUT),
    );
  }
}

function arm(job: Job) {
  if (job.cron) {
    if (!cron.validate(job.cron)) {
      console.error(`[proactive] invalid cron for ${job.id}: ${job.cron}`);
      return;
    }
    const task = cron.schedule(job.cron, () => fire(job));
    crons.set(job.id, task);
  } else if (job.at) {
    const when = new Date(job.at).getTime();
    if (when <= Date.now()) return; // stale (fired while we were shut down)
    armOneOff(job, when);
  }
}

/** Load persisted jobs and re-arm them (so reminders survive a restart). */
export async function initProactive() {
  if (existsSync(JOBS_FILE)) {
    try {
      jobs = JSON.parse(await readFile(JOBS_FILE, "utf8")) as Job[];
    } catch {
      jobs = [];
    }
  }
  const before = jobs.length;
  jobs = jobs.filter((j) => j.cron || (j.at && new Date(j.at).getTime() > Date.now()));
  jobs.forEach(arm);
  if (jobs.length !== before) void save();
  console.log(`[proactive] ${jobs.length} scheduled job(s) armed`);
}

export async function addJob(input: {
  text: string;
  inMinutes?: number;
  cron?: string;
  speak?: boolean;
}): Promise<Job> {
  const job: Job = {
    id: randomUUID().slice(0, 8),
    text: input.text.trim(),
    cron: input.cron ?? null,
    at: input.inMinutes != null ? new Date(Date.now() + input.inMinutes * 60_000).toISOString() : null,
    speak: input.speak ?? false,
    createdAt: new Date().toISOString(),
  };
  if (!job.cron && !job.at) throw new Error("need either in_minutes or cron");
  if (job.cron && !cron.validate(job.cron)) throw new Error(`invalid cron expression: ${job.cron}`);
  jobs.push(job);
  arm(job);
  await save();
  return job;
}

export async function cancelJob(id: string): Promise<boolean> {
  const job = jobs.find((j) => j.id === id);
  if (!job) return false;
  clearTimeout(timers.get(id));
  timers.delete(id);
  crons.get(id)?.stop();
  crons.delete(id);
  jobs = jobs.filter((j) => j.id !== id);
  await save();
  return true;
}

export const listJobs = () => jobs;

/* ------------------------------ MCP tools ------------------------------ */

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
const fail = (e: unknown) => ({
  content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }],
  isError: true,
});

const scheduleTool = tool(
  "schedule",
  "Schedule a reminder or a recurring task. Use in_minutes for one-offs ('remind me in 20 minutes') or cron for recurring ('every weekday at 7am' = '0 7 * * 1-5'). Set speak=true only when Jarvis should actually do work and report (e.g. a morning briefing); leave it false for a plain reminder, which is free.",
  {
    text: z.string().describe("What to remind about, or the task to perform"),
    in_minutes: z.number().optional().describe("Fire once after this many minutes"),
    cron: z.string().optional().describe("5-field cron expression for recurring jobs"),
    speak: z.boolean().optional().describe("If true, Jarvis takes a turn and reports; costs tokens"),
  },
  async ({ text, in_minutes, cron: cronExpr, speak }) => {
    try {
      const job = await addJob({ text, inMinutes: in_minutes, cron: cronExpr, speak });
      const when = job.cron ? `cron "${job.cron}"` : `at ${new Date(job.at!).toLocaleString()}`;
      return ok(`Scheduled [${job.id}] ${when}${job.speak ? " (will report)" : ""}: ${job.text}`);
    } catch (e) {
      return fail(e);
    }
  },
);

const listTool = tool("list_scheduled", "List all scheduled reminders and recurring tasks.", {}, async () => {
  const all = listJobs();
  if (!all.length) return ok("Nothing scheduled.");
  return ok(
    all
      .map((j) => `[${j.id}] ${j.cron ? `cron "${j.cron}"` : new Date(j.at!).toLocaleString()} — ${j.text}`)
      .join("\n"),
  );
});

const cancelTool = tool(
  "cancel_scheduled",
  "Cancel a scheduled reminder or task by id (ids come from list_scheduled).",
  { id: z.string() },
  async ({ id }) => {
    try {
      return ok((await cancelJob(id)) ? `Cancelled ${id}.` : `No scheduled job with id ${id}.`);
    } catch (e) {
      return fail(e);
    }
  },
);

const notifyTool = tool(
  "notify",
  "Show a desktop notification immediately. Useful to get the user's attention when they may not be looking at the Jarvis window.",
  { title: z.string().optional(), message: z.string() },
  async ({ title, message }) => {
    notify(title ?? "Jarvis", message);
    return ok("Notification sent.");
  },
);

export const proactiveServer = createSdkMcpServer({
  name: "proactive",
  version: "0.1.0",
  instructions:
    "Lets Jarvis act on a schedule and get the user's attention. Use `schedule` for reminders and recurring tasks, `list_scheduled`/`cancel_scheduled` to manage them, and `notify` for an immediate desktop toast. Prefer speak=false for plain reminders — it costs nothing.",
  tools: [scheduleTool, listTool, cancelTool, notifyTool],
});
