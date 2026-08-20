// Computer control, exposed to Jarvis as an in-process MCP server.
//
// Implementation note: this drives Windows via PowerShell + .NET rather than a
// native automation module (nut.js), so there's no native build step to fail.
// These tools are DESTRUCTIVE-CAPABLE and run under the same policy as
// everything else (assessRisk in policy.ts): a call flagged destructive surfaces
// the Approve/Deny modal, but routine ones — screenshots, clicks, keystrokes,
// launching apps — run WITHOUT a prompt so driving an app stays fluid. Approval
// gates danger, not computer control as a category.
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { createWorker, type Worker } from "tesseract.js";
import { Jimp } from "jimp";
import { z } from "zod";
import { describeImage, localVisionAvailable } from "./local";

/** Downscale a JPEG to a max width and recompress — cuts image tokens hard. */
async function shrinkJpeg(buf: Buffer, maxWidth: number, quality = 70): Promise<Buffer> {
  const img = await Jimp.read(buf);
  if (img.width > maxWidth) img.resize({ w: maxWidth });
  return Buffer.from(await img.getBuffer("image/jpeg", { quality }));
}

// Screenshots are sent downscaled to save image tokens, but the screen is
// usually wider than this. The model reads click coordinates off the image it
// sees, so `mouse` must scale them back up to real pixels — otherwise every
// click lands up-and-left of the target (e.g. on a 2560-wide screen sent at
// 1280, clicks land at half position). `lastShot` carries that scale factor.
const SCREENSHOT_MAX_WIDTH = 1280;
let lastShot: { realWidth: number; sentWidth: number } | null = null;

// OCR worker is lazy + reused; the first call downloads language data once.
let ocrWorkerPromise: Promise<Worker> | null = null;
function getOcrWorker(): Promise<Worker> {
  if (!ocrWorkerPromise) {
    console.log("[ocr] loading tesseract (first run downloads language data)…");
    ocrWorkerPromise = createWorker("eng");
  }
  return ocrWorkerPromise;
}

/**
 * Run a PowerShell script. Caller-supplied strings are passed via environment
 * variables (never interpolated into the script) so nothing can be injected.
 */
function runPowerShell(script: string, env: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const ps = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { env: { ...process.env, ...env }, windowsHide: true },
    );
    let out = "";
    let err = "";
    ps.stdout.on("data", (d) => (out += d.toString()));
    ps.stderr.on("data", (d) => (err += d.toString()));
    ps.on("error", reject);
    ps.on("close", (code) => {
      if (code === 0) resolve(out.trim());
      else reject(new Error(err.trim() || `powershell exited ${code}`));
    });
  });
}

/**
 * Capture the screen.
 *
 * NOTE: we deliberately do NOT use PowerShell's CopyFromScreen — Windows
 * Defender's AMSI flags that pattern as infostealer behaviour and blocks the
 * script. We use the `screenshot-desktop` package's native helper instead, but
 * invoke its .exe directly: the package's own .bat launcher calls the exe by
 * bare name and fails with "not recognized" depending on cwd.
 */
export async function captureScreen(): Promise<Buffer> {
  const dir = join(tmpdir(), "screenCapture");

  // The .bat self-extracts the helper exe on first run; trigger it if needed.
  if (!existsSync(dir)) {
    // Resolved from this file, not the cwd, so screen capture still works when
    // the server is started from somewhere other than server/.
    const pkgWin32 = join(import.meta.dirname, "..", "node_modules", "screenshot-desktop", "lib", "win32");
    const bat = existsSync(pkgWin32) ? readdirSync(pkgWin32).find((f) => f.endsWith(".bat")) : undefined;
    if (bat) {
      await new Promise((resolve) => {
        const p = spawn("cmd.exe", ["/c", join(pkgWin32, bat), join(tmpdir(), "jv-warmup.jpg")], { windowsHide: true });
        p.on("close", resolve);
        p.on("error", resolve);
      });
    }
  }

  const exeName = existsSync(dir) ? readdirSync(dir).find((f) => /^screenCapture_.*\.exe$/i.test(f)) : undefined;
  if (!exeName) throw new Error("screen capture helper not found");

  const out = join(tmpdir(), `jv-shot-${Date.now()}.jpg`);
  await new Promise<void>((resolve, reject) => {
    const p = spawn(join(dir, exeName), [out], { windowsHide: true });
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`capture exited ${code}`))));
  });
  const buf = await readFile(out);
  await unlink(out).catch(() => {});
  return buf;
}

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
const fail = (e: unknown) => ({
  content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }],
  isError: true,
});

