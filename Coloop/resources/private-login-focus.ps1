param([Parameter(Mandatory=$true)][Int64]$WindowHandle)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ColoopPrivateFocus {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
    [DllImport("user32.dll")] public static extern IntPtr GetKeyboardLayout(uint t);
    [DllImport("user32.dll")] public static extern short GetKeyState(int k);
    [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int k);
}
'@ | Out-Null
while ($null -ne ($request = [Console]::ReadLine())) {
    try {
        $target = [IntPtr]::new($WindowHandle)
        $foreground = [ColoopPrivateFocus]::GetForegroundWindow()
        $owner = [uint32]0
        $threadId = [ColoopPrivateFocus]::GetWindowThreadProcessId($foreground, [ref]$owner)
        $layout = [ColoopPrivateFocus]::GetKeyboardLayout($threadId).ToInt64() -band 0xffffffffL
        $caps = ([ColoopPrivateFocus]::GetKeyState(20) -band 1) -ne 0
        $modifiers = @(17,18,91,92)
        if ($request -eq 'initial') { $modifiers += 16 }
        $pressed = $false
        foreach ($keyCode in $modifiers) {
            if (([ColoopPrivateFocus]::GetAsyncKeyState($keyCode) -band 0x8000) -ne 0) { $pressed = $true }
        }
        $safe = $foreground -eq $target -and $layout -eq 0x04090409 -and -not $caps -and -not $pressed
        [Console]::WriteLine($(if ($safe) { 'true' } else { 'false' }))
    } catch { [Console]::WriteLine('false') }
}
