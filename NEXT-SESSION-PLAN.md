# JARVIS — Next-Session Build Plan

Goal for the next session(s): take the working v1 as close to the "real" Jarvis as
possible — voice conversation, camera + screen vision, control of the computer, and
the ability to swap brains (local model / other LLM) when the Claude subscription
runs low, while **still running mainly on the Claude subscription**.

Read this whole file first, then **run the Verification Spikes (Section 8) before
committing to any design** — several features below depend on facts we should
confirm from the installed SDK rather than assume.

---

## 0. Progress log

### Session 2 (partial — done with ~35% of a session)

**Shipped:**
- **Model switching (Phase B, Tier 1) — DONE & VERIFIED.** Backend `setModel()` +
  `supportedModels()` + `interrupt()` wired through the WebSocket (`set_model`,
  `interrupt` messages); header now has a **model dropdown** populated from the real
  model list. Verified via a WS probe: the switch is confirmed server-side.
- **Voice (Phase A) — BUILT, needs your ears.** `web/src/voice.ts` adds:
  - **TTS**: Jarvis speaks assistant replies **sentence-by-sentence as they stream**
    (not after the full message), with markdown stripped so it doesn't read "asterisk".
    A 🔊/🔇 toggle in the header (**off by default**).
  - **STT**: a 🎤 **push-to-talk mic button** — click, speak, and the transcript is
    sent as a turn. Live interim transcript shows in a "listening" bar.
  - **Barge-in**: sending/speaking a new message cancels Jarvis mid-sentence; a **Stop**
    button interrupts the running turn via the SDK's `interrupt()`.
- Both sides type-check clean.

- **Voice confirmed working by the user** (mic tested in real Chrome). ✅
- **Camera / vision (Phase C) — DONE & VERIFIED.** `web/src/camera.ts` +
  a 📷 toggle in the composer. When the camera is on, **every message you send
  carries the current webcam frame** as an image block (downscaled to 1024px JPEG to
  keep tokens sane), with a mirrored corner preview so you always know when Jarvis can
  see, and a 📷 marker on messages that included a frame.
  **Verified**: generated a PNG containing the word "PELICAN", sent it through the
  real WS path, and the model replied `PELICAN` — so **the SDK does accept image
  blocks in streaming input**.

**Key finding — don't hardcode model IDs.** `supportedModels()` returns *aliases*, not
full model strings. The real list on this subscription:
`default` (recommended) · `sonnet` · `claude-fable-5[1m]` (Fable) · `opus` · `haiku`.
Use `setModel("haiku")` etc. **Fable is available too** — worth exposing/trying.

- **Computer control (Phase D) — DONE & USER-VERIFIED** (user asked it to open
  YouTube; it launched correctly through the approval gate).
  `server/src/computer.ts` is an **in-process MCP server** (`createSdkMcpServer` +
  `tool`, Zod schemas) registered in `agent.ts` as `mcpServers: { computer }`. Tools:
  `screenshot`, `list_windows`, `focus_window`, `launch_app`, `type_text`,
  `press_keys`, `mouse` (move/left/right/double), `clipboard_read`,
  `clipboard_write`, `system_status`. **None are in `AUTO_ALLOWED`**, so every call
  raises the Approve/Deny modal.
  - Verified in isolation: screen capture produces a 264 KB JPEG; SendKeys +
    P/Invoke (mouse/foreground-window) load fine; process/clipboard/system queries
    work; `tsc` clean.
  - End-to-end confirmed by the user (`launch_app`). Worth a quick check next session
    that `screenshot` + `mouse`/`type_text` also behave, since those weren't the ones
    exercised.

**⚠️ Antivirus finding (important, cost me a rewrite):** Windows Defender's **AMSI
blocks PowerShell screen capture** (`Graphics.CopyFromScreen`) as infostealer
behaviour — confirmed in `Get-MpThreatDetection`. Do **not** try to evade it. The
working approach is the `screenshot-desktop` package's native helper — but its
bundled `.bat` launcher calls the exe by bare name and fails with
"not recognized", so `computer.ts` **invokes the extracted `.exe` directly**.
Everything else (SendKeys, P/Invoke, WMI) is fine from PowerShell.

**🎤 BROWSER FINDING — voice input needs rebuilding for the user's actual browser.**
The user's daily driver is **Zen Browser (Firefox-based)**. **Firefox exposes no
`SpeechRecognition` API**, so the Web Speech API mic can never work there (Brave
blocks it too; it is Chromium-only, and additionally requires a secure context —
`localhost` yes, a bare LAN IP no). The mic button now renders **disabled with a
visible reason** (`sttDiagnosis()` in `web/src/voice.ts`) instead of silently
vanishing. **TTS is unaffected** — Firefox supports `speechSynthesis`, so Jarvis can
still *speak* in Zen; it just can't *listen*.

