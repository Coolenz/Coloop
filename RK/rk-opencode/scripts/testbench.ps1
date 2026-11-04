param(
    [ValidateSet('ocr', 'hybrid')][string]$Perception = 'ocr',
    [ValidateSet('compact', 'opencode', 'opencode-fast')][string]$Runner = 'opencode-fast',
    [string]$Code,
    [int]$Timeout = 600,
    [ValidatePattern('^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$')][string]$Profile = 'qwen35-4b',
    [switch]$WaitStart,
    [switch]$EnableHid
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$python = Join-Path (Split-Path $repo -Parent) '.venv/Scripts/python.exe'
$benchArgs = @('-u', (Join-Path $repo 'testbench.py'), '--perception', $Perception, '--runner', $Runner, '--timeout', "$Timeout", '--profile', $Profile)
if ($Code) { $benchArgs += @('--code', $Code) }
if ($WaitStart) { $benchArgs += '--wait-start' }
if ($EnableHid) { $benchArgs += '--enable-hid' }
& $python @benchArgs
exit $LASTEXITCODE
