# Registers a real global hotkey via RegisterHotKey (NOT a keyboard hook) and
# prints a line to stdout each time it fires. Node reads those lines.
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Windows.Forms;
public class JvHotkey : Form {
  [DllImport("user32.dll")] public static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);
  [DllImport("user32.dll")] public static extern bool UnregisterHotKey(IntPtr hWnd, int id);
  public const int WM_HOTKEY = 0x0312;
  public JvHotkey(uint mods, uint vk) {
    this.ShowInTaskbar = false; this.WindowState = FormWindowState.Minimized;
    RegisterHotKey(this.Handle, 1, mods, vk);
  }
  protected override void WndProc(ref Message m) {
    if (m.Msg == WM_HOTKEY) { Console.WriteLine("HOTKEY"); Console.Out.Flush(); }
    base.WndProc(ref m);
  }
  protected override void SetVisibleCore(bool value) { base.SetVisibleCore(false); }
}
"@ -ReferencedAssemblies System.Windows.Forms, System.Drawing

# MOD_ALT=1 MOD_CONTROL=2 MOD_SHIFT=4 ; VK_J = 0x4A
$mods = 2 -bor 1   # Ctrl+Alt
$vk = 0x4A         # J
Write-Output "READY"
$form = New-Object JvHotkey($mods, $vk)
[System.Windows.Forms.Application]::Run($form)
