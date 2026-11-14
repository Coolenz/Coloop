param([Parameter(Mandatory=$true)][string]$KeepPackageDirectory, [switch]$ListOnly, [switch]$IncludeCurrent, [switch]$OnlyCurrent)
$ErrorActionPreference = 'Stop'
if ($OnlyCurrent -and !$IncludeCurrent) { throw 'OnlyCurrent requires IncludeCurrent' }
. (Join-Path $PSScriptRoot 'local-install-copy.ps1')
$release = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\release')).Path.TrimEnd('\')
$keep = (Resolve-Path -LiteralPath $KeepPackageDirectory).Path.TrimEnd('\')
$keepRoot = [IO.Path]::GetDirectoryName($keep)
if ([IO.Path]::GetFileName($keep) -ne 'win-unpacked' -or [IO.Path]::GetDirectoryName($keepRoot) -ne $release) {
  throw 'Keep package must be release/<version>/win-unpacked'
}
Assert-ColoopPlainTree $keepRoot
$main = 'resources\app\out\main\index.js'
$installed = Join-Path $env:LOCALAPPDATA ('Programs\Coloop\' + $main)
if (!(Test-Path -LiteralPath (Join-Path $keep $main)) -or !(Test-Path -LiteralPath $installed) -or
    (Get-ColoopFileHash (Join-Path $keep $main)) -ne (Get-ColoopFileHash $installed)) {
  throw 'Only prune after the retained package matches the actual installation'
}
$processes = Get-CimInstance Win32_Process
# Restrict this run to the explicitly named candidate without enumerating historical packages.
$entries = if ($OnlyCurrent) { @(Get-Item -LiteralPath $keepRoot) } else { @(Get-ChildItem -LiteralPath $release -Directory) }
foreach ($entry in $entries) {
  if ((!$IncludeCurrent -and $entry.FullName -eq $keepRoot) -or $entry.Name -eq 'android') { continue }
  if (!(Test-Path -LiteralPath (Join-Path $entry.FullName 'win-unpacked\Coloop.exe') -PathType Leaf)) { continue }
  $target = (Resolve-Path -LiteralPath $entry.FullName).Path
  if ([IO.Path]::GetDirectoryName($target) -ne $release) { throw 'Cleanup target escaped release' }
  Assert-ColoopPlainTree $target
  if ($processes | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($target + '\', [StringComparison]::OrdinalIgnoreCase) }) {
    throw "Old package is still running: $target"
  }
  if ($ListOnly) { [pscustomobject]@{candidate=$target;keep=$keepRoot} | ConvertTo-Json -Compress }
  else { Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction Stop; [pscustomobject]@{removed=$target} }
}
