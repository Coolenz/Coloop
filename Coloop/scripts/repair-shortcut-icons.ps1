param(
  [string]$InstallDirectory = (Join-Path $env:LOCALAPPDATA 'Programs\Coloop'),
  [switch]$RestoreWindow
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'workspace-cache.ps1')
$installation = (Resolve-Path -LiteralPath $InstallDirectory).Path
$executable = Join-Path $installation 'Coloop.exe'
$icon = Join-Path $installation 'resources\icon.ico'
if (!(Test-Path -LiteralPath $executable -PathType Leaf)) { throw 'Coloop executable not found' }
if (!(Test-Path -LiteralPath $icon -PathType Leaf)) { throw 'Coloop icon not found' }
$shell = New-Object -ComObject WScript.Shell
$folders = @(
  [Environment]::GetFolderPath('Desktop'),
  (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'),
  (Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar')
)
$updated = @()
foreach ($folder in $folders) {
  if (!(Test-Path -LiteralPath $folder -PathType Container)) { continue }
  foreach ($file in Get-ChildItem -LiteralPath $folder -Filter '*.lnk' -Recurse) {
    $shortcut = $shell.CreateShortcut($file.FullName)
    if (![string]::Equals($shortcut.TargetPath, $executable, [StringComparison]::OrdinalIgnoreCase)) { continue }
    $shortcut.IconLocation = "$icon,0"
    $shortcut.Save()
    $readback = $shell.CreateShortcut($file.FullName)
    if ($readback.IconLocation -ne "$icon,0") { throw "Shortcut icon readback failed: $($file.FullName)" }
    $updated += $file.FullName
  }
}
if (!('ColoopShortcutRefresh' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class ColoopShortcutRefresh {
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
  public static extern void SHChangeNotify(uint eventId, uint flags, string item1, IntPtr item2);
  public delegate bool EnumProc(IntPtr window, IntPtr value);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr value);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr window, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint id);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr window);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr window, int command);
  public static long[] FindMainWindows(uint processId) {
    var windows = new List<long>();
    EnumWindows((window, value) => {
      uint id; GetWindowThreadProcessId(window, out id);
      var title = new StringBuilder(512); GetWindowText(window, title, 512);
      if (id == processId && (title.ToString() == "Coloop" || title.ToString() == "Coloop · 智能工作台")) windows.Add(window.ToInt64());
      return true;
    }, IntPtr.Zero);
    return windows.ToArray();
  }
}
'@
}
foreach ($path in $updated) { [ColoopShortcutRefresh]::SHChangeNotify(0x2000, 0x1005, $path, [IntPtr]::Zero) }
$windows = @()
if ($RestoreWindow) {
  foreach ($process in Get-Process Coloop -ErrorAction SilentlyContinue) {
    if (![string]::Equals($process.Path, $executable, [StringComparison]::OrdinalIgnoreCase)) { continue }
    foreach ($handleValue in [ColoopShortcutRefresh]::FindMainWindows($process.Id)) {
      $handle = [IntPtr]$handleValue
      if (![ColoopShortcutRefresh]::IsWindowVisible($handle)) {
        # SW_SHOWMINNOACTIVE retains the running task's foreground application.
        [ColoopShortcutRefresh]::ShowWindowAsync($handle, 7) | Out-Null
        Start-Sleep -Milliseconds 300
      }
      $windows += [pscustomobject]@{handle=$handleValue;visible=[ColoopShortcutRefresh]::IsWindowVisible($handle);minimized=[ColoopShortcutRefresh]::IsIconic($handle)}
    }
  }
}
[pscustomobject]@{ok=$true; icon=$icon; updated=$updated; windows=$windows} | ConvertTo-Json -Depth 3
