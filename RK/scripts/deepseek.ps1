param(
    [ValidateRange(1,2048)][int]$MaxNewTokens = 512,
    [ValidateRange(512,4096)][int]$ContextLength = 2048
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$previousInputEncoding = [Console]::InputEncoding
$previousOutputEncoding = [Console]::OutputEncoding
$previousPipelineEncoding = $OutputEncoding
try {
    # Windows PowerShell and OpenSSH must agree on UTF-8 for Chinese input.
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    [Console]::InputEncoding = $utf8
    [Console]::OutputEncoding = $utf8
    $OutputEncoding = $utf8
    & ssh.exe -t -F (Join-Path $projectRoot 'config/ssh_config') lubancat4-usb "export LANG=C.UTF-8 LC_ALL=C.UTF-8; stty iutf8; bash ~/rk-edge-ai/deepseek/run.sh $MaxNewTokens $ContextLength"
    $deepseekExitCode = $LASTEXITCODE
} finally {
    [Console]::InputEncoding = $previousInputEncoding
    [Console]::OutputEncoding = $previousOutputEncoding
    $OutputEncoding = $previousPipelineEncoding
}
if ($deepseekExitCode -ne 0) { throw "DeepSeek exited with code $deepseekExitCode" }
