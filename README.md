# JARVIS

**Interface:** a tabbed console — **Console** (chat), **Memory** (browse/forget what it
remembers), **Schedule** (view/cancel reminders), **Settings** (name, accent colour,
text size, arc-reactor/scanlines/glow toggles). A central **arc reactor** breathes when
idle, spins while thinking, and pulses teal when it listens or speaks. Drag a **camera
monitor** anywhere and resize it. **Drop images or files** onto the window — images
become vision, other files land in the workspace for Jarvis to read.


A personal, local Jarvis-style UI for your Claude account. It runs the
[Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk) (Claude Code as a
library) behind a small local server and streams the agent — its replies, its
tool activity, and its permission prompts — into a browser chat UI.

Because it uses the Agent SDK's bundled Claude Code binary, **it runs on your
existing Claude Code login** (your subscription) with no API key. This is a
personal-use setup. If you ever want to distribute it, Anthropic's terms require
switching to API-key auth (see the SDK docs).

## What it does

- **Chat** with your Claude agent, responses streamed token-by-token.
- **Real tools**: it can read/search files, run commands, edit code, search the
  web — the full Claude Code toolset, plus any MCP servers configured in your
  `~/.claude` settings.
- **Approval policy — allow by default, stop for the dangerous stuff.** Jarvis runs
  normal work without interrupting you (opening apps, clicking, typing, editing files,
  git commits, builds). It only pauses for things that are destructive or hard to
  undo — recursive deletes, `git reset --hard`, force pushes, formatting drives,
  shutdowns, registry/AV/account changes, piping downloaded code into a shell, and
  writes into Windows/Program Files/Startup.
  The list lives in **`server/src/policy.ts`** — add your own rules there, then run
  `npm run policy` to check nothing's misclassified.
- **Persistent sessions**: your conversation survives a page reload — both the
  transcript and the agent's memory of it (via SDK session resume).
- **Voice**: 🎤 push-to-talk (click, speak, click again) transcribed by **local Whisper
  on your machine** — offline, no API key, no tokens, and works in **any** browser
  (Firefox/Zen included). 🔊 spoken replies use a **local neural voice** (Kokoro, a
  British male by default) synthesized on your machine — natural-sounding, offline, zero
  tokens — and start talking sentence-by-sentence while the answer is still streaming. If
  the local voice is ever unavailable it falls back to the browser's built-in speech. Voice
  output is off by default; the voice model (~80 MB) downloads once when you first enable it.
  Change the voice with `JARVIS_TTS_VOICE` (e.g. `am_michael`, `af_heart`, `bm_lewis`).
  First launch also downloads a small Whisper model once for speech input; set
  `JARVIS_WHISPER_MODEL=Xenova/whisper-base.en` for better accuracy.
- **Vision**: 📷 toggle the webcam and Jarvis sees a frame with every message you send
  ("what am I holding?"). Mirrored corner preview so you always know when it can see;
  frames are captured locally and only sent with a turn you initiate.