// Loaded once per PowerShell call that needs input/cursor APIs.
const WINAPI = `
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
if (-not ("JvNative" -as [type])) {
  Add-Type @"
using System;
using System.Runtime.InteropServices;
public class JvNative {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, int i);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
}
"@
}
`;

// Idle time + foreground window. Separate from WINAPI because it needs a struct.
const WINAPI_IDLE = `
if (-not ("JvIdle" -as [type])) {
  Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class JvIdle {
  [StructLayout(LayoutKind.Sequential)]
  public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
  [DllImport("kernel32.dll")] public static extern uint GetTickCount();
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
}
"@
}
`;

/* ------------------------------- tools ------------------------------- */

const screenshot = tool(
  "screenshot",
  "Capture the user's screen as an IMAGE for you (Claude) to see directly. This is the most expensive way to look — prefer `describe_screen` (free local vision) for general 'what's on screen', or `read_screen_text` for reading text. Use this only when you need pixel-accurate detail or coordinates to click.",
  {},
  async () => {
    try {
      // Downscale before sending — a full-res grab is thousands of image tokens —
      // but remember the real width so `mouse` can map coordinates back.
      const img = await Jimp.read(await captureScreen());
      const realWidth = img.width;
      if (realWidth > SCREENSHOT_MAX_WIDTH) img.resize({ w: SCREENSHOT_MAX_WIDTH });
      lastShot = { realWidth, sentWidth: img.width };
      const shot = Buffer.from(await img.getBuffer("image/jpeg", { quality: 70 }));
      return { content: [{ type: "image" as const, data: shot.toString("base64"), mimeType: "image/jpeg" }] };
    } catch (e) {
      return fail(e);
    }
  },
);

const describeScreen = tool(
  "describe_screen",
  "Look at the screen using a LOCAL vision model and get a text description back — costs you (Claude) zero image tokens. Prefer this for general 'what's on my screen / what am I looking at' questions. Optionally pass a focused question. Use `screenshot` instead only when you need exact pixel coordinates.",
  { question: z.string().optional().describe("What to focus on, e.g. 'what error is shown?'") },
  async ({ question }) => {
    try {
      // Without a local vision model this fails deep inside Ollama with an opaque
      // error; say what's actually missing and point at the cheaper alternative.
      if (!(await localVisionAvailable())) {
        return ok(
          "No local vision model is installed, so I can't describe the screen for free. " +
            "Use `read_screen_text` if you only need the text, or `screenshot` to look at it directly " +
            "(that one costs image tokens). To enable this: `ollama pull qwen2.5vl:7b`.",
        );
      }
      const shot = await shrinkJpeg(await captureScreen(), 1024);
      const prompt = question
        ? `Look at this screenshot and answer: ${question}`
        : "Describe what is on this screen: the app in focus, key text, and anything notable. Be specific and concise.";
      const desc = await describeImage(shot.toString("base64"), prompt);
      return ok(`[local vision] ${desc}`);
    } catch (e) {
      return fail(e);
    }
  },
);

