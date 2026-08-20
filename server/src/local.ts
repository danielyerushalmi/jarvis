// Local brain — the fallback for when Claude usage runs out.
//
// Deliberately does NOT go through the Claude Agent SDK. Routing the SDK at a
// local model via an Anthropic-compatible proxy was the other option, but
// non-Claude models handle the SDK's tool/agent loop poorly, so it fails in
// confusing ways. Talking to Ollama directly gives an honest, reliable
// degradation: you keep your conversation and your memory, and — when the
// selected model supports it — a safe subset of tools and vision too.
//
// Emits exactly the same WebSocket events as JarvisSession, so the UI needs no
// special handling.
import { addMemory, recallRelevant, searchMemories } from "./memory";
import { getNews, getWeather } from "./briefing";
import { getSystemStats } from "./computer";
import { spotifyNowPlaying, spotifySearchAndPlay, spotifyTransport } from "./spotify";
import { goveeBrightness, goveeColor, goveePower, goveeStatus } from "./govee";

const OLLAMA = process.env.OLLAMA_URL ?? "http://127.0.0.1:11434";

type Send = (event: unknown) => void;
type ImageInput = { mediaType: string; data: string };
type ModelCaps = { tools: boolean; vision: boolean };

const LOCAL_PROMPT = `You are Jarvis, a personal assistant running fully locally on the user's machine.
You are the offline fallback brain: the user's Claude usage is unavailable or being conserved.
You cannot use tools, control the computer, or see images right now — if asked, say so plainly
and offer what you can do instead. Be concise and direct.`;

/** Builds the system prompt to match what the selected model can actually do. */
function buildSystemPrompt(caps: ModelCaps): string {
  if (!caps.tools && !caps.vision) return LOCAL_PROMPT;
  const parts = [
    "You are Jarvis, a personal assistant running fully locally on the user's machine.",
    "You are the offline fallback brain: the user's Claude usage is unavailable or being conserved.",
  ];
  if (caps.tools) {
    parts.push(
      "You have tools available and should call them when useful: remember/recall for long-term memory, " +
        "weather/news for briefings, system_status for machine health, play_music/music_control/now_playing " +
        "for Spotify, and lights_power/lights_brightness/lights_color/lights_status for the Govee LED lights.",
    );
  } else {
    parts.push("You cannot use tools or control the computer right now.");
  }
  if (caps.vision) {
    parts.push("You can see images the user attaches.");
  }
  parts.push("Be concise and direct.");
  return parts.join(" ");
}

export type OllamaModel = { value: string; label: string };

/** Models available from the local Ollama server, prefixed so the UI can route them. */
export async function listOllamaModels(): Promise<OllamaModel[]> {
  try {
    const res = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) return [];
    const body = (await res.json()) as { models?: { name: string }[] };
    return (body.models ?? []).map((m) => ({ value: `ollama:${m.name}`, label: `${m.name} (local)` }));
  } catch {
    return []; // Ollama not running — just don't offer local models
  }
}

export async function ollamaAvailable(): Promise<boolean> {
  return (await listOllamaModels()).length > 0;
}

// Local vision: describe an image with a local multimodal model, so Claude never
// pays image tokens. qwen2.5vl read a test image cleanly and fast; llava was
// worse — override with JARVIS_VISION_MODEL if you prefer another.
const VISION_MODEL = process.env.JARVIS_VISION_MODEL ?? "qwen2.5vl:7b";

export async function localVisionAvailable(): Promise<boolean> {
  const models = await listOllamaModels();
  return models.some((m) => /vl|llava|vision|moondream|minicpm-v/i.test(m.value));
}

