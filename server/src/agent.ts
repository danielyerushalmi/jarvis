// One JarvisSession per browser connection. Holds a long-lived Agent SDK query()
// in streaming-input mode and relays SDK messages to the browser as JSON events.
import {
  query,
  type Query,
  type SDKUserMessage,
  type SDKMessage,
  type PermissionResult,
} from "@anthropic-ai/claude-agent-sdk";
import { computerServer } from "./computer";
import { memoryServer, recallRelevant } from "./memory";
import { proactiveServer } from "./proactive";
import { briefingServer } from "./briefing";
import { watcherServer } from "./watchers";
import { spotifyServer } from "./spotify";
import { goveeServer } from "./govee";
import { externalMcpServers } from "./mcp-external";
import { skillPlugins } from "./skills";
import { assessRisk } from "./policy";

// Events we send TO the browser.
export type OutEvent =
  | { type: "session"; sessionId: string; model: string }
  | { type: "models"; models: { value: string; label: string }[]; current: string }
  | { type: "model"; model: string }
  | { type: "proactive"; label: string }
  | { type: "assistant"; text: string; tools: ToolCall[] }
  | { type: "assistant_delta"; text: string }
  | { type: "result"; subtype: string; result?: string; costUsd?: number }
  | { type: "permission_request"; id: string; toolName: string; input: unknown; reason?: string; title?: string; displayName?: string; description?: string }
  | { type: "error"; error: string }
  | { type: "turn_end" };

type ToolCall = { id: string; name: string; input: unknown };
type Send = (event: OutEvent) => void;
/** A base64 image (no data: prefix) to attach to a user turn. */
export type ImageInput = { mediaType: string; data: string };

// Minimal push-based async queue backing the streaming-input generator.
class AsyncQueue<T> {
  private items: T[] = [];
  private resolvers: ((r: IteratorResult<T>) => void)[] = [];
  private ended = false;

  push(item: T) {
    const r = this.resolvers.shift();
    if (r) r({ value: item, done: false });
    else this.items.push(item);
  }
  end() {
    this.ended = true;
    let r: ((x: IteratorResult<T>) => void) | undefined;
    while ((r = this.resolvers.shift())) r({ value: undefined as never, done: true });
  }
  async *iterable(): AsyncGenerator<T> {
    while (true) {
      const next = this.items.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.ended) return;
      const result = await new Promise<IteratorResult<T>>((res) => this.resolvers.push(res));
      if (result.done) return;
      yield result.value;
    }
  }
}

// Tools we auto-approve (read-only / safe). Everything else routes through the
// browser approval flow via canUseTool.
// Memory reads/writes are low-risk and frequent, so they run without prompting.
// `forget` is deliberately NOT here — deleting a memory should be confirmed.
// Appended to Claude Code's built-in system prompt. The memory instruction is
// load-bearing: without it the model says "I'll remember that" and never calls
// the tool (observed).
const JARVIS_PROMPT = `You are Jarvis, a personal AI assistant running on the user's own machine.

LONG-TERM MEMORY — important:
You have a persistent memory that survives across sessions, via the \`remember\`,
\`recall\` and \`forget\` tools.
- When the user tells you something durable about themselves or their world — a
  preference, an ongoing project, a person, a decision, a constraint, a routine —
  you MUST actually CALL the \`remember\` tool. Saying "I'll remember that" without
  calling the tool is a failure: nothing is saved.
- Call \`remember\` silently as part of your reply; don't make a fuss about it.
- When something you're told CORRECTS what you already knew (they moved, changed
  jobs, changed their mind), pass the old ids in \`supersedes\` — otherwise both
  versions keep coming back and you'll contradict yourself later.
- After finishing something non-trivial, call \`record_episode\` so "what did we
  try last time?" is answerable. Episodes aren't injected automatically; they're
  found with \`recall\`.
- Memories relevant to the current message are injected automatically at the top of
  the user's turn. Use them naturally, as if you simply knew them. If a bracketed
  memory block appears, do not quote it back or mention that it was injected.
- Use \`recall\` when you need to search your memory more deeply than what was
  injected.
- Never store secrets, passwords, API keys or payment details.

SEEING — you have real vision:
- When the user's camera (the "eye") is on, EVERY message they send carries a fresh frame
  from their webcam as an attached image. When they drop a photo or screenshot onto the
  window, it arrives the same way. Treat any attached image as YOUR OWN live vision.
- So: you CAN see through their webcam and you CAN see images they share. Never say you
  "don't have access to a webcam" or "can't see images" — if an image is attached, describe
  what's actually in it, naturally ("I can see you're holding…", "looks like…").
- If they ask what you see but NO image is attached, that just means the camera is off — tell
  them to click the 📷 (eye) so a frame rides along with their next message.
- (Separately, to look at their SCREEN — not the camera — use the screen tools below.)

OPERATING APPS — you really can drive this machine:
- **Prefer a protocol URI or a keyboard shortcut over clicking.** They're faster and
  far more reliable than hunting for pixels. e.g. \`launch_app("spotify:search:hot wind blows")\`
  opens Spotify straight to that search; \`press_keys\` can drive menus and media keys.
- Unsure of an app's name? \`list_apps\` first. \`launch_app\` takes friendly names
  ("Spotify", "Discord") and resolves Start-menu and Store apps.
- For anything genuinely visual: \`screenshot\`, read the coordinates off that image
  and pass them straight to \`mouse\` — the coordinates you read off the screenshot are
  mapped to the real screen for you, so you never need to guess or rescale. Take a fresh
  screenshot right before you click so the coordinates match what's on screen now.
- **Give an app a second or two to load before screenshotting**, or you'll act on a
  splash screen.
- **Verify.** After acting, take another screenshot (or \`read_screen_text\`) and
  confirm it actually worked. Never report success you haven't checked.
- **Looking at the screen — cheapest first, to save the user's usage:**
  1. \`read_screen_text\` — reading text (errors, docs, forms). Local OCR, zero image tokens.
  2. \`describe_screen\` — general "what's on my screen / what am I looking at". A LOCAL
     vision model describes it; costs you zero image tokens. Use this by default.
  3. \`screenshot\` — only when you need exact pixel coordinates to click, or fine visual
     detail. This sends real pixels to you and is the most expensive option.

Be concise and direct. You have real control over this machine, so state plainly
what you did — and equally plainly when something didn't work.`;

