// Persistent long-term memory for Jarvis.
//
// Facts are stored as JSONL on this machine and indexed with LOCAL embeddings
// (transformers.js — the same dependency Whisper already uses, so no new
// install). Nothing leaves the machine, and search costs zero Claude tokens.
//
// Three things this store does that a flat list of sentences doesn't:
//
//   1. TWO KINDS. A `fact` is durable ("Sam owns billing"). An `episode` is
//      something that happened ("spent Tuesday chasing a camera bug; the block
//      order was the cause"). Facts are injected automatically on every turn;
//      episodes are not — they'd be noise — but both are searchable, so
//      "what did we try last time?" finally has an answer.
//
//   2. SUPERSESSION. "I live in Toronto" and "I moved to Berlin" are not
//      duplicates, so dedup never caught them, and both stayed retrievable
//      forever. A new memory can now retire the ones it replaces; the retired
//      copy stays on disk (history is useful) but is excluded from recall.
//
//   3. RANKING BEYOND SIMILARITY. Cosine alone ignores that a fact from
//      yesterday usually beats a near-identical one from two years ago. Recency
//      and an explicit importance flag now nudge the ordering — gently, so
//      similarity still decides.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pipeline } from "@huggingface/transformers";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

// Kept outside the agent's sandboxed workspace on purpose: the agent's file
// tools shouldn't be able to clobber your memory by accident.
const MEMORY_FILE = process.env.JARVIS_MEMORY_FILE ?? join(homedir(), ".jarvis", "memory.jsonl");
const EMBED_MODEL = "Xenova/all-MiniLM-L6-v2";

// Auto-recall tuning. Cosine similarity on normalized vectors: 1.0 = identical.
const AUTO_RECALL_TOP_K = 3;
const AUTO_RECALL_MIN_SCORE = 0.35;

// Near-identical: fold into the existing memory rather than storing twice.
const DUPLICATE_SCORE = 0.97;
// Close enough to be worth showing the model as "you may be correcting this".
// MEASURED, not guessed — with all-MiniLM-L6-v2 on this kind of sentence:
//   contradictions ("lives in Toronto" vs "moved to Berlin")   0.46 – 0.79
//   unrelated facts ("likes coffee" vs "has a cat")           -0.01 – 0.35
// 0.42 sits in the gap. Re-measure before changing it; the first guess here was
// 0.72, which silently caught nothing except the most literal restatements.
const RELATED_SCORE = 0.42;

// Recency is a nudge, not a cliff — most facts are timeless, so an old memory
// should slip below a fresh near-tie without ever being buried. At a year old a
// memory keeps ~95% of its score; at three years, ~92%.
const RECENCY_FLOOR = 0.92;
const RECENCY_HALFLIFE_DAYS = 365;
const IMPORTANCE_BOOST = 1.08;

export type MemoryKind = "fact" | "episode";
export type Importance = "normal" | "high";

export type Memory = {
  id: string;
  text: string;
  createdAt: string;
  tags: string[];
  embedding: number[];
  /** Older records predate this field and are read as facts. */
  kind?: MemoryKind;
  importance?: Importance;
  /** Id of the memory that replaced this one; set = excluded from recall. */
  supersededBy?: string;
  supersededAt?: string;
  /** For episodes: when the thing happened, if not now. */
  occurredAt?: string;
};

let embedderPromise: Promise<unknown> | null = null;
let cache: Memory[] | null = null;

function getEmbedder() {
  if (!embedderPromise) {
    console.log(`[memory] loading embedding model "${EMBED_MODEL}" (first run downloads it)…`);
    embedderPromise = pipeline("feature-extraction", EMBED_MODEL).then((p) => {
      console.log("[memory] embeddings ready");
      return p;
    });
  }
  return embedderPromise;
}

export function preloadMemory() {
  void getEmbedder().catch((e) => console.error("[memory] preload failed:", e));
  void load().catch(() => {});
}

async function embed(text: string): Promise<number[]> {
  const extractor = (await getEmbedder()) as (
    t: string,
    o: { pooling: "mean"; normalize: boolean },
  ) => Promise<{ data: Float32Array }>;
  const out = await extractor(text, { pooling: "mean", normalize: true });
  return Array.from(out.data);
}

