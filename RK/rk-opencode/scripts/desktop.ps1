param(
    [Parameter(Mandatory=$true)][string]$WindowTitle,
    [switch]$OCR,
    [switch]$ExecuteHID
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$rkRoot = Split-Path $repo -Parent
$parameters = @((Join-Path $repo 'desktop_host.py'), '--title', $WindowTitle)
if ($OCR) { $parameters += '--ocr' }
if ($ExecuteHID) { $parameters += '--execute-hid' }
& (Join-Path $rkRoot '.venv/Scripts/python.exe') @parameters
if ($LASTEXITCODE -ne 0) { throw 'Desktop companion failed. See .runtime/observer.log.' }
