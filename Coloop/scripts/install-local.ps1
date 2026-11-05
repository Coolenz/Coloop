param(
  [Parameter(Mandatory = $true)][string]$PackageDirectory
)
$ErrorActionPreference = 'Stop'
$installMutex = [Threading.Mutex]::new($false, 'Local\ColoopLocalDeployment')
if (!$installMutex.WaitOne(0)) {
  $installMutex.Dispose()
  throw 'Another Coloop deployment is in progress. Wait for it to finish before retrying.'
}
try {
$source = (Resolve-Path -LiteralPath $PackageDirectory).Path
$programs = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Programs'))
$target = Join-Path $programs 'Coloop'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$stage = Join-Path $programs "Coloop-update-$stamp"
$backup = Join-Path $programs "Coloop-backup-$stamp"

foreach ($path in @($target, $stage, $backup)) {
  if ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($path)) -ne $programs) {
    throw "Installation path escaped Programs: $path"
  }
}
if ($source -eq $target -or $source.StartsWith($target + '\', [StringComparison]::OrdinalIgnoreCase)) {
  throw 'The package source must be separate from the installed application.'
}
$required = @('Coloop.exe', 'resources\app\package.json', 'resources\app\out\main\index.js',
  'resources\app\out\renderer\index.html', 'resources\app\out\preload\control.cjs',
  'resources\runtime\node\node.exe', 'resources\runtime\docling\.venv\Scripts\python.exe',
  'resources\runtime\cua-driver\cua-driver.exe')
foreach ($file in $required) {
  if (!(Test-Path -LiteralPath (Join-Path $source $file) -PathType Leaf)) {
    throw "Incomplete package: $file"
  }
}
& (Join-Path $source 'resources\runtime\node\node.exe') (Join-Path $PSScriptRoot 'verify-package-dependencies.mjs') (Join-Path $source 'resources\app') | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Package dependency verification failed; rebuild with afterPack before installation.' }
function Assert-AppStopped {
  if (Get-Process -Name Coloop -ErrorAction SilentlyContinue) {
    throw 'Coloop is running. Exit it normally before replacing the installation.'
  }
}
Assert-AppStopped
if ((Test-Path -LiteralPath $stage) -or (Test-Path -LiteralPath $backup)) {
  throw 'Deployment staging/backup directory already exists.'
}
New-Item -ItemType Directory -Path $programs -Force | Out-Null
& robocopy $source $stage /E /COPY:DAT /R:1 /W:1 /MT:16 /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "Package copy failed: robocopy exit $LASTEXITCODE" }
# Verify every packaged file before changing the existing installation.
$verify = @'
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const [source, stage] = process.argv.slice(1);
let count = 0;
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function walk(relative = '') {
  for (const entry of fs.readdirSync(path.join(source, relative), { withFileTypes: true })) {
    const next = path.join(relative, entry.name);
    if (entry.isDirectory()) walk(next);
    else {
      if (digest(path.join(source, next)) !== digest(path.join(stage, next)))
        throw new Error('Staged file mismatch: ' + next);
      count++;
    }
  }
}
walk(); console.log(count);
'@
$count = & (Join-Path $source 'resources\runtime\node\node.exe') -e $verify $source $stage
if ($LASTEXITCODE -ne 0) { throw 'Staged package hash verification failed.' }
Assert-AppStopped
$hadInstallation = Test-Path -LiteralPath $target
if ($hadInstallation) { [IO.Directory]::Move($target, $backup) }
try {
  [IO.Directory]::Move($stage, $target)
} catch {
  if ($hadInstallation -and !(Test-Path -LiteralPath $target)) {
    [IO.Directory]::Move($backup, $target)
  }
  throw
}
[pscustomobject]@{ installed = $target; backup = $(if ($hadInstallation) { $backup } else { $null });
  source = $source; verifiedFiles = $count } | ConvertTo-Json
} finally {
  $installMutex.ReleaseMutex()
  $installMutex.Dispose()
}