/** Vectors are normalized at embed time, so cosine similarity is just a dot product. */
function similarity(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length && i < b.length; i++) sum += a[i] * b[i];
  return sum;
}

export const kindOf = (m: Memory): MemoryKind => m.kind ?? "fact";
export const isLive = (m: Memory): boolean => !m.supersededBy;

function ageInDays(m: Memory): number {
  const stamp = Date.parse(m.occurredAt ?? m.createdAt);
  if (Number.isNaN(stamp)) return 0;
  return Math.max(0, (Date.now() - stamp) / 86_400_000);
}

/**
 * Similarity, adjusted for how recent and how important the memory is. Both
 * multipliers stay near 1.0 so a genuinely better match always wins — they only
 * decide near-ties, which is exactly where a flat cosine ranking was arbitrary.
 */
function rank(m: Memory, sim: number): number {
  const recency = RECENCY_FLOOR + (1 - RECENCY_FLOOR) * Math.exp(-ageInDays(m) / RECENCY_HALFLIFE_DAYS);
  const importance = m.importance === "high" ? IMPORTANCE_BOOST : 1;
  return sim * recency * importance;
}

async function load(): Promise<Memory[]> {
  if (cache) return cache;
  if (!existsSync(MEMORY_FILE)) {
    cache = [];
    return cache;
  }
  const raw = await readFile(MEMORY_FILE, "utf8");
  cache = raw
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l) as Memory;
      } catch {
        return null;
      }
    })
    .filter((m): m is Memory => m !== null);
  return cache;
}

/** Rewrite the whole file — for edits (supersession, forget, prune). */
async function saveAll(all: Memory[]): Promise<void> {
  mkdirSync(dirname(MEMORY_FILE), { recursive: true });
  await writeFile(MEMORY_FILE, all.map((m) => JSON.stringify(m)).join("\n") + (all.length ? "\n" : ""), "utf8");
}

export type AddResult = {
  memory: Memory;
  /** True when an existing near-identical memory was reused instead. */
  duplicate: boolean;
  /** Live memories close enough that this one might be correcting them. */
  related: { memory: Memory; score: number }[];
  /** Ids actually retired by this write. */
  superseded: string[];
};

export async function addMemory(
  text: string,
  tags: string[] = [],
  opts: { kind?: MemoryKind; importance?: Importance; supersedes?: string[]; occurredAt?: string } = {},
): Promise<AddResult> {
  const all = await load();
  const clean = text.trim();
  const kind = opts.kind ?? "fact";
  const embedding = await embed(clean);

  const scored = all
    .filter((m) => isLive(m) && kindOf(m) === kind)
    .map((memory) => ({ memory, score: similarity(memory.embedding, embedding) }))
    .sort((a, b) => b.score - a.score);

  // Near-identical: keep the original rather than piling up copies. Episodes are
  // exempt — the same thing happening twice is two events, not a duplicate.
  const dupe = kind === "fact" ? scored.find((s) => s.score > DUPLICATE_SCORE) : undefined;
  if (dupe) return { memory: dupe.memory, duplicate: true, related: [], superseded: [] };

  const memory: Memory = {
    id: randomUUID().slice(0, 8),
    text: clean,
    createdAt: new Date().toISOString(),
    tags,
    embedding,
    kind,
    importance: opts.importance ?? "normal",
    ...(opts.occurredAt ? { occurredAt: opts.occurredAt } : {}),
  };

  // Retire whatever this explicitly replaces.
  const superseded: string[] = [];
  for (const id of opts.supersedes ?? []) {
    const old = all.find((m) => m.id === id && isLive(m));
    if (!old) continue;
    old.supersededBy = memory.id;
    old.supersededAt = memory.createdAt;
    superseded.push(id);
  }

  all.push(memory);
  if (superseded.length) await saveAll(all);
  else {
    mkdirSync(dirname(MEMORY_FILE), { recursive: true });
    await appendFile(MEMORY_FILE, JSON.stringify(memory) + "\n", "utf8");
  }

  // Surface close matches so the caller can notice a contradiction it should
  // have superseded. Only the model can judge "replaces" vs "also true".
  const related = scored
    .filter((s) => s.score >= RELATED_SCORE && !superseded.includes(s.memory.id))
    .slice(0, 3);

  return { memory, duplicate: false, related, superseded };
}

