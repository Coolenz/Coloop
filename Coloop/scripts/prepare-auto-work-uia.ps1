param()
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'workspace-cache.ps1')
$workspaceRoot = Split-Path $PSScriptRoot -Parent
$runtimeRoot = Join-Path $workspaceRoot '.cache\auto-work-uia-runtime'
$packageRoot = Join-Path $workspaceRoot '.cache\nuget\auto-work-uia'
New-Item -ItemType Directory -Force -Path $runtimeRoot, $packageRoot | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem
function Get-ColoopSha256([string]$Path) {
  $stream = [System.IO.File]::OpenRead($Path)
  $algorithm = [System.Security.Cryptography.SHA256]::Create()
  try { return [System.BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
  finally { $stream.Dispose(); $algorithm.Dispose() }
}
$packages = @(
  @{ Id='flaui.core'; Version='5.0.0'; Framework='net48'; Dll='FlaUI.Core.dll' },
  @{ Id='flaui.uia3'; Version='5.0.0'; Framework='net48'; Dll='FlaUI.UIA3.dll' },
  @{ Id='interop.uiautomationclient'; Version='10.19041.0'; Framework='net35'; Dll='Interop.UIAutomationClient.dll' }
)
$manifest = @()
foreach ($package in $packages) {
  $packageFile = Join-Path $packageRoot ($package.Id + '.' + $package.Version + '.nupkg')
  $url = 'https://api.nuget.org/v3-flatcontainer/' + $package.Id + '/' + $package.Version + '/' + $package.Id + '.' + $package.Version + '.nupkg'
  if (-not (Test-Path -LiteralPath $packageFile)) {
    [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12
    $download = New-Object System.Net.WebClient
    try { $download.DownloadFile($url, $packageFile) } finally { $download.Dispose() }
  }
  $zip = [System.IO.Compression.ZipFile]::OpenRead($packageFile)
  try {
    $entry = $zip.GetEntry('lib/' + $package.Framework + '/' + $package.Dll)
    if ($null -eq $entry) { throw "Package target missing: $($package.Dll)" }
    $destination = Join-Path $runtimeRoot $package.Dll
    [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $destination, $true)
    $license = $zip.GetEntry('LICENSE.txt')
    if ($null -eq $license) { throw "Package license missing: $($package.Id)" }
    [System.IO.Compression.ZipFileExtensions]::ExtractToFile($license, (Join-Path $runtimeRoot ($package.Id + '.LICENSE.txt')), $true)
    $manifest += @{ package=$package.Id; version=$package.Version; source=$url; file=$package.Dll; sha256=(Get-ColoopSha256 $destination) }
  } finally { $zip.Dispose() }
}
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$source = Join-Path $workspaceRoot 'resources\auto-agent-work-uia.cs'
$output = Join-Path $runtimeRoot 'Coloop.AutoWork.Uia.exe'
$references = @('System.Core.dll','System.Drawing.dll','System.Windows.Forms.dll','System.Web.Extensions.dll','System.Management.dll')
$references += $packages | ForEach-Object { Join-Path $runtimeRoot $_.Dll }
$arguments = @('/nologo','/target:exe','/platform:x64',('/out:' + $output))
$arguments += $references | ForEach-Object { '/reference:' + $_ }
$arguments += $source
& $compiler @arguments
if ($LASTEXITCODE -ne 0) { throw 'FlaUI helper compilation failed' }
$manifest += @{ file='Coloop.AutoWork.Uia.exe'; sha256=(Get-ColoopSha256 $output); sourceSha256=(Get-ColoopSha256 $source) }
$manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $runtimeRoot 'manifest.json') -Encoding UTF8
& $output --probe
if ($LASTEXITCODE -ne 0) { throw 'FlaUI dependency probe failed' }
Write-Output ('FlaUI runtime prepared: ' + $runtimeRoot)
