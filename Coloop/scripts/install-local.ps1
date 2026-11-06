param(
  [Parameter(Mandatory = $true)][string]$PackageDirectory
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'workspace-cache.ps1')
. (Join-Path $PSScriptRoot 'local-install-copy.ps1')
$installMutex = [Threading.Mutex]::new($false, 'Local\ColoopLocalDeployment')
if (!$installMutex.WaitOne(0)) {
  $installMutex.Dispose()
  throw 'Another Coloop deployment is in progress. Wait for it to finish before retrying.'
}
try {
$source = (Resolve-Path -LiteralPath $PackageDirectory).Path
$programs = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Programs'))
$releaseRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\release'))
if (!$source.StartsWith($releaseRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Install from a verified package under this project release directory.'
}
Assert-ColoopPlainTree $source
$required = @('Coloop.exe', 'resources\app\package.json', 'resources\app\out\main\index.js',
  'resources\app\out\renderer\index.html', 'resources\app\out\preload\control.cjs',
  'resources\harness\coloop-plugin.mjs', 'resources\harness\coloop-compaction.mjs',
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
$installation = Copy-ColoopInstallation -Source $source -Programs $programs -NodeExecutable (Join-Path $source 'resources\runtime\node\node.exe')
# Finish installed-path acceptance before removing the only candidate package.
# No backups are created. The caller must prune all build copies after acceptance.
$installation | Add-Member -NotePropertyName cleanupStatus -NotePropertyValue 'pending_installed_acceptance'
$installation | ConvertTo-Json -Depth 4
} finally {
  $installMutex.ReleaseMutex()
  $installMutex.Dispose()
}