- **Long-term memory**: tell it something durable ("I prefer Rust", "my sister's name
  is…") and it remembers across sessions. Stored locally at `~/.jarvis/memory.jsonl`
  and searched with local embeddings — **no tokens, never leaves your machine**.
  Relevant memories are recalled automatically each turn. Ask it to forget something
  and it'll prompt for approval first.
- **Reminders & scheduled tasks**: "remind me in 20 minutes to…" or "every weekday at
  7am, brief me". Fires a native Windows notification even with no browser open, and
  survives a restart. Plain reminders cost **zero tokens** — only tasks you ask it to
  actually *do* spend a turn.
- **Global hotkey — `Ctrl+Alt+J`**: summons Jarvis and starts listening from
  anywhere, even when the browser tab isn't focused. Uses Windows' `RegisterHotKey`
  (not a keyboard hook, so antivirus won't flag it).
- **Always present** (opt-in): `npm run autostart` adds a Startup shortcut so Jarvis
  runs hidden from login and the hotkey always works. Undo with `npm run autostart:off`.
- **Opens and drives real apps**: `launch_app` resolves friendly names *and* Microsoft
  Store apps (so "Spotify" just works), plus protocol URIs like
  `spotify:search:hot wind blows`. Combined with screenshot/OCR/mouse/keyboard it can
  operate an app end to end. Actions run under the same approval policy as everything
  else — routine clicks and keystrokes run directly; only destructive commands
  (see `server/src/policy.ts`) stop for your approval.
- **Ambient awareness**: knows if you're actually at the machine. Nudges you after 90
  minutes of unbroken focus and welcomes you back after a break — all locally, costing
  **zero tokens**. Tune with `JARVIS_BREAK_MINUTES`, turn off with `JARVIS_AMBIENT=off`.
- **Sees your screen cheaply — three tiers, cheapest first:** local OCR
  (`read_screen_text`, text only, zero image tokens), **local vision**
  (`describe_screen` — a local model on your machine describes the screen for **zero
  Claude image tokens**), and a real `screenshot` only when pixel-accuracy is needed
  (now downscaled, ~75% fewer tokens than before). Jarvis is told to prefer the cheap
  paths. Local vision uses `qwen2.5vl:7b` via Ollama — set `JARVIS_VISION_MODEL` to change.
- **Local fallback brain**: if your Claude usage runs out, pick any local **Ollama**
  model from the same dropdown and keep working — fully offline, zero usage. Your
  long-term memory always works. **Tool-capable local models** (e.g. `qwen3.5`,
  `qwen2.5`, `gemma4` — detected automatically via Ollama's capability flags) also get a
  **safe tool subset** — memory, weather, news, system status, and Spotify — and
  **vision-capable** ones can see attached images. Computer control stays Claude-only, and
  switching brains starts a fresh conversation (the app tells you).
- **Plays Spotify properly** (not by clicking): with the Spotify Web API wired in, Jarvis
  can search-and-play, pause/skip, set volume, queue tracks, and report what's playing —
  reliably, no pixel-hunting. Needs a one-time connect (see **Connect Spotify** below) and
  Spotify Premium.
- **Smart lights (Govee)**: "turn the lights blue," "dim to 20%," "lights off" — controlled
  over your **local network** via Govee's LAN API (no API key, no cloud, instant). Enable
  "LAN Control" per device in the Govee Home app; Jarvis auto-discovers them. Works from both
  Claude and tool-capable local models.
- **Weather & news**: "what's the weather" / a morning briefing — via Open-Meteo and RSS,
  both **keyless and zero-token** to fetch. Set a home location in `~/.jarvis/briefing.json`
  (`{"lat":..,"lon":..,"city":".."}`) or just ask "weather in <city>".
- **Watches folders**: "tell me when a PDF lands in Downloads" — a desktop toast (free) or,
  optionally, Jarvis reacts. Survives restarts.
- **Model switching**: a dropdown of your actually-available models
  (`opus` / `sonnet` / `haiku` / Fable / default). **Drop to `haiku` to stretch your
  Claude usage**, switch back for hard work. **Stop** interrupts a running turn.

## Prerequisites

- Node.js 18+ (tested on 24).
- Claude Code installed and logged in (`claude` on your PATH). You already have
  this if you use Claude Code. Verify with `claude` / `/login` if needed.

## Run

Install once:

```bash
npm install
npm install --prefix server
npm install --prefix web
```

Then start both the backend and the UI:

```bash
npm run dev
```

Open the printed Vite URL (http://localhost:5173). The backend listens on
`127.0.0.1:8787`; the UI proxies the WebSocket to it automatically.

### The agent's workspace

By default the agent operates in the directory the server starts from. To point
it at a specific folder (recommended — keeps it scoped), set `JARVIS_WORKSPACE`:

```bash
JARVIS_WORKSPACE="/path/to/your/project" npm run server
```

### Sanity check (auth gate)

To confirm the SDK runs on your Claude login with no API key:

```bash
npm --prefix server run hello
```

It should complete a turn and print `PASS`.

## Connect Spotify (optional)

One-time setup so Jarvis can control playback through the official API:

1. Go to the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) and
   **Create app** (any name/description).
2. In the app's settings, add this **Redirect URI** exactly:
   `http://127.0.0.1:8787/spotify/callback`, and save.
3. Copy the app's **Client ID** and give it to Jarvis one of two ways:
   - set `JARVIS_SPOTIFY_CLIENT_ID=<your id>` before `npm run dev`, or
   - create `~/.jarvis/spotify.json` with `{ "clientId": "<your id>" }`.
   (No client secret is needed — it uses PKCE.)
4. Start Jarvis, open **Settings → Spotify → Connect**, approve in the browser, done. The
   token is stored locally at `~/.jarvis/spotify-tokens.json` and refreshes itself.

Playback control requires **Spotify Premium** and an **active device** — if nothing plays,
open Spotify on your phone/desktop once so there's a device to target.

## Wake word — "Jarvis" (optional)

Hands-free, always-listening activation — **no account, no API key, fully local**. A
small built-in energy VAD (Web Audio) notices when you speak; each utterance is
transcribed by the same local Whisper, and if it opens with "Jarvis" the rest is run as a
command. Nothing leaves the machine and it works in any browser (Zen/Firefox included).

Usage — just click **WAKE → on** in the header rail and grant mic access, then say
**"Jarvis, what's the weather?"** (all in one breath), or **"Jarvis"** … then your command.
Turn it off with the same toggle; the mic only runs while it's on.

Notes: because it leans on Whisper rather than a dedicated wake engine, it occasionally
mishears the word (we fuzzy-match to soften that) and it transcribes every utterance while
enabled, so it uses more CPU than a purpose-built detector — the trade for zero setup. A
crisper option (Picovoice Porcupine) exists but requires a company-email signup, so this is
the default.

## What it remembers

Memory lives in `~/.jarvis/memory.jsonl`, indexed with local embeddings. Nothing
leaves the machine and searching costs no tokens. Two kinds:

- **Facts** — durable things about you. The few most relevant are injected into
  every turn automatically, so you don't re-explain yourself.
- **Episodes** — things that *happened*: a task, a problem, what fixed it. These
  are **not** injected every turn (that would be noise and tokens); Jarvis
  searches them when you ask "have we hit this before?".

**Corrections replace, rather than pile up.** Tell it you've moved and the old
fact is *retired*: kept on disk as history, excluded from recall, so it can't
resurface and contradict the new one. That's different from `forget`, which
deletes outright — use that when something was simply wrong.

The Memory tab shows counts, badges for episodes and retired entries, and a
"show/clear retired" control for pruning history you don't want kept.

**Ranking** is similarity first, then a gentle nudge for recency and for anything
saved as important — enough to settle near-ties, never enough to bury a better
match. The threshold that decides "this new fact may be correcting an older one"
was measured rather than guessed; see the note above `RELATED_SCORE` in
`server/src/memory.ts` before changing it.

## Access token, and reaching Jarvis from your phone

Every request to the backend needs an access token — HTTP and WebSocket alike.
It's generated on first boot into `~/.jarvis/auth.json`; set `JARVIS_TOKEN` to
supply your own instead.

**You won't normally see it.** In local development the Vite proxy reads the same
file and attaches the header for you, so the browser holds no secret. The token
only matters when something talks to the backend directly.

The startup log prints what you need:

```
[auth] token file: C:\Users\you\.jarvis\auth.json
[auth] direct URL: http://127.0.0.1:8787/health?token=…
```

Opening any page with `?token=…` stores it in that browser and scrubs it from
the address bar; from then on the token rides along automatically.

### From another device

Jarvis binds `127.0.0.1` and is unreachable off this machine by default. To
change that:

```bash
JARVIS_HOST=0.0.0.0 npm run server
```

Read the warning it prints, because it is not boilerplate: **this backend can
move your mouse, type keystrokes and run shell commands.** The token is the only
thing between the network and that.

- **Put it on [Tailscale](https://tailscale.com/) or a VPN**, and bind to the
  Tailscale address rather than `0.0.0.0`. Do *not* port-forward this to the
  internet — there's no TLS here, so the token would cross the network in clear
  text, and a leaked token is complete control of the machine.
- **Rotate** by deleting `~/.jarvis/auth.json` (or changing `JARVIS_TOKEN`) and
  restarting. Existing sessions drop immediately.
- `/spotify/callback` is the one unauthenticated route — Spotify redirects there
  and can't carry our token. It's protected by the OAuth `state` check instead.

## Teaching it a routine (skills)

A **skill** is a folder with a `SKILL.md` — a name, a description saying *when*
to use it, and a procedure in plain markdown. Jarvis reads the descriptions,
decides one applies, and loads the body only then. Two ship with it:

- `morning-briefing` — what a briefing includes, in what order, and how short.
- `end-of-day` — capture what happened, arm tomorrow's reminders, warm the lights.
- `browser-work` — when to fetch a page versus drive the browser, reading the
  page cheaply, and treating page content as data rather than instructions.

Read `server/skills/skills/*/SKILL.md` and edit them; they're just text.

### Writing your own

```
~/.jarvis/skills/
  .claude-plugin/plugin.json      { "name": "my-skills", "version": "0.1.0",
                                    "skills": ["./skills/pay-invoices"] }
  skills/pay-invoices/SKILL.md    --- name / description frontmatter, then steps
```

Then restart. The boot log confirms it: `[skills] 2 skill source(s): shipped (…),
yours (…)`. Override the location with `JARVIS_SKILLS_DIR`.

**Why a skill instead of a longer system prompt:** `JARVIS_PROMPT` in
`server/src/agent.ts` costs tokens on *every* turn, whether or not the turn is
about briefings. A skill costs nothing until it's used. Put always-true rules in
the prompt; put procedures in a skill.

**Why a skill instead of code:** a skill is inert text that composes tools you
already have, so there's nothing new to gate. It can't do anything Jarvis
couldn't already do — it just knows how you want it done.

## Adding capabilities without writing code (external MCP servers)

Everything Jarvis can do natively — the screen, the clipboard, memory, Spotify,
the lights — is an in-process MCP server under `server/src/`. You don't have to
write one of those to add a capability: Jarvis will also connect to any MCP
server on your machine or network. Drop a `~/.jarvis/mcp.json` in place:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "C:/Users/you/notes"]
    },
    "some-service": { "type": "http", "url": "https://example.com/mcp" },
    "paused": { "command": "npx", "args": ["-y", "whatever"], "disabled": true }
  }
}
```

**A browser is already configured.** `~/.jarvis/mcp.json` ships with Microsoft's
Playwright MCP server, so Jarvis can drive the web properly — navigate, read the
accessibility tree, click by selector, fill forms — instead of squinting at
screenshots and clicking pixels. It runs headed (so you can watch and take over)
with **its own browser profile**, not your everyday Chrome: it starts signed out
of everything, and stays signed into whatever you sign into there. `file://`
access is blocked by default. The paired `browser-work` skill covers when to use
it, why page content is never treated as instructions, and what to confirm before
anything irreversible. Remove the entry, or add `"disabled": true`, to turn it
off.

