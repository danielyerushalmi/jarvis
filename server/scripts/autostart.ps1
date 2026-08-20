# Make Jarvis always-present: start it hidden at login so the global hotkey
# (Ctrl+Alt+J) always works.
#
#   Install:    npm run autostart
#   Remove:     npm run autostart:off
#
# Installs a shortcut in your Startup folder. Nothing is written to the registry,
# and removing the shortcut fully undoes it.
param([switch]$Remove)

$startup  = [Environment]::GetFolderPath('Startup')
$linkPath = Join-Path $startup 'Jarvis.lnk'

if ($Remove) {
  if (Test-Path $linkPath) { Remove-Item $linkPath -Force; "Removed: $linkPath" }
  else { "Nothing to remove — Jarvis was not set to autostart." }
  return
}

# Project root = two levels up from server/scripts
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)

$shell = New-Object -ComObject WScript.Shell
$lnk = $shell.CreateShortcut($linkPath)
$lnk.TargetPath       = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$lnk.Arguments        = "-NoProfile -WindowStyle Hidden -Command `"Set-Location '$root'; npm run dev`""
$lnk.WorkingDirectory = $root
$lnk.WindowStyle      = 7   # minimized
$lnk.Description      = 'Jarvis personal assistant'
$lnk.Save()

"Installed: $linkPath"
"Jarvis will start hidden at login. Ctrl+Alt+J will summon it from anywhere."
"Remove any time with:  npm run autostart:off"
