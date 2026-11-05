param([string]$Destination)
$ErrorActionPreference = 'Stop'
$taskRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$cacheRoot = [IO.Path]::GetFullPath((Join-Path $taskRoot '.cache'))
$source = Join-Path $cacheRoot 'docling'
if (-not $Destination) { $Destination = Join-Path $cacheRoot 'docling-portable' }
$Destination = [IO.Path]::GetFullPath($Destination)
if (-not $Destination.StartsWith($cacheRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or
    $Destination.Equals($source, [StringComparison]::OrdinalIgnoreCase) -or
    $Destination.StartsWith($source + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Portable staging destination must be a distinct directory under this repository .cache'
}
if (-not (Test-Path -LiteralPath (Join-Path $source 'models/manifest.json'))) {
    throw 'Run setup-docling.ps1, including model installation, first'
}
$pythonVersion = '3.12.10'
$archiveName = "python-$pythonVersion-embed-amd64.zip"
$archive = Join-Path $source $archiveName
$expectedHash = '4acbed6dd1c744b0376e3b1cf57ce906f9dc9e95e68824584c8099a63025a3c3'
if (-not (Test-Path -LiteralPath $archive)) {
    Invoke-WebRequest "https://www.python.org/ftp/python/$pythonVersion/$archiveName" -OutFile $archive
}
if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedHash) {
    throw 'Official embeddable Python archive hash mismatch'
}
$scripts = Join-Path $Destination '.venv/Scripts'
$libraries = Join-Path $scripts 'Lib/site-packages'
$models = Join-Path $Destination 'models'
New-Item -ItemType Directory -Force -Path $scripts, $libraries, $models | Out-Null
if (Test-Path -LiteralPath (Join-Path $Destination '.venv/pyvenv.cfg')) {
    throw 'Staging contains a machine-bound venv; choose a fresh destination'
}
Expand-Archive -LiteralPath $archive -DestinationPath $scripts -Force
# This is an application-local embedded interpreter, not a copied venv launcher.
# Relative paths keep the standard library and vendored wheels independent of
# installed Python, registry state, environment variables and user site-packages.
@('python312.zip', '.', 'Lib', 'Lib/site-packages', 'import site') |
    Set-Content -LiteralPath (Join-Path $scripts 'python312._pth') -Encoding ASCII
& robocopy.exe (Join-Path $source '.venv/Lib/site-packages') $libraries /E /R:1 /W:1 /NFL /NDL /NJH /NJS /NP /XD __pycache__ /XF '*.pyc' '*.pyo' | Out-Null
if ($LASTEXITCODE -ge 8) { throw 'Portable Python package copy failed' }
& robocopy.exe (Join-Path $source 'models') $models /E /R:1 /W:1 /NFL /NDL /NJH /NJS /NP /XD .cache | Out-Null
if ($LASTEXITCODE -ge 8) { throw 'Portable Docling model copy failed' }
Copy-Item -LiteralPath (Join-Path $source 'installed-requirements.txt') -Destination $Destination -Force
$python = Join-Path $scripts 'python.exe'
$probeScript = Join-Path $source 'portable-probe.py'
@'
import sys,json,docling,torch,cv2,onnxruntime,importlib.metadata
from pathlib import Path
root = Path(sys.argv[1]).resolve()
assert Path(sys.prefix).is_relative_to(root)
assert Path(sys.base_prefix).is_relative_to(root)
assert all(Path(path).is_relative_to(root) for path in sys.path)
print(json.dumps({'python':sys.version,'prefix':sys.prefix,'base_prefix':sys.base_prefix,'path':sys.path,'docling':importlib.metadata.version('docling'),'torch':torch.__version__}))
'@ | Set-Content -LiteralPath $probeScript -Encoding UTF8
$savedPath = $env:PATH
$savedHome = $env:PYTHONHOME
$savedPythonPath = $env:PYTHONPATH
try {
    $env:PATH = Join-Path $env:SystemRoot 'System32'
    $env:PYTHONHOME = 'Z:\coloop-deliberately-nonexistent-python'
    $env:PYTHONPATH = 'Z:\coloop-deliberately-nonexistent-packages'
    $probe = & $python -I -B -X utf8 $probeScript $Destination
    if ($LASTEXITCODE -ne 0) { throw 'Embedded Docling runtime probe failed' }
    $probe | ConvertFrom-Json | Out-Null
    $probe | Set-Content -LiteralPath (Join-Path $Destination 'runtime-probe.json') -Encoding UTF8
} finally {
    $env:PATH = $savedPath
    $env:PYTHONHOME = $savedHome
    $env:PYTHONPATH = $savedPythonPath
}
$size = (Get-ChildItem -LiteralPath $Destination -File -Recurse | Measure-Object Length -Sum).Sum
[ordered]@{
    python = $pythonVersion
    pythonArchive = $archiveName
    pythonArchiveSha256 = $expectedHash
    docling = '2.147.0'
    bytes = $size
    noSystemPythonRequired = $true
    verificationScope = 'Import probe with system Python paths removed; document conversion tested separately'
} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $Destination 'portable-manifest.json') -Encoding UTF8
Write-Output "Portable Docling staged at $Destination ($size bytes)"
Write-Output 'Copy this directory to resources/runtime/docling. Keep .venv/Scripts/python.exe unchanged.'