const readScreenText = tool(
  "read_screen_text",
  "Read the text currently on screen using local OCR, returning plain text instead of an image. PREFER THIS over `screenshot` when you only need to read text (an error message, a document, a form) — it is far cheaper than sending an image. Use `screenshot` when layout, colours or visuals actually matter.",
  {},
  async () => {
    try {
      const shot = await captureScreen();
      const worker = await getOcrWorker();
      const { data } = await worker.recognize(shot);
      const text = (data.text ?? "").trim();
      return ok(text || "(no readable text found on screen)");
    } catch (e) {
      return fail(e);
    }
  },
);

const listWindows = tool(
  "list_windows",
  "List the titles of currently open application windows, with their process names.",
  {},
  async () => {
    try {
      const out = await runPowerShell(
        `Get-Process | Where-Object { $_.MainWindowTitle } | ForEach-Object { "$($_.ProcessName) :: $($_.MainWindowTitle)" }`,
      );
      return ok(out || "(no windows with titles)");
    } catch (e) {
      return fail(e);
    }
  },
);

/** Raise a window whose title contains `title`. Exported so the hotkey can use it. */
export async function focusWindowByTitle(title: string): Promise<string> {
  return runPowerShell(
    `${WINAPI}
    $p = Get-Process | Where-Object { $_.MainWindowTitle -like "*$($env:JV_TITLE)*" } | Select-Object -First 1
    if ($p) { [JvNative]::SetForegroundWindow($p.MainWindowHandle) | Out-Null; "focused: $($p.MainWindowTitle)" }
    else { "no window matching '$($env:JV_TITLE)'" }`,
    { JV_TITLE: title },
  );
}

const focusWindow = tool(
  "focus_window",
  "Bring a window to the foreground by matching part of its title (case-insensitive).",
  { title_contains: z.string().describe("Substring of the window title to focus") },
  async ({ title_contains }) => {
    try {
      return ok(await focusWindowByTitle(title_contains));
    } catch (e) {
      return fail(e);
    }
  },
);

const listApps = tool(
  "list_apps",
  "List installed applications by name (optionally filtered). Use this when you're unsure of an app's exact name before launching it.",
  { filter: z.string().optional().describe("Substring to match, e.g. 'spot'") },
  async ({ filter }) => {
    try {
      const out = await runPowerShell(
        `Get-StartApps | Where-Object { -not $env:JV_FILTER -or $_.Name -like "*$($env:JV_FILTER)*" } |
         Select-Object -First 60 | ForEach-Object { $_.Name }`,
        { JV_FILTER: filter ?? "" },
      );
      return ok(out || "(no matching apps)");
    } catch (e) {
      return fail(e);
    }
  },
);

const launchApp = tool(
  "launch_app",
  "Launch an app, open a file, or open a URL/protocol link. Accepts a friendly app name ('Spotify', 'Discord'), an executable, a file path, an http(s) URL, or an app protocol URI such as 'spotify:search:hot wind blows'. Resolves Start-menu and Microsoft Store apps, so plain names usually work. Protocol URIs are often the fastest way to drive an app — prefer them over clicking when one exists.",
  {
    target: z.string().describe("App name, path, URL, or protocol URI"),
    args: z.string().optional().describe("Optional arguments"),
  },
  async ({ target, args }) => {
    try {
      const out = await runPowerShell(
        `$t = $env:JV_TARGET
         # A protocol/URL (but not a drive path like C:\\...)
         if ($t -match '^[a-zA-Z][a-zA-Z0-9+.\\-]+:' -and $t -notmatch '^[a-zA-Z]:\\\\') {
           Start-Process $t
           "opened: $t"
         } else {
           $app = Get-StartApps | Where-Object { $_.Name -like "*$t*" } | Select-Object -First 1
           if ($app) {
             Start-Process "shell:AppsFolder\\$($app.AppID)"
             "launched: $($app.Name)"
           } elseif ($env:JV_ARGS) {
             Start-Process -FilePath $t -ArgumentList $env:JV_ARGS; "launched: $t"
           } else {
             Start-Process -FilePath $t; "launched: $t"
           }
         }`,
        { JV_TARGET: target, JV_ARGS: args ?? "" },
      );
      return ok(out || `launched: ${target}`);
    } catch (e) {
      return fail(e);
    }
  },
);

