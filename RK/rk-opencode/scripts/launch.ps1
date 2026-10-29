param([switch]$StopModel, [switch]$Chat,
      [ValidateSet('rk-local','rk-memory','rk-desktop','rk-desktop-fast')][string]$Agent = 'rk-local')
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
    } elseif ($Chat) {
        $remote = 'cd ~/rk-opencode && bash scripts/start.sh && bash scripts/opencode.sh --agent rk-chat'
    } else {
        $remote = 'cd ~/rk-opencode && bash scripts/start.sh && bash scripts/opencode.sh --agent ' + $Agent
    }
    & ssh.exe -t -F (Join-Path $rkRoot 'config/ssh_config') lubancat4-usb $remote
    $result = $LASTEXITCODE
} finally {
    [Console]::InputEncoding = $beforeInput
    [Console]::OutputEncoding = $beforeOutput
    $OutputEncoding = $beforePipeline
}
if ($result -ne 0) { throw "OpenCode exited with code $result" }
