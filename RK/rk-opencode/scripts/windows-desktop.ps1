param(
    [Parameter(Mandatory=$true)][string]$WindowTitle,
    [string[]]$AllowFile = @(),
    [switch]$Execute,
    [switch]$OCR,
    [switch]$Install
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$rkRoot = Split-Path $repo -Parent
$parameters = @((Join-Path $repo 'windows_host.py'), '--title', $WindowTitle)
foreach ($path in $AllowFile) { $parameters += @('--allow-file', $path) }
if ($Execute) { $parameters += '--execute' }
if ($OCR) { $parameters += '--ocr' }
if ($Install) { $parameters += '--install' }
& (Join-Path $rkRoot '.venv/Scripts/python.exe') @parameters
if ($LASTEXITCODE -ne 0) { throw 'Windows companion failed. Inspect its service.log.' }