// Intentionally EMPTY. Anything listed here bypasses `canUseTool` entirely, and
// we want every call to reach the policy so it can inspect the actual command.
// `policy.ts` allows by default and only stops for genuinely destructive things.
const AUTO_ALLOWED: string[] = [];

export class JarvisSession {
  private queue = new AsyncQueue<SDKUserMessage>();
  private q: Query;
  private pending = new Map<string, { resolve: (r: PermissionResult) => void; input: Record<string, unknown> }>();
  private currentModel = "claude-opus-4-8";

  /** Extra models to advertise alongside Claude's (e.g. local Ollama brains). */
  private extraModels: { value: string; label: string }[] = [];

  constructor(
    private send: Send,
    opts: { cwd?: string; resume?: string; extraModels?: { value: string; label: string }[] } = {},
  ) {
    this.extraModels = opts.extraModels ?? [];
    this.q = query({
      prompt: this.queue.iterable(),
      options: {
        cwd: opts.cwd,
        resume: opts.resume,
        model: "claude-opus-4-8",
        systemPrompt: { type: "preset", preset: "claude_code", append: JARVIS_PROMPT },
        includePartialMessages: true,
        permissionMode: "default",
        allowedTools: AUTO_ALLOWED,
        // Skills: procedures as markdown, loaded on demand. See skills.ts.
        // `settingSources` is deliberately left alone so the CLI's own settings
        // and CLAUDE.md discovery keep working exactly as before.
        plugins: skillPlugins(),
        // Computer control lives here. It is NOT in AUTO_ALLOWED, so every call
        // reaches canUseTool → assessRisk, which decides: destructive commands
        // (see policy.ts) surface the Approve/Deny modal, everything else runs.
        // Note this means routine clicks/keystrokes run WITHOUT a prompt — the
        // gate is on danger, not on computer control as a category.
        // In-process servers (ours) first, then anything the user configured in
        // ~/.jarvis/mcp.json. Adding a server to this object means adding its
        // name to BUILT_IN_MCP_SERVERS in mcp-external.ts, or policy.ts will
        // treat it as untrusted third-party code and flag its ordinary calls.
        mcpServers: {
          computer: computerServer,
          memory: memoryServer,
          proactive: proactiveServer,
          briefing: briefingServer,
          watcher: watcherServer,
          spotify: spotifyServer,
          govee: goveeServer,
          ...externalMcpServers(),
        },
        canUseTool: this.canUseTool.bind(this),
      },
    });
    void this.pump();
    // Populate the model selector immediately on connect. The CLI may not be up
    // for the first attempt, so retry briefly rather than waiting for the first
    // turn's system-init (which is why the dropdown used to appear only after
    // you'd already sent a message).
    void this.sendModelsWithRetry();
  }

