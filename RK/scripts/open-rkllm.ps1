$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$linuxRoot = (& wsl.exe -d Ubuntu-22.04 -- wslpath -a -u $projectRoot).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Cannot resolve project path in WSL.' }
& wsl.exe -d Ubuntu-22.04 --cd $linuxRoot -- bash --rcfile "$linuxRoot/scripts/rkllm-shell.rc" -i
