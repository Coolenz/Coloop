$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$runtime = Join-Path $repo '.runtime'
New-Item -ItemType Directory -Force -Path $runtime | Out-Null
$compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
$executable = Join-Path $runtime 'RKAgentLab.exe'
& $compiler /nologo /target:winexe "/out:$executable" /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Web.Extensions.dll (Join-Path $repo 'pc/AgentLab.cs')
if ($LASTEXITCODE -ne 0) { throw 'Failed to build the agent test window.' }
Start-Process -FilePath $executable -ArgumentList ('"' + $runtime + '"')
