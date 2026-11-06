param([string]$Python = 'python', [switch]$SkipModels)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'workspace-cache.ps1')
$taskRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$runtimeRoot = Join-Path $taskRoot '.cache/docling'
$runtimePython = Join-Path $runtimeRoot '.venv/Scripts/python.exe'
$models = Join-Path $runtimeRoot 'models'
New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null
if (-not (Test-Path -LiteralPath $runtimePython)) {
    & $Python -m venv (Join-Path $runtimeRoot '.venv')
    if ($LASTEXITCODE -ne 0) { throw 'Docling venv creation failed' }
}
& $runtimePython -m pip install --disable-pip-version-check 'torch==2.9.1' 'torchvision==0.24.1' --index-url 'https://download.pytorch.org/whl/cpu'
if ($LASTEXITCODE -ne 0) { throw 'Docling CPU runtime installation failed' }
& $runtimePython -m pip install --disable-pip-version-check 'docling[rapidocr]==2.147.0'
if ($LASTEXITCODE -ne 0) { throw 'Docling installation failed' }
if (-not $SkipModels) {
    New-Item -ItemType Directory -Force -Path $models | Out-Null
    & $runtimePython -m docling.cli.tools models download --output-dir $models --rapidocr-backend-lang onnxruntime:ch layout tableformer rapidocr
    if ($LASTEXITCODE -ne 0) { throw 'Docling model download failed' }
    $manifest = @(Get-ChildItem -LiteralPath $models -Recurse -File |
        Where-Object { $_.Name -ne 'manifest.json' -and $_.FullName -notmatch '[\\/]\.cache[\\/]huggingface[\\/]' } |
        Sort-Object FullName | ForEach-Object {
            [ordered]@{ path = $_.FullName.Substring($models.Length + 1); sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant() }
        })
    $manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $models 'manifest.json') -Encoding UTF8
}
& $runtimePython -m pip freeze | Set-Content -LiteralPath (Join-Path $runtimeRoot 'installed-requirements.txt') -Encoding UTF8
if ($LASTEXITCODE -ne 0) { throw 'Docling dependency manifest failed' }
Write-Output "Docling 2.147.0 ready: $runtimePython"
Write-Output "Models: $models. Worker conversion runs offline."