→ **RESOLVED — local Whisper STT shipped.** The Web Speech API path was **replaced
entirely** (one code path for all browsers):
- `web/src/stt.ts` — `MediaRecorder` captures audio, then the **Web Audio API decodes
  and resamples to 16 kHz mono WAV in the browser**, so the server needs no ffmpeg.
- `server/src/stt.ts` — **Whisper via transformers.js/ONNX** (`Xenova/whisper-tiny.en`
  by default; set `JARVIS_WHISPER_MODEL=Xenova/whisper-base.en` for more accuracy).
  Prebuilt ONNX binaries → **no native build step**. Model is preloaded at boot.
- `POST /stt` on the backend (+ a `/stt` Vite proxy) returns `{ text }`.
- **Verified**: synthesized a speech WAV, posted it through the Vite proxy, got back
  `"Jarvis, open the calculator and tell me the weather."` in **~0.9 s**.
- Runs **fully offline, costs zero tokens**, and works in Zen/Firefox/any browser.
- `voice.ts` is now **TTS only** (`speechSynthesis` works in Firefox). The old
  `Recognizer` / `sttSupported` / `sttDiagnosis` / SpeechRecognition typings were
  **deleted**, along with other dead code found in a sweep: the never-emitted
  `{type:"tool"}` event (both sides), unused `lastCostUsd` plumbing, and
  `isCameraOn`. Both projects type-check and build clean.

This also puts the **wake word** within reach and makes voice usable from a phone on
the LAN.

**Still open (next up):** cross-browser STT (above), screen-vision polish (downscale
screenshots — a 1080p grab is ~2.7k tokens per look), the local-model fallback, wake
word, and the ambient/HUD layer.

---

## 1. Where v1 stands (already built + verified)

Working today (see `README.md`):
- Local **Node backend** (`server/`, Fastify + WebSocket) running one long-lived
  **Claude Agent SDK** `query()` in **streaming-input mode**; **React browser UI**
  (`web/`, Vite).
- Runs on the **Claude subscription with no API key** (Agent SDK uses the bundled
  Claude Code login). Model: `claude-opus-4-8`.
- Token-by-token streaming, a **tool-activity strip**, an **Approve/Deny modal**
  (`canUseTool`: reads auto-approved, Write/Edit/Bash gated), **session persistence
  + resume**, and **markdown rendering**.

Key files to know:
- `server/src/agent.ts` — `JarvisSession`: the SDK `query()`, options, `canUseTool`,
  message→event relay. **This is where most backend additions plug in.**
- `server/src/index.ts` — WebSocket server, `resume` query param, workspace cwd.
- `web/src/useJarvis.ts` — WS client + state (streaming buffer, tools, permission,
  persistence). `web/src/App.tsx` — UI. `web/src/types.ts` — shared event union.

Gotcha already fixed: `tsx watch` thrashes in the OneDrive folder → dev script uses
plain `tsx`. Keep it that way (or move the repo out of OneDrive).

---

## 2. Target architecture (the shape after these additions)

```
 Browser (web/)                         Backend (server/)                     Local services
 ─────────────                          ─────────────────                     ──────────────
 • mic → STT ───────────► user text ──► JarvisSession (Agent SDK query)
 • camera → frames ─────► image blocks ─►  ├─ canUseTool  (approval gate)
 • assistant text ──────► TTS (speak)      ├─ mcpServers:
 • HUD / reactor orb                       │    • computer-control (in-proc, nut.js)
 • brain selector                          │    • (optional) home/IoT, etc.
        ▲                                  └─ BrainRouter ─────────────────►  • Claude sub (default)
        └──────────── WebSocket ───────────────────────────────────────────►  • local proxy → Ollama / other
```

New backend pieces: a **computer-control MCP server**, a **BrainRouter** (chooses
Claude tier vs local/other and restarts the query with the right config), and
**vision input** plumbing (images in user messages). New browser pieces: **voice**
(STT in / TTS out), **camera capture**, **brain selector**, and a **Jarvis HUD**.

---

## 3. Phase A — Voice (talk to it, hear it back)

**Outcome:** hold a spoken conversation — say "Hey Jarvis…", it replies out loud,
you can interrupt it by speaking.

- **TTS (Jarvis speaks) — start browser-native, upgrade later.**
  - v1: **Web Speech API `speechSynthesis`** in the browser. Speak assistant text
    **sentence-by-sentence as it streams** (buffer on `.`/`?`/`!`), not after the
    full message, so it feels live. Pick a low, steady system voice.
  - Upgrade path (better "Jarvis voice"): **ElevenLabs** or **OpenAI TTS** (API) or
    a **local Piper voice** (offline, free). Backend generates audio, streams MP3/PCM
    chunks over WS, browser plays them. Do this once the loop feels right.
