$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$pythonPath = Join-Path $projectRoot 'deployment\screen-ocr\.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $pythonPath)) { throw 'OCR environment is missing. See docs/10-screen-ocr.md.' }
$env:PYTHONUTF8 = '1'
& $pythonPath (Join-Path $projectRoot 'tools\screen_ocr.py') @args
exit $LASTEXITCODE