const typeText = tool(
  "type_text",
  "Type text into whatever window currently has focus, as if typed on the keyboard.",
  { text: z.string().describe("Literal text to type") },
  async ({ text }) => {
    try {
      // SendKeys treats +^%~(){}[] as control chars — escape them to type literally.
      await runPowerShell(
        `${WINAPI}
        $t = $env:JV_TEXT -replace '([+^%~(){}\\[\\]])', '{$1}'
        [System.Windows.Forms.SendKeys]::SendWait($t)`,
        { JV_TEXT: text },
      );
      return ok(`typed ${text.length} characters`);
    } catch (e) {
      return fail(e);
    }
  },
);

const pressKeys = tool(
  "press_keys",
  "Press a key or key combination using SendKeys syntax: ^=Ctrl, %=Alt, +=Shift. Examples: '^c' (copy), '^s' (save), '{ENTER}', '%{TAB}', '{ESC}'.",
  { keys: z.string().describe("SendKeys-format key sequence") },
  async ({ keys }) => {
    try {
      await runPowerShell(`${WINAPI}
        [System.Windows.Forms.SendKeys]::SendWait($env:JV_KEYS)`, { JV_KEYS: keys });
      return ok(`pressed: ${keys}`);
    } catch (e) {
      return fail(e);
    }
  },
);

const mouse = tool(
  "mouse",
  "Move the mouse and optionally click. Give coordinates as you read them off the most recent `screenshot` image — they're mapped to the real screen automatically, even if the image was scaled down. Always take a fresh screenshot right before clicking so the coordinates match the current screen.",
  {
    x: z.number().describe("X coordinate in pixels"),
    y: z.number().describe("Y coordinate in pixels"),
    click: z.enum(["none", "left", "right", "double"]).default("none").describe("Click to perform after moving"),
  },
  async ({ x, y, click }) => {
    try {
      // The screenshot the model saw was likely downscaled; scale its
      // coordinates back to real screen pixels so the click lands on target.
      const scale = lastShot && lastShot.sentWidth ? lastShot.realWidth / lastShot.sentWidth : 1;
      const realX = Math.round(x * scale);
      const realY = Math.round(y * scale);
      await runPowerShell(
        `${WINAPI}
        [JvNative]::SetCursorPos([int]$env:JV_X, [int]$env:JV_Y) | Out-Null
        Start-Sleep -Milliseconds 60
        switch ($env:JV_CLICK) {
          'left'   { [JvNative]::mouse_event(0x02,0,0,0,0); [JvNative]::mouse_event(0x04,0,0,0,0) }
          'right'  { [JvNative]::mouse_event(0x08,0,0,0,0); [JvNative]::mouse_event(0x10,0,0,0,0) }
          'double' { [JvNative]::mouse_event(0x02,0,0,0,0); [JvNative]::mouse_event(0x04,0,0,0,0); Start-Sleep -Milliseconds 90; [JvNative]::mouse_event(0x02,0,0,0,0); [JvNative]::mouse_event(0x04,0,0,0,0) }
        }`,
        { JV_X: String(realX), JV_Y: String(realY), JV_CLICK: click },
      );
      return ok(`mouse -> (${realX}, ${realY})${click !== "none" ? ` ${click}-click` : ""}`);
    } catch (e) {
      return fail(e);
    }
  },
);