export type SearchHit = { memory: Memory; score: number };

export async function searchMemories(
  query: string,
  limit = 5,
  opts: { kind?: MemoryKind | "any"; includeSuperseded?: boolean } = {},
): Promise<SearchHit[]> {
  const all = await load();
  if (!all.length) return [];
  const wantKind = opts.kind ?? "any";
  const pool = all.filter(
    (m) => (opts.includeSuperseded || isLive(m)) && (wantKind === "any" || kindOf(m) === wantKind),
  );
  if (!pool.length) return [];
  const q = await embed(query);
  return pool
    .map((memory) => ({ memory, score: rank(memory, similarity(memory.embedding, q)) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/** All memories, newest first, without the bulky embedding vectors. */
export async function listMemories(): Promise<Omit<Memory, "embedding">[]> {
  const all = await load();
  return all
    .map(({ embedding: _e, ...rest }) => ({ ...rest, kind: rest.kind ?? ("fact" as MemoryKind) }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function forgetMemory(id: string): Promise<boolean> {
  const all = await load();
  const idx = all.findIndex((m) => m.id === id);
  if (idx < 0) return false;
  all.splice(idx, 1);
  await saveAll(all);
  return true;
}

/**
 * Drop superseded records that have been retired for a while. Kept as an
 * explicit action rather than something automatic — silently deleting the user's
 * history to save disk would be a bad trade.
 */
export async function pruneSuperseded(olderThanDays = 0): Promise<number> {
  const all = await load();
  const cutoff = Date.now() - olderThanDays * 86_400_000;
  const keep = all.filter((m) => {
    if (isLive(m)) return true;
    const at = Date.parse(m.supersededAt ?? m.createdAt);
    return Number.isNaN(at) ? true : at > cutoff;
  });
  const removed = all.length - keep.length;
  if (removed) {
    cache = keep;
    await saveAll(keep);
  }
  return removed;
}

export async function memoryStats(): Promise<{ facts: number; episodes: number; superseded: number }> {
  const all = await load();
  return {
    facts: all.filter((m) => isLive(m) && kindOf(m) === "fact").length,
    episodes: all.filter((m) => isLive(m) && kindOf(m) === "episode").length,
    superseded: all.filter((m) => !isLive(m)).length,
  };
}

/**
 * Automatic recall, called on every user turn. FACTS ONLY — injecting past
 * events into every turn would be noise and tokens; episodes are found by
 * searching on purpose. Deliberately tiny: a few short facts, never a dump.
 */
export async function recallRelevant(userText: string): Promise<string | null> {
  try {
    if (userText.trim().length < 4) return null;
    const hits = (await searchMemories(userText, AUTO_RECALL_TOP_K, { kind: "fact" })).filter(
      (h) => h.score >= AUTO_RECALL_MIN_SCORE,
    );
    if (!hits.length) return null;
    const lines = hits.map((h) => `- ${h.memory.text}`).join("\n");
    return `[Things you remembered about the user (from your long-term memory — use if relevant, ignore if not):\n${lines}]`;
  } catch {
    return null; // memory must never break a normal turn
  }
}

/* ------------------------------ MCP tools ------------------------------ */

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
const fail = (e: unknown) => ({
  content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }],
  isError: true,
});

/** Tell the model what it may have just contradicted. */
function relatedNote(related: { memory: Memory; score: number }[]): string {
  if (!related.length) return "";
  const lines = related.map((r) => `  [${r.memory.id}] (${r.score.toFixed(2)}) ${r.memory.text}`).join("\n");
  return (
    `\n\nSimilar things you already knew:\n${lines}\n` +
    `If this new memory REPLACES any of them (they're now wrong or out of date), call remember again ` +
    `with supersedes=[those ids] — or forget them. If they're all still true, do nothing.`
  );
}

const remember = tool(
  "remember",
  "Save a durable fact about the user or their world to long-term memory (preferences, projects, people, decisions, recurring context). Use this whenever the user tells you something worth knowing later. If this fact CORRECTS or REPLACES something you already remember, pass the old ids in `supersedes` so the stale version stops being recalled. Do NOT store secrets, passwords or API keys.",
  {
    text: z.string().describe("The fact, written as a short standalone sentence"),
    tags: z.array(z.string()).optional().describe("Optional labels, e.g. ['preference','project']"),
    importance: z
      .enum(["normal", "high"])
      .optional()
      .describe("'high' for facts that should surface readily, e.g. allergies, hard constraints"),
    supersedes: z
      .array(z.string())
      .optional()
      .describe("Ids of memories this one replaces — they stop being recalled"),
  },
  async ({ text, tags, importance, supersedes }) => {
    try {
      const r = await addMemory(text, tags ?? [], { kind: "fact", importance, supersedes });
      if (r.duplicate) return ok(`Already remembered (id ${r.memory.id}): ${r.memory.text}`);
      const retired = r.superseded.length ? ` Replaced ${r.superseded.join(", ")}.` : "";
      return ok(`Remembered (id ${r.memory.id}): ${r.memory.text}${retired}${relatedNote(r.related)}`);
    } catch (e) {
      return fail(e);
    }
  },
);

const recordEpisode = tool(
  "record_episode",
  "Record something that HAPPENED — a task you did, a problem you solved, an outcome, a decision and why. Use this after finishing something non-trivial, so 'what did we try last time?' is answerable later. Unlike `remember`, episodes are not injected into every turn; they're found by searching. Write enough detail to be useful months from now.",
  {
    summary: z.string().describe("What happened, as a short standalone paragraph"),
    tags: z.array(z.string()).optional().describe("Optional labels, e.g. ['debugging','camera']"),
    occurred_at: z.string().optional().describe("ISO timestamp, if it happened earlier than now"),
  },
  async ({ summary, tags, occurred_at }) => {
    try {
      const r = await addMemory(summary, tags ?? [], { kind: "episode", occurredAt: occurred_at });
      return ok(`Recorded episode (id ${r.memory.id}).`);
    } catch (e) {
      return fail(e);
    }
  },
);

const recall = tool(
  "recall",
  "Search long-term memory. Relevant FACTS are injected automatically each turn, so use this for a deeper search — and especially to look up EPISODES ('what did we do about X?', 'have we hit this before?'), which are never injected automatically.",
  {
    query: z.string().describe("What to look for"),
    kind: z
      .enum(["fact", "episode", "any"])
      .optional()
      .describe("Restrict to durable facts, past events, or search both (default any)"),
    limit: z.number().optional().describe("Max results (default 5)"),
  },
  async ({ query, kind, limit }) => {
    try {
      const hits = await searchMemories(query, limit ?? 5, { kind: kind ?? "any" });
      if (!hits.length) return ok("No matching memories.");
      const text = hits
        .map((h) => {
          const when = new Date(h.memory.occurredAt ?? h.memory.createdAt).toLocaleDateString();
          return `[${h.memory.id}] (${h.score.toFixed(2)}, ${kindOf(h.memory)}, ${when}) ${h.memory.text}`;
        })
        .join("\n");
      return ok(text);
    } catch (e) {
      return fail(e);
    }
  },
);

const forget = tool(
  "forget",
  "Delete a memory by its id (ids are shown by `recall`). Use when a remembered fact is simply wrong. If it's merely OUT OF DATE, prefer `remember` with `supersedes` — that keeps the history.",
  { id: z.string().describe("The memory id to delete") },
  async ({ id }) => {
    try {
      const done = await forgetMemory(id);
      return ok(done ? `Forgot ${id}.` : `No memory with id ${id}.`);
    } catch (e) {
      return fail(e);
    }
  },
);

export const memoryServer = createSdkMcpServer({
  name: "memory",
  version: "0.2.0",
  instructions:
    "Jarvis's long-term memory of the user, stored locally. `remember` saves durable FACTS (injected automatically each turn); `record_episode` saves what HAPPENED (searchable, not injected). When a new fact corrects an old one, pass `supersedes` so the stale version stops surfacing. `recall` searches both kinds; `forget` deletes outright. Never store secrets or credentials.",
  tools: [remember, recordEpisode, recall, forget],
});

export const MEMORY_PATH = MEMORY_FILE;
