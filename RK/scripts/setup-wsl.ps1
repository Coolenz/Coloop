param([string]$Distribution = 'Ubuntu-22.04')
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$linuxRoot = & wsl.exe -d $Distribution -- wslpath -a $root
if ($LASTEXITCODE -ne 0) { throw 'WSL Ubuntu-22.04 is not ready. See README.md, WSL setup.' }
$linuxRoot = ($linuxRoot | Out-String).Trim()
& wsl.exe -d $Distribution -- bash "$linuxRoot/scripts/setup-linux.sh" $linuxRoot
if ($LASTEXITCODE -ne 0) { throw 'Linux environment setup failed; see the output above.' }