It uses the same `mcpServers` key as other MCP clients, so a config you already
have elsewhere can be pasted straight in. Notes:

- **Read once at startup** — restart the server after editing. The boot log tells
  you what attached: `[mcp] 2 external MCP server(s): filesystem, some-service`.
- **A broken config never stops Jarvis.** Invalid entries are skipped with a
  reason on stderr; the built-in capabilities always load.
- **Names can't collide** with a built-in (`computer`, `memory`, `proactive`,
  `briefing`, `watcher`, `spotify`, `govee`) — a collision is rejected rather
  than silently shadowing ours.
- **Tools load on demand**, so attaching a lot of servers doesn't bloat every
  turn's prompt.
- **They're treated as untrusted.** For our own tools the approval policy knows
  which argument is a command and which is a path. For a third-party tool it
  can't, so *every* string in the call is inspected, and a protected location is
  flagged even without an obvious write — see `assessExternalMcp` in
  `server/src/policy.ts`. Expect the occasional extra prompt from an external
  tool; that's the trade for not trusting code you didn't write.
- If you add a new **in-process** server to `agent.ts`, add its name to
  `BUILT_IN_MCP_SERVERS` in `server/src/mcp-external.ts`, or its ordinary calls
  will start getting flagged as third-party.

## Layout

- `server/` — Fastify + WebSocket. `src/agent.ts` holds the long-lived Agent SDK
  `query()` (streaming-input mode) and maps SDK messages to browser events;
  `src/index.ts` is the WebSocket server. `src/policy.ts` decides what needs your
  approval (`npm run policy` checks it); `src/mcp-external.ts` loads third-party
  MCP servers; `src/skills.ts` loads skills from `server/skills/` and
  `~/.jarvis/skills/`; `src/auth.ts` is the access token every request needs.
- `web/` — Vite + React chat UI. `src/useJarvis.ts` is the WebSocket client and
  state; `src/App.tsx` is the UI.

## Not yet built (ideas)

- **Google Calendar / Gmail** — OAuth setup required.
- **System tray icon** for always-on presence.
- **A nicer TTS voice** (ElevenLabs / local Piper) instead of the browser default.
- **System tray icon** and a cinematic HUD upgrade.
- **Smart home** — depends on what hardware you own.
