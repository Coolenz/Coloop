$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)
if (-not (Get-Command uv -ErrorAction SilentlyContinue)) { throw 'Install uv first: https://docs.astral.sh/uv/getting-started/installation/' }
if (-not (Test-Path .venv/Scripts/python.exe)) {
    uv venv --python 3.12 .venv
    if ($LASTEXITCODE -ne 0) { throw 'Python environment creation failed' }
}
$requirements = if (Test-Path requirements-host.lock.txt) { 'requirements-host.lock.txt' } else { 'requirements-host.txt' }
uv pip install --python .venv/Scripts/python.exe -r $requirements --index-url https://pypi.tuna.tsinghua.edu.cn/simple/ --link-mode copy
if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed' }
& ./.venv/Scripts/python.exe tools/doctor.py
if ($LASTEXITCODE -ne 0) { throw 'Environment check failed' }
& ./.venv/Scripts/python.exe tools/smoke_onnx.py
if ($LASTEXITCODE -ne 0) { throw 'ONNX check failed' }
