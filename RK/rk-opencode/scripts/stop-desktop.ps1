$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
New-Item -ItemType File -Force -Path (Join-Path $repo '.runtime/desktop-stop') | Out-Null
