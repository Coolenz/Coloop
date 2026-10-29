# Run manually in an Administrator PowerShell. This script never reboots the PC.
$ErrorActionPreference = 'Stop'
$principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Open PowerShell as Administrator, then run this script again.'
}
wsl.exe --install -d Ubuntu-22.04 --no-launch
if ($LASTEXITCODE -ne 0) { throw 'WSL installation failed. See https://learn.microsoft.com/windows/wsl/install' }
Write-Host 'Restart Windows if requested, then open Ubuntu-22.04 once and create your Linux username/password.'
Write-Host 'Next: powershell -ExecutionPolicy Bypass -File D:\RK\scripts\setup-wsl.ps1'