- **STT (Jarvis listens).**
  - v1: **Web Speech API `SpeechRecognition`** (Chrome — you use Chrome). Continuous
    mode; on a final transcript, send it as a `user_message`.
  - Upgrade path: **local Whisper** (`whisper.cpp` / `faster-whisper`) or Deepgram for
    accuracy + offline. Backend receives audio, returns transcript.
- **Wake word ("Hey Jarvis").**
  - v1: keep `SpeechRecognition` listening; trigger when the transcript starts with
    "jarvis". Cheap, slightly hacky.
  - Upgrade path: **Picovoice Porcupine** (free tier, WASM in browser or Node) for a
    real always-on wake word with low CPU.
- **Barge-in / interrupt:** when the user starts speaking while Jarvis is talking,
  cancel `speechSynthesis` and call the SDK query's **`interrupt()`** (verify method
  name on the `Query` object — Section 8) to stop the current turn.
- **UI:** mic button + live "listening/speaking" state on the reactor orb (Phase E).

Plug points: browser `useJarvis` gains a mic/tts layer; backend needs a
`session.interrupt()` passthrough and (for upgraded TTS/STT) audio WS message types.

---

## 4. Phase B — Brains (model swapping; local fallback) — DO THE SPIKE EARLY

This is the insurance against running out of Claude usage, and the **biggest
unknown**. Ship it in tiers, easiest first.

- **Tier 1 (zero risk, do first): swap Claude tiers to stretch usage.**
  Streaming-input mode exposes **`query.setModel(...)`**. Add a selector for
  `claude-opus-4-8` / `claude-sonnet-4-6` / `claude-haiku-4-5`. Dropping to Haiku/
  Sonnet for routine turns conserves the subscription. Default stays Opus.
- **Tier 2 (the real ask): local model / other LLM.** The Agent SDK is Claude-only,
  so route through an **Anthropic-compatible proxy**:
  - Point the SDK at a proxy via **`ANTHROPIC_BASE_URL`** (+ a dummy key) that speaks
    the Anthropic Messages API and is backed by a local or third-party model.
  - Candidate proxies: **`claude-code-router`** (purpose-built to route Claude Code to
    other backends incl. Ollama/OpenAI) or **LiteLLM proxy** (Anthropic-in →
    OpenAI/Ollama-out). **Spike both; pick one.**
  - Local model host: **Ollama** (e.g. `qwen2.5-coder`, `llama3.x`) or LM Studio.
  - **Reality check to verify in the spike:** non-Claude models often handle the
    Agent SDK's tool-use/agent-loop poorly. Expect the local brain to be **chat-first
    with limited/degraded tools**. That's acceptable as a "keep talking when Claude is
    out" mode. If tool use is too broken through the proxy, fall back to a **direct
    Ollama/OpenAI runtime** (bypass the SDK; simpler manual loop, fewer/no tools) for
    non-Claude brains, and keep the full SDK experience for Claude only.
- **Switching mechanism:** env like `ANTHROPIC_BASE_URL` and subscription-login are
  chosen at query start, so a brain switch = **tear down the current `query()` and
  start a new `JarvisSession` with the chosen config**, resuming the same transcript
  where possible. Add a `brain` field to session config + a WS `set_brain` message.
- **Auto-fallback:** we already relay `error` events. Detect usage-limit / rate-limit
  errors (match the message/type) and either auto-switch to the local brain or prompt
  "Claude's out — switch to local?" Persist the choice.
- **UI:** a **brain selector** in the header (Claude Opus/Sonnet/Haiku · Local · Other)
  with the active brain shown; a small "on subscription / on local" indicator.

> Recommendation: **subscription-Claude stays the default and primary brain.** Local/
> other is explicit fallback. Build Tier 1 first (immediate usage savings), then spike
> Tier 2.

---

## 5. Phase C — Vision (camera + screen)

**Outcome:** "What am I looking at?" (camera) and "What's on my screen / help with
this error" (screenshot).

- **Camera capture (browser):** `navigator.mediaDevices.getUserMedia({video:true})`
  → draw a frame to `<canvas>` → export base64 JPEG. A **camera toggle** (privacy:
  off by default, local only, clear on-air indicator). Send a frame on demand
  ("look at this") or on a low interval for ambient awareness.
- **Feeding images to the agent:** include an **image content block** in the
  streaming-input user message:
  `{type:"user", message:{role:"user", content:[{type:"image", source:{type:"base64", media_type:"image/jpeg", data:"..."}}, {type:"text", text:"..."}]}}`.
  **Verify the Agent SDK accepts image blocks in streaming input** (Section 8) —
  `MessageParam` supports it, but confirm the SDK passes it through.
