# Dot-source before invoking download/build/test tools directly from PowerShell.
$coloopWorkspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$coloopCacheLocations = @{
  TEMP='temp'; TMP='temp'; TMPDIR='temp'; npm_config_cache='npm';
  PIP_CACHE_DIR='pip'; UV_CACHE_DIR='uv'; ELECTRON_CACHE='electron';
  ELECTRON_BUILDER_CACHE='electron-builder'; HF_HOME='huggingface'; XDG_CACHE_HOME='xdg'
}
foreach ($key in $coloopCacheLocations.Keys) {
  $directory = Join-Path $coloopWorkspace ('.cache\' + $coloopCacheLocations[$key])
  New-Item -ItemType Directory -Path $directory -Force | Out-Null
  [Environment]::SetEnvironmentVariable($key, $directory, 'Process')
}
