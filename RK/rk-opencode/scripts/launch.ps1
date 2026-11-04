param([switch]$StopModel, [switch]$Chat, [switch]$NativeDesktop,
      [ValidateSet('rk-local','rk-memory','rk-desktop','rk-desktop-fast')][string]$Agent = 'rk-local',
      [ValidatePattern('^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$')][string]$Profile = 'qwen35-4b')
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$rkRoot = Split-Path $repo -Parent
$beforeInput = [Console]::InputEncoding
$beforeOutput = [Console]::OutputEncoding
$beforePipeline = $OutputEncoding
try {
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    [Console]::InputEncoding = $utf8
    [Console]::OutputEncoding = $utf8
    $OutputEncoding = $utf8
    if ($StopModel) {
        $remote = 'cd ~/rk-opencode && bash scripts/stop-model.sh'
    } elseif ($NativeDesktop) {
        $remote = 'cd ~/rk-opencode && RK_AGENT_PROFILE=' + $Profile + ' bash scripts/hid-agent.sh'
    } elseif ($Chat) {
        $remote = 'cd ~/rk-opencode && RK_AGENT_PROFILE=' + $Profile + ' bash scripts/opencode.sh --agent rk-chat'
    } else {
        $remote = 'cd ~/rk-opencode && RK_AGENT_PROFILE=' + $Profile + ' bash scripts/opencode.sh --agent ' + $Agent
    }
    & ssh.exe -t -F (Join-Path $rkRoot 'config/ssh_config') lubancat4-usb $remote
    $result = $LASTEXITCODE
} finally {
    [Console]::InputEncoding = $beforeInput
    [Console]::OutputEncoding = $beforeOutput
    $OutputEncoding = $beforePipeline
}
if ($result -ne 0) { throw "OpenCode exited with code $result" }