- **Screen vision:** reuse the computer-control MCP's `screenshot` (Phase D) as the
  image source — "what's on my screen" = screenshot → image block → ask.
- **Presence / ambient awareness (no LLM cost):** run **face-api.js** or **MediaPipe**
  in the browser to detect a face → Jarvis greets you when you sit down, dims when
  you leave. Cheap, no tokens.

---

## 6. Phase D — Computer control (the powerful one)

**Outcome:** Jarvis can see the screen, move the mouse, type, launch apps, manage
windows, adjust volume/brightness — all **behind the approval modal**.

- **Build an in-process MCP server** exposing computer-control tools, and register it
  in `agent.ts` via the SDK's `mcpServers` option. Verify the SDK's in-process tool
  API — likely **`createSdkMcpServer` + `tool()`** exports (Section 8); if not
  available, run it as an **external stdio MCP server** (separate Node process).
- **Automation lib:** **nut.js** (`@nut-tree-fork/nut-js` / `@nut-tree/nut-js`) for
  mouse, keyboard, screen; **`screenshot-desktop`** as a screenshot fallback. Windows-
  compatible.
- **Tools to expose:** `screenshot`, `mouse_move`, `mouse_click`, `type_text`,
  `press_keys`, `launch_app` (PowerShell `Start-Process`), `focus_window` /
  `list_windows`, `set_volume`, `set_brightness`, `clipboard_read` / `clipboard_write`.
- **Safety (critical):** every mutating computer-control tool goes through
  `canUseTool` → the Approve/Deny modal (it already does this for non-allowlisted
  tools). Keep them **out** of the auto-allow list. Consider a per-tool "always allow
  for this session" and a global kill switch. These tools can do real damage — gate
  hard, log every call.
- **Anthropic "computer use":** as an alternative to hand-rolled tools, evaluate
  whether the Agent SDK exposes Claude's native computer-use loop (screenshot+actions).
  If it does and works locally, prefer it; otherwise the custom MCP above is the path.

---

## 7. Phase E — Ambient Jarvis + the "other things"

Pick freely — this is the "make it feel real" layer.

- **Persistent long-term memory:** let Jarvis remember across sessions. Use the SDK's
  **memory tool** and/or a project `CLAUDE.md` / a small notes file it reads+writes:
  "remember that I…", morning recall, preferences. (Design: one durable memory dir the
  agent owns.)
- **Proactive & scheduled:** morning briefing (weather + calendar + news), reminders,
  "watch this folder and tell me when X", periodic status. Use a backend scheduler
  (node-cron) that injects a user message, or Claude Code's scheduling tools.
- **System awareness/control:** CPU/RAM/battery/network HUD; "close all Chrome
  windows", "what's using my CPU", mute, do-not-disturb, lock screen.
- **Integrations via MCP** (several are already available in this environment):
  **Gmail / Google Calendar / Google Drive** (triage inbox, "what's on my calendar",
  find a file), **Spotify** ("play my focus playlist", skip, volume), weather, news.
- **Screen/clipboard helpers:** "summarize what I just copied", OCR a screenshot,
  "explain this error on my screen".
- **Desktop notifications** for proactive alerts (node-notifier / browser
  Notifications API).
- **The Jarvis HUD (make it cinematic):** an animated **arc-reactor orb / waveform**
  that idles, pulses while listening, and ripples while speaking; a HUD with time +
  system stats; smooth transitions. Use the **`anime.js`**, **`three-js-scroll`**, or
  **`lusion`** skills for a genuinely premium, "alive" feel instead of a plain chat.
- **Personas/modes:** "focus mode", "briefing mode", a consistent voice + name.
- **Barge-in + always-listening** (from Phase A) for hands-free operation.
- **Autonomy:** for big asks, let it spawn **subagents** (the SDK supports `agents`)
  and report back — a mini "team" Jarvis coordinates.

---

## 8. Verification spikes — RUN THESE FIRST (≈ first 30–45 min)

Resolve the unknowns before designing around them. Read the installed SDK types in
`server/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` and run tiny probes.

**✅ RESOLVED in session 2** (read from `sdk.d.ts`, no agent turns spent):

- **In-process MCP tools — CONFIRMED.** The SDK exports `createSdkMcpServer(options)`
  (line ~480) and `tool(name, description, zodSchema, handler, extras?)` (line ~6878).
  So the computer-control server (Phase D) can run **in-process with Zod schemas** —
  no separate stdio process needed.
- **Live controls — CONFIRMED.** `Query` exposes `interrupt()`, `setModel(model?)`,
  `setPermissionMode(mode)`, `supportedModels()`, `mcpServerStatus()`. Barge-in and
  model swapping both work (model swap now shipped + verified).