  private async sendModelsWithRetry(attempts = 6) {
    for (let i = 0; i < attempts; i++) {
      if (await this.sendModels()) return;
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  // Text, optionally with images (camera frames / screenshots) so Jarvis can see.
  // Relevant long-term memories are looked up locally (no tokens) and quietly
  // prepended, so the user doesn't have to re-explain themselves.
  async sendUserMessage(text: string, images: ImageInput[] = []) {
    const recalled = await recallRelevant(text);
    if (recalled) text = `${recalled}\n\n${text}`;
    let content: unknown = text;
    if (images.length) {
      // ORDER MATTERS: the text block must come FIRST, before the images.
      // With the image blocks leading, the CLI drops them entirely and the model
      // answers as though nothing were attached — which looked exactly like "the
      // camera is off". Verified with a four-colour-band probe through the real
      // WebSocket: images-then-text => "NO_IMAGE", text-then-image => read
      // correctly. Don't "tidy" this back into a .map() that appends the text.
      const blocks: unknown[] = [{ type: "text", text: text || "What do you see?" }];
      for (const img of images) {
        blocks.push({
          type: "image",
          source: { type: "base64", media_type: img.mediaType, data: img.data },
        });
      }
      content = blocks;
    }
    this.queue.push({
      type: "user",
      message: { role: "user", content } as never,
      parent_tool_use_id: null,
    });
  }

  /**
   * Push a turn Jarvis wasn't asked for (a fired reminder, a watcher event).
   * No memory recall here — this isn't the user speaking.
   */
  injectTurn(text: string, label = "scheduled task") {
    // Tell the UI this turn wasn't typed by the user, so the reply that follows
    // doesn't appear out of nowhere.
    this.send({ type: "proactive", label });
    this.queue.push({
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
    });
  }

  async setModel(model: string) {
    try {
      await this.q.setModel(model);
      this.currentModel = model;
      this.send({ type: "model", model });
    } catch (err) {
      this.send({ type: "error", error: `Couldn't switch model: ${err instanceof Error ? err.message : String(err)}` });
    }
  }

  async interrupt() {
    try {
      await this.q.interrupt();
    } catch {
      /* nothing running to interrupt — non-fatal */
    }
  }

  /** Returns true once the model list was actually delivered. */
  private async sendModels(): Promise<boolean> {
    try {
      const models = await this.q.supportedModels();
      if (!models?.length) return false;
      this.send({
        type: "models",
        models: [
          ...models.map((m) => ({ value: m.value, label: m.displayName || m.value })),
          ...this.extraModels,
        ],
        current: this.currentModel,
      });
      return true;
    } catch {
      return false; // CLI not up yet, or doesn't support supportedModels()
    }
  }

  resolvePermission(id: string, approved: boolean, denyMessage?: string) {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    entry.resolve(
      approved
        ? { behavior: "allow", updatedInput: entry.input }
        : { behavior: "deny", message: denyMessage ?? "You declined this action." },
    );
  }

  close() {
    // Reject any outstanding permission prompts so the agent process can unwind.
    for (const [id] of this.pending) this.resolvePermission(id, false, "Session closed.");
    this.queue.end();
    void this.q.return?.(undefined);
  }

  private canUseTool(
    toolName: string,
    input: Record<string, unknown>,
    options: { toolUseID: string; title?: string; displayName?: string; description?: string },
  ): Promise<PermissionResult> {
    // Default-allow. Only genuinely destructive calls interrupt the user.
    const risk = assessRisk(toolName, input);
    if (!risk.dangerous) {
      return Promise.resolve({ behavior: "allow", updatedInput: input });
    }

    return new Promise<PermissionResult>((resolve) => {
      const id = options.toolUseID;
      this.pending.set(id, { resolve, input });
      this.send({
        type: "permission_request",
        id,
        toolName,
        input,
        reason: risk.reason,
        title: options.title,
        displayName: options.displayName,
        description: options.description,
      });
    });
  }

  private async pump() {
    try {
      for await (const message of this.q) this.relay(message);
    } catch (err) {
      this.send({ type: "error", error: err instanceof Error ? err.message : String(err) });
      // The loop has exited, so no `result` — and therefore no `turn_end` — can
      // ever follow. Send one, or the UI sits on "thinking" forever with its
      // composer disabled and no way out but a reload.
      this.send({ type: "turn_end" });
    }
  }

  private relay(message: SDKMessage) {
    if (message.type === "system" && message.subtype === "init") {
      const model = (message as any).model ?? this.currentModel;
      this.currentModel = model;
      this.send({ type: "session", sessionId: message.session_id, model });
      void this.sendModels();
      return;
    }
    if (message.type === "stream_event") {
      // Token-by-token text from the top-level assistant only (ignore subagent
      // deltas and thinking deltas).
      if (message.parent_tool_use_id) return;
      const ev: any = message.event;
      if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta") {
        this.send({ type: "assistant_delta", text: ev.delta.text });
      }
      return;
    }
    if (message.type === "assistant") {
      const blocks = (message as any).message?.content ?? [];
      const text = blocks
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        .join("");
      const tools: ToolCall[] = blocks
        .filter((b: any) => b.type === "tool_use")
        .map((b: any) => ({ id: b.id, name: b.name, input: b.input }));
      if (text || tools.length) this.send({ type: "assistant", text, tools });
      return;
    }
    if (message.type === "result") {
      this.send({
        type: "result",
        subtype: (message as any).subtype,
        result: "result" in message ? (message as any).result : undefined,
        costUsd: (message as any).total_cost_usd,
      });
      this.send({ type: "turn_end" });
      return;
    }
  }
}
