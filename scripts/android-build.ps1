<# Builds the Android application with this repository's isolated toolchain. #>
param([string[]]$Tasks = @('assembleDebug'))
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'android-toolchain.ps1')
$project = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../android'))
if (-not (Test-Path -LiteralPath (Join-Path $project 'settings.gradle.kts'))) { throw 'Android project is not present yet.' }
# Process-local overrides avoid an unrelated broken proxy inherited by command-line clients.
foreach ($name in @('HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy')) {
  [Environment]::SetEnvironmentVariable($name, $null, 'Process')
}
& (Join-Path $ColoopAndroidPaths.Gradle 'bin/gradle.bat') --no-daemon --max-workers=1 `
  '-Dorg.gradle.jvmargs=-Xmx1536m -Dfile.encoding=UTF-8' '-Dorg.gradle.vfs.watch=false' '-Dhttp.proxyHost=' '-Dhttps.proxyHost=' `
  '-Pkotlin.compiler.execution.strategy=in-process' -p $project @Tasks
if ($LASTEXITCODE -ne 0) { throw ('Android Gradle build failed with exit code ' + $LASTEXITCODE) }
