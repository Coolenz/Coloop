$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$target = Join-Path $root 'third_party/rknn-toolkit2'
if (Test-Path $target) { throw "Already exists: $target. Keeping existing SDK untouched." }
New-Item -ItemType Directory -Force (Split-Path $target -Parent) | Out-Null
git clone --depth 1 --branch v2.3.2 https://github.com/airockchip/rknn-toolkit2.git $target
if ($LASTEXITCODE -ne 0) { throw 'SDK download failed; retry after checking GitHub access.' }
git -C $target rev-parse HEAD
