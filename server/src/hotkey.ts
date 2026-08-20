// Global hotkey (Ctrl+Alt+J by default) so you can talk to Jarvis without the
// browser tab being focused.
//
// Uses Windows' RegisterHotKey via a hidden PowerShell message-loop window —
// NOT a low-level keyboard hook. A hook is what keyloggers use and gets flagged
// by antivirus; RegisterHotKey is the sanctioned API for exactly this.
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";

let proc: ChildProcess | null = null;

/** Start listening for the global hotkey. `onPress` fires on each activation. */
export function startHotkey(onPress: () => void) {
  if (proc) return;
  // Relative to THIS file, not the cwd — started from anywhere but server/, a
  // cwd-relative path silently never finds the script and the hotkey never arms.
  const script = join(import.meta.dirname, "..", "scripts", "hotkey.ps1");
  proc = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], {
    windowsHide: true,
  });

  proc.stdout?.on("data", (d: Buffer) => {
    for (const line of d.toString().split("\n")) {
      const t = line.trim();
      if (t === "READY") console.log("[hotkey] Ctrl+Alt+J armed");
      else if (t === "HOTKEY") onPress();
    }
  });
  proc.stderr?.on("data", (d: Buffer) => console.error("[hotkey]", d.toString().trim()));
  proc.on("exit", (code) => {
    console.log(`[hotkey] listener exited (${code})`);
    proc = null;
  });
}

export function stopHotkey() {
  proc?.kill();
  proc = null;
}
