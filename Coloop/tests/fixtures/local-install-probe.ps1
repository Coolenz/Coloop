param([string]$Source, [string]$Programs, [string]$NodeExecutable)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\..\scripts\local-install-copy.ps1')
Copy-ColoopInstallation -Source $Source -Programs $Programs -NodeExecutable $NodeExecutable | ConvertTo-Json -Compress
