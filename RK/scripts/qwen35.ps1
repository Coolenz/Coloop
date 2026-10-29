param(
    [ValidateSet('9B','4B')][string]$ModelSize = '9B',
    [ValidateRange(1,1024)][int]$MaxNewTokens = 128,
    [ValidateRange(512,16384)][int]$ContextLength = 16384,
    [switch]$SampleImage,
    [string]$BoardImage = ''
)
$ErrorActionPreference = 'Stop'
if ($MaxNewTokens -ge $ContextLength) { throw 'Output limit must be smaller than context.' }
$projectRoot = Split-Path $PSScriptRoot -Parent
if ($SampleImage) { $BoardImage = 'samples/moon.jpg' }
if (-not $BoardImage -and $ModelSize -eq '9B') {
    Write-Warning 'Experimental deployment: text-only quality validation has FAILED. See docs/09-qwen35.md.'
}
if ($ModelSize -eq '4B') { Write-Warning 'Experimental Qwen3.5-4B: a repeated word-problem test FAILED; basic non-math tests mostly passed. See docs/12-qwen35-evaluation.md.' }
function Quote-Bash([string]$Value) {
    return "'" + $Value.Replace("'", "'\''") + "'"
}
$scriptText = 'export LANG=C.UTF-8 LC_ALL=C.UTF-8; stty iutf8; bash "$HOME/rk-edge-ai/qwen35/run.sh"'
if ($ModelSize -eq '4B') { $scriptText = $scriptText.Replace('/qwen35/run.sh', '/qwen35-4b/run.sh') }
$scriptText += " --tokens $MaxNewTokens --context $ContextLength"
if ($BoardImage) { $scriptText += ' --image ' + (Quote-Bash $BoardImage) }
$encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($scriptText))
# Avoid embedded double quotes in a Windows PowerShell 5.1 native argument.
# Execute a temporary script file so the application retains the SSH terminal.
$remoteCommand = 'umask 077; p=$(mktemp /tmp/qwen35-start.XXXXXX); trap ''rm -f $p'' EXIT; printf %s ' + $encoded + ' | base64 -d >$p; bash $p'
$previousInput = [Console]::InputEncoding
$previousOutput = [Console]::OutputEncoding
$previousPipeline = $OutputEncoding
try {
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    [Console]::InputEncoding = $utf8
    [Console]::OutputEncoding = $utf8
    $OutputEncoding = $utf8
    & ssh.exe -t -F (Join-Path $projectRoot 'config/ssh_config') lubancat4-usb $remoteCommand
    $resultCode = $LASTEXITCODE
} finally {
    [Console]::InputEncoding = $previousInput
    [Console]::OutputEncoding = $previousOutput
    $OutputEncoding = $previousPipeline
}
if ($resultCode -ne 0) { throw "Qwen3.5-$ModelSize exited with code $resultCode" }
