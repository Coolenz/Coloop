param(
    [ValidatePattern('^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$')][string]$Profile = 'qwen35-4b'
)
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
    $remote = 'cd ~/rk-opencode && RK_AGENT_PROFILE=' + $Profile + ' bash scripts/windows-agent.sh'
    & ssh.exe -t -F (Join-Path $rkRoot 'config/ssh_config') lubancat4-usb $remote
    $result = $LASTEXITCODE
} finally {
    [Console]::InputEncoding = $beforeInput
    [Console]::OutputEncoding = $beforeOutput
    $OutputEncoding = $beforePipeline
}
if ($result -ne 0) { throw "Windows desktop agent exited with code $result" }
