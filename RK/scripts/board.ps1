param([ValidateSet('check', 'resnet', 'smoke', 'shell')][string]$Action = 'check')
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
if ($Action -eq 'shell') {
    & ssh.exe -F (Join-Path $projectRoot 'config/ssh_config') lubancat4-usb
} else {
    & (Join-Path $projectRoot '.venv/Scripts/python.exe') (Join-Path $projectRoot 'tools/board_remote.py') --run $Action
}
if ($LASTEXITCODE -ne 0) { throw "Board action failed: $Action" }