/** Ask the local vision model to describe a base64 JPEG. Returns plain text. */
export async function describeImage(base64Jpeg: string, prompt: string): Promise<string> {
  const res = await fetch(`${OLLAMA}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: VISION_MODEL, prompt, images: [base64Jpeg], stream: false }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) throw new Error(`local vision returned ${res.status}`);
  const body = (await res.json()) as { response?: string; error?: string };
  if (body.error) throw new Error(body.error);
  return (body.response ?? "").trim();
}

/* ------------------------------- tool registry ------------------------------- */
//
// A safe subset of Jarvis's tools, reimplemented as a plain registry (name,
// JSON-schema params, executor) instead of MCP `tool()` definitions, since the
// local loop talks to Ollama's /api/chat tool-calling format directly rather
// than going through the Claude Agent SDK.

type LocalToolSpec = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (input: Record<string, unknown>) => Promise<string>;
};

/** Never let a thrown error escape an executor — the model should see it as the tool result. */
async function safely(fn: () => Promise<string>): Promise<string> {
  try {
    return await fn();
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

const LOCAL_TOOLS: LocalToolSpec[] = [
  {
    name: "remember",
    description:
      "Save a durable fact about the user or their world to long-term memory (preferences, projects, people, decisions, recurring context).",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "The fact, written as a short standalone sentence" },
        tags: { type: "array", items: { type: "string" }, description: "Optional labels, e.g. ['preference']" },
      },
      required: ["text"],
    },
    execute: (input) =>
      safely(async () => {
        const { text, tags } = input as { text: string; tags?: string[] };
        const r = await addMemory(text, tags);
        return r.duplicate ? `Already knew that: ${r.memory.text}` : `Remembered: ${r.memory.text}`;
      }),
  },
  {
    name: "recall",
    description: "Search long-term memory for what you know about a topic.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to look for" },
        limit: { type: "number", description: "Max results (default 5)" },
      },
      required: ["query"],
    },
    execute: (input) =>
      safely(async () => {
        const { query, limit } = input as { query: string; limit?: number };
        const hits = await searchMemories(query, limit);
        if (!hits.length) return "No matching memories.";
        return hits.map((h) => `[${h.memory.id}] ${h.memory.text}`).join("\n");
      }),
  },
  {
    name: "weather",
    description:
      "Get current weather and today's forecast. Pass a city name, or leave it blank to use the user's saved home location.",
    parameters: {
      type: "object",
      properties: {
        location: { type: "string", description: "City name, e.g. 'Toronto'. Omit to use the saved location." },
      },
    },
    execute: (input) =>
      safely(async () => {
        const { location } = input as { location?: string };
        return await getWeather(location);
      }),
  },
  {
    name: "news",
    description: "Get the latest news headlines from the user's configured RSS feeds.",
    parameters: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max headlines to return (default 8)" },
      },
    },
    execute: (input) =>
      safely(async () => {
        const { limit } = input as { limit?: number };
        return await getNews(limit);
      }),
  },
  {
    name: "system_status",
    description: "Get CPU load, memory use, and battery level for a quick machine health readout.",
    parameters: { type: "object", properties: {} },
    execute: () =>
      safely(async () => {
        const s = await getSystemStats();
        const bat = s.battery != null ? `${s.battery}%` : "n/a (desktop)";
        return `CPU: ${s.cpu}%\nMemory: ${s.memUsedGb} GB / ${s.memTotalGb} GB\nBattery: ${bat}`;
      }),
  },
  {
    name: "play_music",
    description: "Search Spotify and immediately start playing the first match — a track, album, playlist, or artist.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to search for, e.g. 'Hotel California Eagles'" },
        type: {
          type: "string",
          enum: ["track", "album", "playlist", "artist"],
          description: "What kind of result to play (default track)",
        },
      },
      required: ["query"],
    },
    execute: (input) =>
      safely(async () => {
        const { query, type } = input as { query: string; type?: "track" | "album" | "playlist" | "artist" };
        return await spotifySearchAndPlay(query, type ?? "track");
      }),
  },
  {
    name: "music_control",
    description: "Control Spotify transport: play, pause, next, or previous.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["play", "pause", "next", "previous"] },
      },
      required: ["action"],
    },
    execute: (input) =>
      safely(async () => {
        const { action } = input as { action: "play" | "pause" | "next" | "previous" };
        return await spotifyTransport(action);
      }),
  },
  {
    name: "now_playing",
    description: "Get what's currently playing on Spotify, if anything.",
    parameters: { type: "object", properties: {} },
    execute: () => safely(async () => await spotifyNowPlaying()),
  },
  {
    name: "lights_power",
    description: "Turn the Govee LED lights on or off.",
    parameters: { type: "object", properties: { on: { type: "boolean" } }, required: ["on"] },
    execute: (input) => safely(async () => goveePower(Boolean((input as { on: boolean }).on))),
  },
  {
    name: "lights_brightness",
    description: "Set the Govee LED brightness, 0-100.",
    parameters: { type: "object", properties: { percent: { type: "number" } }, required: ["percent"] },
    execute: (input) => safely(async () => goveeBrightness(Number((input as { percent: number }).percent))),
  },
  {
    name: "lights_color",
    description: "Set the Govee LED colour: a name (blue, warm white), or a hex like #ff8800.",
    parameters: { type: "object", properties: { color: { type: "string" } }, required: ["color"] },
    execute: (input) => safely(async () => goveeColor(String((input as { color: string }).color))),
  },
  {
    name: "lights_status",
    description: "Get the Govee LED lights' current power, brightness, and colour.",
    parameters: { type: "object", properties: {} },
    execute: () => safely(async () => goveeStatus()),
  },
];

const OLLAMA_TOOLS = LOCAL_TOOLS.map((t) => ({
  type: "function",
  function: { name: t.name, description: t.description, parameters: t.parameters },
}));

/* ------------------------------- session ------------------------------- */

type OllamaMsg = {
  role: string;
  content?: string;
  images?: string[];
  tool_calls?: { function: { name: string; arguments: Record<string, unknown> } }[];
  tool_name?: string;
  thinking?: string;
};

export class LocalSession {
  private history: { role: string; content: string; images?: string[] }[] = [];
  private controller: AbortController | null = null;
  private caps: ModelCaps = { tools: false, vision: false };
  private capsPromise: Promise<void>;

  /** @param model an "ollama:<name>" value, or a bare model name */
  constructor(
    private send: Send,
    private model: string,
  ) {
    this.model = model.replace(/^ollama:/, "");
    this.send({ type: "session", sessionId: `local-${Date.now()}`, model: `ollama:${this.model}` });
    this.capsPromise = this.detectCapabilities();
  }

  /** POST /api/show for the current model and cache its tool/vision support. Fails soft. */
  private async detectCapabilities(): Promise<void> {
    try {
      const res = await fetch(`${OLLAMA}/api/show`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: this.model }),
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) {
        this.caps = { tools: false, vision: false };
        return;
      }
      const body = (await res.json()) as { capabilities?: string[] };
      const list = body.capabilities ?? [];
      this.caps = { tools: list.includes("tools"), vision: list.includes("vision") };
    } catch {
      this.caps = { tools: false, vision: false };
    }
  }

  async sendUserMessage(text: string, images: ImageInput[] = []) {
    await this.capsPromise;
    // Memory still works offline — it's all local anyway.
    const recalled = await recallRelevant(text);
    let content = recalled ? `${recalled}\n\n${text}` : text;
    let attachImages: string[] | undefined;
    if (images.length) {
      if (this.caps.vision) {
        attachImages = images.map((img) => img.data);
      } else {
        content += "\n\n[The user attached an image, but the local model cannot see images.]";
      }
    }
    this.history.push(attachImages ? { role: "user", content, images: attachImages } : { role: "user", content });
    await this.run();
  }

  injectTurn(text: string, label = "scheduled task") {
    this.send({ type: "proactive", label });
    this.history.push({ role: "user", content: text });
    void this.run();
  }

  async setModel(model: string) {
    this.model = model.replace(/^ollama:/, "");
    this.send({ type: "model", model: `ollama:${this.model}` });
    this.capsPromise = this.detectCapabilities();
  }

  interrupt() {
    this.controller?.abort();
  }

  // Local brain's tool loop runs without interactive approval — nothing to resolve.
  resolvePermission() {}

  close() {
    this.controller?.abort();
  }

  private async run() {
    this.controller = new AbortController();
    try {
      await this.capsPromise;
      if (this.caps.tools) {
        await this.runWithTools();
      } else {
        await this.runStreaming();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/abort/i.test(msg)) {
        this.send({ type: "error", error: `Local model: ${msg}. Is Ollama running? (${OLLAMA})` });
      }
    } finally {
      this.send({ type: "turn_end" });
      this.controller = null;
    }
  }

  /** Existing behavior: streaming, no tools, used whenever the model doesn't support tool calling. */
  private async runStreaming(): Promise<void> {
    let full = "";
    const res = await fetch(`${OLLAMA}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        messages: [{ role: "system", content: buildSystemPrompt(this.caps) }, ...this.history],
        stream: true,
      }),
      signal: this.controller!.signal,
    });
    if (!res.ok || !res.body) throw new Error(`Ollama returned ${res.status}`);

    // Ollama streams newline-delimited JSON.
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const chunk = JSON.parse(line) as { message?: { content?: string }; done?: boolean };
          const piece = chunk.message?.content;
          if (piece) {
            full += piece;
            this.send({ type: "assistant_delta", text: piece });
          }
        } catch {
          /* partial line — ignore */
        }
      }
    }

    this.history.push({ role: "assistant", content: full });
    if (full) this.send({ type: "assistant", text: full, tools: [] });
    this.send({ type: "result", subtype: "success", result: full, costUsd: 0 });
  }

  /** Non-streaming tool-calling loop, used when the selected model advertises "tools" support. */
  private async runWithTools(): Promise<void> {
    const messages: OllamaMsg[] = [
      { role: "system", content: buildSystemPrompt(this.caps) },
      ...this.history.map((h) => (h.images ? { role: h.role, content: h.content, images: h.images } : { role: h.role, content: h.content })),
    ];

    const MAX_ITERATIONS = 6;
    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const res = await fetch(`${OLLAMA}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.model, messages, tools: OLLAMA_TOOLS, stream: false }),
        signal: this.controller!.signal,
      });
      if (!res.ok) throw new Error(`Ollama returned ${res.status}`);
      const body = (await res.json()) as { message?: OllamaMsg };
      const message = body.message;
      if (!message) throw new Error("Ollama returned an empty response");

      const toolCalls = message.tool_calls ?? [];
      if (toolCalls.length) {
        const tools = toolCalls.map((tc, idx) => ({
          id: `local-${Date.now()}-${idx}`,
          name: tc.function.name,
          input: tc.function.arguments,
        }));
        this.send({ type: "assistant", text: message.content || "", tools });

        messages.push(message);
        for (const tc of toolCalls) {
          const spec = LOCAL_TOOLS.find((t) => t.name === tc.function.name);
          const result = spec ? await spec.execute(tc.function.arguments) : `Error: unknown tool "${tc.function.name}"`;
          messages.push({ role: "tool", content: result, tool_name: tc.function.name });
        }
        continue;
      }

      // No tool calls — this is the final answer.
      const content = message.content ?? "";
      this.history.push({ role: "assistant", content });
      this.send({ type: "assistant", text: content, tools: [] });
      this.send({ type: "result", subtype: "success", result: content, costUsd: 0 });
      return;
    }

    // Exceeded the iteration budget without a final answer — don't leave the turn hanging.
    const fallback = "I made several tool calls but couldn't wrap up a final answer — let me know if you'd like me to keep going.";
    this.history.push({ role: "assistant", content: fallback });
    this.send({ type: "assistant", text: fallback, tools: [] });
    this.send({ type: "result", subtype: "success", result: fallback, costUsd: 0 });
  }
}
