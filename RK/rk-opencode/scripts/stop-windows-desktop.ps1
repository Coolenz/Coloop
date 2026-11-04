$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$runtime = Join-Path $repo '.runtime'
New-Item -ItemType Directory -Path $runtime -Force | Out-Null
New-Item -ItemType File -Path (Join-Path $runtime 'windows-desktop-stop') -Force | Out-Null