const scroll = tool(
  "scroll",
  "Scroll the mouse wheel. Positive `clicks` scrolls up, negative scrolls down (a 'click' is one wheel notch). Optionally move to x,y first (read off the latest screenshot) to scroll a specific pane; otherwise scrolls wherever the pointer is.",
  {
    clicks: z.number().int().describe("Wheel notches; positive = up, negative = down"),
    x: z.number().optional().describe("Optional X to move to before scrolling"),
    y: z.number().optional().describe("Optional Y to move to before scrolling"),
  },
  async ({ clicks, x, y }) => {
    try {
      const scale = lastShot && lastShot.sentWidth ? lastShot.realWidth / lastShot.sentWidth : 1;
      // WHEEL delta is 120 per notch; a negative delta scrolls down. mouse_event
      // takes a uint, so pass the two's-complement (>>> 0) form for negatives.
      const perNotch = (clicks < 0 ? -120 : 120) >>> 0;
      const notches = Math.abs(clicks);
      const move =
        x != null && y != null
          ? `[JvNative]::SetCursorPos([int]$env:JV_X, [int]$env:JV_Y) | Out-Null\n        Start-Sleep -Milliseconds 60`
          : "";
      await runPowerShell(
        `${WINAPI}
        ${move}
        for ($i = 0; $i -lt [int]$env:JV_N; $i++) {
          [JvNative]::mouse_event(0x0800, 0, 0, [uint32]$env:JV_DELTA, 0)
          Start-Sleep -Milliseconds 20
        }`,
        {
          JV_X: String(Math.round((x ?? 0) * scale)),
          JV_Y: String(Math.round((y ?? 0) * scale)),
          JV_DELTA: String(perNotch),
          JV_N: String(notches),
        },
      );
      return ok(`scrolled ${clicks > 0 ? "up" : "down"} ${notches} notch(es)`);
    } catch (e) {
      return fail(e);
    }
  },
);

const drag = tool(
  "drag",
  "Press the left button at one point and release at another — for dragging sliders, files, or selections. Give both points as read off the most recent `screenshot`; they're mapped to the real screen automatically.",
  {
    from_x: z.number().describe("Start X"),
    from_y: z.number().describe("Start Y"),
    to_x: z.number().describe("End X"),
    to_y: z.number().describe("End Y"),
  },
  async ({ from_x, from_y, to_x, to_y }) => {
    try {
      const scale = lastShot && lastShot.sentWidth ? lastShot.realWidth / lastShot.sentWidth : 1;
      const s = (n: number) => String(Math.round(n * scale));
      await runPowerShell(
        `${WINAPI}
        [JvNative]::SetCursorPos([int]$env:JV_FX, [int]$env:JV_FY) | Out-Null
        Start-Sleep -Milliseconds 80
        [JvNative]::mouse_event(0x02,0,0,0,0)  # left down
        Start-Sleep -Milliseconds 80
        [JvNative]::SetCursorPos([int]$env:JV_TX, [int]$env:JV_TY) | Out-Null
        Start-Sleep -Milliseconds 80
        [JvNative]::mouse_event(0x04,0,0,0,0)  # left up`,
        { JV_FX: s(from_x), JV_FY: s(from_y), JV_TX: s(to_x), JV_TY: s(to_y) },
      );
      return ok(`dragged (${s(from_x)}, ${s(from_y)}) -> (${s(to_x)}, ${s(to_y)})`);
    } catch (e) {
      return fail(e);
    }
  },
);

const clipboardRead = tool("clipboard_read", "Read the current text contents of the clipboard.", {}, async () => {
  try {
    const out = await runPowerShell(`Get-Clipboard -Raw`);
    return ok(out || "(clipboard empty)");
  } catch (e) {
    return fail(e);
  }
});

const clipboardWrite = tool(
  "clipboard_write",
  "Replace the clipboard contents with the given text.",
  { text: z.string() },
  async ({ text }) => {
    try {
      await runPowerShell(`Set-Clipboard -Value $env:JV_TEXT`, { JV_TEXT: text });
      return ok(`clipboard set (${text.length} chars)`);
    } catch (e) {
      return fail(e);
    }
  },
);

export type Presence = { idleSeconds: number; foreground: string; state: "active" | "idle" | "away" };