- **Model IDs — use `supportedModels()`, not literals** (see Progress log).

**⬜ STILL TO SPIKE:**

1. ~~**Image input in streaming mode**~~ — ✅ **RESOLVED & shipped.** The SDK accepts
   `image` blocks in `message.content`; verified with a known-word PNG round-trip.
   Screenshots can reuse this exact path for screen vision.
2. ✅ **RESOLVED & SHIPPED — Local-brain fallback.** See `server/src/local.ts`.
   **Decision: direct-runtime, NOT the Anthropic-compatible proxy.** Routing the
   Agent SDK at a local model (claude-code-router / LiteLLM) was the alternative, but
   non-Claude models handle the SDK's tool/agent loop badly and fail confusingly.
   Talking to **Ollama's `/api/chat` directly** gives honest, reliable degradation.
   - `listOllamaModels()` discovers local models at boot and appends them to the
     model dropdown as `ollama:<name>` (empty list if Ollama isn't running, so the
     UI degrades gracefully).
   - `index.ts` holds a mutable `brain` (`JarvisSession | LocalSession`) and swaps it
     when the selected model crosses the Claude/local boundary.
   - `LocalSession` emits the **same WebSocket events**, so the UI needed no changes;
     streaming works via Ollama's NDJSON.
   - **Memory still works offline** — `recallRelevant()` is local, so the local brain
     keeps your remembered facts.
   - **Known limits, surfaced to the user in-app rather than hidden:** no tools, no
     vision, and switching brains **starts a fresh conversation** (a notice is shown).
   - **Verified**: 7 local models discovered, brain switched, streamed reply,
     **zero Claude usage**.
   - *Future:* the user has **`llava:13b`** installed — a vision model — so local
     camera/screenshot vision is possible later. Also consider auto-switching to local
     when a Claude usage-limit error is detected.

3. ~~**Local-brain routing (original notes)**~~ — stand up **Ollama** + **claude-code-router
   (or LiteLLM)**, point a throwaway `query()` at it via `ANTHROPIC_BASE_URL`, and see
   (a) does it complete a chat turn, (b) how badly does tool use degrade. Decide
   proxy-through-SDK vs direct-runtime for non-Claude brains based on what you observe.
   *Note: `setModel()` now covers the cheap half of this need (drop to `haiku` to
   stretch usage), so the local brain is pure "Claude is out" insurance.*
3. **nut.js on Windows:** `npm i` it in a scratch script; confirm screenshot + a mouse
   move work before wiring the MCP server.
4. **Voice in your real Chrome:** confirm the shipped mic + speech actually work for
   you, and note the best available system voice (`VOICE_PREFERENCES` in
   `web/src/voice.ts` — reorder to taste).

Write findings at the top of this file (or a `SPIKE-NOTES.md`) so the design uses
observed facts, not assumptions.

---

## 9. Suggested order (each phase independently useful)

1. ~~**Spikes (Section 8)**~~ — ✅ the cheap type-level ones are done; 4 remain.
2. ~~**Phase B Tier 1** (`setModel` swap)~~ — ✅ **done & verified**.
3. ~~**Phase A** (voice)~~ — ✅ **done & user-verified**. Remaining polish: **wake word**
   ("Hey Jarvis", always-listening) and optionally ElevenLabs/Piper TTS + local Whisper.
4. ~~**Phase C** (camera)~~ — ✅ **done & verified**. Remaining: **screen vision**
   (screenshot → same image path), which arrives free with Phase D's screenshot tool.
5. ~~**Phase D** (computer control)~~ — ✅ **done & user-verified.**
   Built on PowerShell/.NET + a native capture helper instead of nut.js (no native
   build step). *Next session:* confirm it works, then **downscale screenshots**
   (token cost), add `scroll` / `drag`, and consider a per-session "always allow" for
   `screenshot` so looking at the screen isn't a click every time.
6. **Phase B Tier 2** (local/other brain + auto-fallback) — full insurance.
7. **Phase E** (ambient extras + HUD) — polish toward "the real thing", ongoing.

Rationale: spikes first (fable discipline), then the cheap usage-saver, then the
capabilities that most change the experience, saving the hardest/most-uncertain
(local brain) and the endless-polish layer (HUD/extras) for when the core is solid.

---

## 10. Risks & principles to hold

- **Verify, don't confabulate** — every SDK/API detail above marked "verify" must be
  observed before you build on it. Read the types; run the probe.
- **Approval-gate dangerous power** — computer control can wreck things; keep it behind
  the modal + a kill switch, log every action.
- **Privacy** — camera/mic are local-only, off by default, with a visible on-air
  indicator. Don't send frames anywhere except the model turn the user asked for.
