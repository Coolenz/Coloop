function Show-ColoopOfficeWindow([long]$Handle) {
  Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class ColoopOfficeWindow { [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p); [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint f); [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int c); [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h); }'
  $windowId = [ColoopOfficeWindow]::GetAncestor([IntPtr]$Handle, 2).ToInt64()
  [uint32]$ownerProcessId = 0
  [void][ColoopOfficeWindow]::GetWindowThreadProcessId([IntPtr]$windowId, [ref]$ownerProcessId)
  if ($windowId -le 0 -or $ownerProcessId -eq 0) { throw 'OFFICE_WINDOW_UNAVAILABLE' }
  [void][ColoopOfficeWindow]::ShowWindowAsync([IntPtr]$windowId, 3)
  Start-Sleep -Milliseconds 100
  return @{ window_id = [string]$windowId; process_id = $ownerProcessId; visible = [ColoopOfficeWindow]::IsWindowVisible([IntPtr]$windowId) }
}