/**
 * Who's at the keyboard. Exported so the ambient loop can poll it directly —
 * that path costs zero tokens because the model is never involved.
 */
export async function getPresence(): Promise<Presence> {
  const out = await runPowerShell(`${WINAPI_IDLE}
    $lii = New-Object JvIdle+LASTINPUTINFO
    $lii.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($lii)
    [void][JvIdle]::GetLastInputInfo([ref]$lii)
    $idle = [math]::Round(([JvIdle]::GetTickCount() - $lii.dwTime)/1000)
    $sb = New-Object System.Text.StringBuilder 512
    [void][JvIdle]::GetWindowText([JvIdle]::GetForegroundWindow(), $sb, 512)
    "$idle|$($sb.ToString())"`);
  const [idleStr, ...rest] = out.split("|");
  const idleSeconds = Number(idleStr) || 0;
  return {
    idleSeconds,
    foreground: rest.join("|").trim(),
    state: idleSeconds < 60 ? "active" : idleSeconds < 300 ? "idle" : "away",
  };
}

const userPresence = tool(
  "user_presence",
  "Check whether the user is actually at the machine right now: seconds since their last keyboard/mouse input, and which window is in the foreground. Use this before interrupting, to greet them when they come back, or to judge how long they've been heads-down.",
  {},
  async () => {
    try {
      const p = await getPresence();
      return ok(`idle_seconds: ${p.idleSeconds}\nforeground_window: ${p.foreground}\nstate: ${p.state}`);
    } catch (e) {
      return fail(e);
    }
  },
);

export type SystemStats = { cpu: number; memUsedGb: number; memTotalGb: number; battery: number | null };

/**
 * Machine vitals as structured numbers. Exported so the UI's live telemetry
 * footer can poll it directly over HTTP — that path costs zero tokens because
 * the model is never involved.
 */
export async function getSystemStats(): Promise<SystemStats> {
  const out = await runPowerShell(`
    $os = Get-CimInstance Win32_OperatingSystem
    $cpu = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average
    $usedGb = [math]::Round(($os.TotalVisibleMemorySize - $os.FreePhysicalMemory)/1MB, 1)
    $totalGb = [math]::Round($os.TotalVisibleMemorySize/1MB, 1)
    $bat = (Get-CimInstance Win32_Battery | Select-Object -First 1).EstimatedChargeRemaining
    "$cpu|$usedGb|$totalGb|$bat"`);
  const [cpu, used, total, bat] = out.split("|");
  return {
    cpu: Math.round(Number(cpu)) || 0,
    memUsedGb: Number(used) || 0,
    memTotalGb: Number(total) || 0,
    battery: bat && bat.trim() ? Number(bat) : null,
  };
}

const systemStatus = tool(
  "system_status",
  "Get CPU load, memory use, and battery level for a quick machine health readout.",
  {},
  async () => {
    try {
      const s = await getSystemStats();
      const bat = s.battery != null ? `${s.battery}%` : "n/a (desktop)";
      return ok(`CPU: ${s.cpu}%\nMemory: ${s.memUsedGb} GB / ${s.memTotalGb} GB\nBattery: ${bat}`);
    } catch (e) {
      return fail(e);
    }
  },
);

/** In-process MCP server exposing computer control to the agent. */
export const computerServer = createSdkMcpServer({
  name: "computer",
  version: "0.1.0",
  instructions:
    "Control the user's Windows machine: see the screen, move/click the mouse, type, press keys, launch apps, manage the clipboard, and read system status. Take a screenshot before clicking so you know where things are. Routine actions run directly; destructive commands are held for the user's approval.",
  tools: [
    screenshot,
    describeScreen,
    readScreenText,
    listApps,
    listWindows,
    focusWindow,
    launchApp,
    typeText,
    pressKeys,
    mouse,
    scroll,
    drag,
    clipboardRead,
    clipboardWrite,
    userPresence,
    systemStatus,
  ],
});