- **Subscription-first** — Claude stays the default/primary brain; local/other is
  explicit fallback, not the default path.
- **Small verified increments** — one capability working end-to-end (driven in the
  browser) before starting the next.

---

## 11. Capability backlog (researched, with implementation notes)

Researched against this stack; libraries below were checked as real, current, and
Windows-friendly. **Effort** S/M/L. **Tokens** matters — the user has limited Claude
usage, so zero-token items are ranked first.

### 11.1 ✅ DONE — the proactive layer

Shipped in `server/src/proactive.ts` + `initProactive()`/`setInjector()` in
`index.ts` + `JarvisSession.injectTurn()` in `agent.ts`:
- **Scheduling** via `node-cron` — one-off (`in_minutes`) and recurring (`cron`).
- **Native Windows toasts** via `node-notifier` (bundled SnoreToast, no native build).
- **Synthetic turn injection** into the live session; when no browser is connected the
  toast still fires, so nothing is silently lost.
- **Jobs persist** to `~/.jarvis/jobs.json` and are **re-armed on restart**; stale
  one-offs are dropped and fired one-offs self-delete.
- MCP tools: `schedule`, `list_scheduled`, `cancel_scheduled`, `notify` (all
  auto-approved — they can't damage anything).
- **Token rule enforced in the tool description:** `speak: false` (default) is a pure
  toast costing **zero tokens**; only `speak: true` spends a turn.
- **Verified**: asked Jarvis to schedule a reminder; it armed and fired on time
  (`[proactive] firing … stand up and stretch`).

✅ **Also done since:**
- **Proactive UI marker.** `injectTurn(text, label)` emits a `proactive` event; the UI
  renders `⏰ Jarvis started this — <label>` as a divider, so a self-started reply
  never appears out of nowhere. **Verified** end-to-end (marker + injected turn).
- **Ambient loop** (`server/src/ambient.ts`) — polls `getPresence()` every 60s and,
  with **zero model involvement**: nudges after `JARVIS_BREAK_MINUTES` (default 90) of
  unbroken focus, and says "welcome back" after a ≥10 min absence. Disable with
  `JARVIS_AMBIENT=off`; opt into a spoken greeting with `JARVIS_AMBIENT_GREET=on`
  (that one costs a turn). Nudge state resets so it can't nag.
- **OCR** (`read_screen_text`, tesseract.js) — reads the screen as **text instead of an
  image**. Tool description explicitly tells the model to prefer it over `screenshot`
  when only text matters, which directly cuts the ~2.7k-tokens-per-look problem.
  Gated behind approval like `screenshot`. **Verified**: exact transcription in 0.5s.

### 11.1b Original design notes (kept for reference)

Jarvis today is **purely reactive** — it only ever acts when you send a message.
Briefings, reminders, folder watching, dev-watching and break nudges are all the same
shape and need the same three primitives. Build these **once** (half a session) and
five capabilities become small:

1. **Synthetic turn injection.** `JarvisSession` already has a private `AsyncQueue`.
   Add a public `injectTurn(text: string, opts?: { silent?: boolean })` that pushes a
   user message the same way `sendUserMessage` does, and relay a marker event so the
   UI can render it as "Jarvis acted on its own" rather than as something you typed.
2. **A scheduler/trigger bus.** New `server/src/scheduler.ts` using **`node-cron`**
   (zero runtime deps, bundled types). One registry of jobs → each fires either a
   plain notification (no LLM) or an `injectTurn`.
3. **A way to reach you when the tab is closed.** **`node-notifier`** (bundles
   `SnoreToast.exe`, no native build) for real Windows toasts.
   ⚠️ Cron will often fire with **no browser connected** — queue the output and
   notify, rather than assuming a live WebSocket. This is the #1 thing to get right.

> **Design rule:** the trigger itself must cost **zero tokens**. Only escalate to an
> LLM turn when synthesis is genuinely wanted (a briefing), never for a bare reminder.

### 11.2 Zero-token capabilities (do these first — they cost nothing to run)

| # | Capability | How, on this stack | Effort |
|---|---|---|---|
| 1 | **Desktop notifications** | `node-notifier`. Prerequisite for everything proactive. Register a proper AppID or toasts show "SnoreToast" as sender; Focus Assist can suppress them. | S |
| 2 | ✅ **DONE — Presence / idle / focus awareness** | Shipped as the `user_presence` MCP tool in `computer.ts` (new `WINAPI_IDLE` P/Invoke block: `GetLastInputInfo` + `GetForegroundWindow`/`GetWindowText`). Returns `idle_seconds`, `foreground_window`, and a bucketed `state` (active <60s / idle <300s / away). Auto-approved (read-only). Verified: `idle_seconds: 6, foreground_window: Claude`; AMSI does not block this P/Invoke. **Zero tokens.** *Next:* poll it on a backend `setInterval` to drive break nudges + "welcome back" without the model. | S |
| 3 | **Weather + news briefing data** | **Open-Meteo** (free, **no API key**, needs a saved lat/long) + **`rss-parser`**. Fetching is free; only the narration costs a turn. | S |
| 4 | **Focus / break nudges** | Pure composition of #2 + #1 on a `setInterval`. Rule-based; LLM only if you want varied phrasing. Make thresholds snoozeable — idle can't tell "reading" from "away". | S |
| 5 | **Folder watcher** | **`chokidar`** ("tell me when an invoice lands in Downloads"). **Debounce it** — we already hit repeated-event pain with file watching in this OneDrive folder. | S–M |
| 6 | **System tray presence** | **`systray2`** (prebuilt Go binary, no native build; icon must be `.ico`). Implies running the backend as a persistent process, not a dev `tsx` script. | S–M |
| 7 | **Global hotkey / push-to-talk anywhere** | **`node-global-key-listener`** (prebuilt binaries, out-of-process, no node-gyp). Backend pushes a "focus me" event over the existing WebSocket, then uses our existing `focus_window` tool to raise the browser. | S–M |

### 11.3 Low-token capabilities

- ✅ **DONE — Persistent semantic memory.** Shipped in `server/src/memory.ts`:
  JSONL at `~/.jarvis/memory.jsonl` (deliberately **outside** the agent's sandboxed
  workspace so its own file tools can't clobber it), embedded locally with
  `Xenova/all-MiniLM-L6-v2` via the transformers.js dependency we already ship.
  MCP tools `remember` / `recall` / `forget`; `remember`+`recall` are auto-approved,
  **`forget` is gated** behind the approval modal. `recallRelevant()` runs on every
  turn (top 3, similarity ≥ 0.35) and quietly prepends hits — zero tokens to search.
  Near-duplicate writes (>0.97 similarity) are folded in rather than appended.
  **Verified**: saved a fact in one session, recalled it in a brand-new session with
  no history.
  ⚠️ **Key gotcha, cost me a failed run:** the model would say *"I'll remember that"*
  and never call the tool. Registering the MCP server is **not** enough — it needed
  an explicit `systemPrompt` instruction (`{type:'preset', preset:'claude_code',
  append: JARVIS_PROMPT}` in `agent.ts`) stating that saying it without calling the
  tool is a failure. Remember this pattern for any future "the model should
  proactively use tool X" capability.
  *Next:* a memory-management UI (browse/edit/delete), and pruning as it grows.

- **(original research note) Persistent semantic memory.** New in-process MCP
  tools `remember` / `recall`, same `tool()` + Zod pattern as `computer.ts`, appending
  to a JSONL file. Embed locally with **`@huggingface/transformers`** using
  `Xenova/all-MiniLM-L6-v2` — **we already ship this dependency for Whisper**, so the
  marginal cost is just tool + storage logic. Cosine similarity over a flat array is
  fine for hundreds of facts; graduate to **`vectra`** (file-backed, no server) later.
  Only the short recalled snippets enter context. **Effort M.** Keep the memory file
  out of git and give it a prune/dedup path.
- ✅ **DONE — Screen vision, three cheap tiers.** In `computer.ts`:
  - `read_screen_text` — tesseract.js OCR (text, zero image tokens). *(done earlier)*
  - `describe_screen` — **local vision**: captures + downscales, sends to a local
    Ollama multimodal model (`describeImage()` in `local.ts`, `qwen2.5vl:7b` default),
    returns text. **Zero Claude image tokens.** Verified: qwen2.5vl read a test image
    correctly (llava was worse/slower — hence the default). ~11s per look.
  - `screenshot` — now **downscaled to 1280px via jimp** before sending to Claude:
    measured **4,915 → 1,229 image tokens (~75% less)** on a 2560×1440 display.
  - System prompt tells the model the cost order (OCR → local vision → screenshot).
  - ⚠️ Local vision is a 7B model — good for casual "what's on screen", but less
    accurate than Claude's vision; the model is told to use `screenshot` when accuracy
    matters. Camera frames still go to Claude (already downscaled to 1024 in-browser);
    routing those through local vision too is a possible follow-up.
- **Dev-workflow watcher.** `chokidar` on `src/**` → `spawn` `tsc --noEmit` / tests →
  **only inject a turn on failure**. Ambient pair-programmer that stays silent (and
  free) while things pass. Needs a cooldown so save-bursts don't spam. **Effort S–M.**
- **Google Calendar + Gmail.** Official **`googleapis`** + `@google-cloud/local-auth`
  for one-time OAuth, as an MCP tool (`list_events`, `create_event`, `search_email`).
  ~15 min of Google Cloud project setup; expect an "unverified app" consent warning;
  store the refresh token locally and gitignored. **Keep send/delete behind
  `canUseTool`** exactly like the computer-control tools — do not auto-allow. **Effort M–L.**
- **Spotify control.** ⚠️ **Do not use `spotify-web-api-node` — confirmed unmaintained
  (5 years, no releases).** Use the official **`@spotify/web-api-ts-sdk`**, or just
  `fetch` the REST API. Requires **Premium** for playback control plus an active
  device. **Effort M.**
- **Smart home.** **Verify what hardware is actually owned first.**
  `tplink-smarthome-api` is local-only and real but **explicitly does not support
  newer Tapo-branded devices**; Philips Hue's local bridge API is the alternative.
  Router client-isolation can block local discovery. **Effort M.**

### 11.4 High-token — defer while usage is tight

- **Multi-agent background delegation.** The SDK's native sub-agent support is
  available, but this is **a second full agent loop — the most token-hungry item
  here**. If built: route sub-agents to `haiku`/`sonnet` via `setModel`, cap their
  turns, and add UI showing a background task is running. **Defer until the
  local-model fallback exists**, then run sub-agents locally for free.

### 11.4b ✅ DONE — visual identity ("workshop instrumentation")

The old look (near-black + single cyan accent) was, on reflection, **the generic
AI-app default**. Replaced with a direction specific to what this thing actually is:
not a chat app, but **a console for a machine with senses and effectors**.

- **Palette:** warm graphite (`--void #0b0d10`), **amber phosphor** (`#f0a63c`) as the
  primary — avionics/CRT, and true to the Jarvis brief — with **teal `#35d0c0`
  reserved strictly for LIVE signals** (streaming, listening, camera on). Colour
  therefore carries meaning rather than decoration.
- **Type:** `Bahnschrift` (Windows' condensed technical face) for display/headings,
  `Cascadia Mono` for all instrument data, Segoe UI Variable for body. **No web fonts
  → stays fully offline**, consistent with the local-first design.
- **Signature: the sensor rail** — LINK / BRAIN / MIC / EYE / VOX / COST gauges with
  state LEDs across the header. Chosen over the obvious arc-reactor orb because it
  **encodes real state** (the skill's "structure is information") and is genuinely
  useful. Local brains correctly show `COST $0.00`.
- **One deliberate risk:** faint CRT scanlines + instrument glow overlay, which is what
  makes it read as a machine panel. Disabled under `prefers-reduced-motion`.
- Bug caught by screenshotting rather than trusting the diff: `.composer button` was
  overriding `.iconbtn`, rendering mic/camera as amber primaries competing with SEND.
  Now scoped to `.composer .send` — **one primary action per surface**.
- Responsive (gauge labels collapse under 720px), focus-visible retained.

### 11.4c ✅ DONE — the "feel like Jarvis" UI overhaul

- **Tabbed shell**: Console / Memory / Schedule / Settings. Memory and Schedule tabs
  also **fill real gaps** — you can now browse & forget memories and view/cancel jobs
  (new `GET/DELETE /memory`, `/jobs` endpoints).
- **Arc reactor** (`Reactor.tsx`, pure SVG/CSS): breathes idle, spins thinking, goes
  teal + pulses when listening/speaking. Speaking state comes from `speechSynthesis`
  utterance start/end events (`onSpeaking` in `voice.ts`). Big in the empty state,
  small in the header — both live.
- **Customization** (`settings.tsx`, localStorage): assistant name, 5 accent themes
  (incl. Iron-Man blue "Reactor"), text-size, and reactor/scanline/glow toggles — all
  applied live via CSS variables. Verified: switching accent recolours the whole UI.
- **Floating camera** (`CameraWidget.tsx`): drag by its header, resize from the corner,
  position/size persisted.
- **Drag-and-drop** (`/upload` endpoint): images attach as vision, other files upload
  to `<workspace>/dropped/` and are referenced by path so Jarvis can `read` them.
- Verified visually by screenshot at each step; production build clean.
- ⚠️ **Not driven live**: the camera widget and file-drop need a real device/permission
  and a real drag, so they're built + type-checked but await your hands-on test.

### 11.5 Suggested order

1. **Proactive layer** (11.1) — unlocks five things at once.
2. **Presence + notifications + break nudges** (zero tokens, immediately "alive").
3. **Persistent memory** — biggest single step toward the "real Jarvis".
4. **OCR** — also cuts screenshot token cost.
5. **Briefings** (weather/RSS) once the proactive layer exists.
6. **Calendar/Gmail**, then tray + global hotkey for always-on presence.
7. Spotify / smart home / multi-agent last (external deps, or expensive).
