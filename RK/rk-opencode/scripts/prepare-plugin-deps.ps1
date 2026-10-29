$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$cache = Join-Path $repo '.cache/plugin-sdk'
$expectedCacheRoot = [IO.Path]::GetFullPath((Join-Path $repo '.cache')) + [IO.Path]::DirectorySeparatorChar
if (-not [IO.Path]::GetFullPath($cache).StartsWith($expectedCacheRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'SDK cache must remain inside this project cache directory.'
}
New-Item -ItemType Directory -Force $cache | Out-Null
Copy-Item -LiteralPath (Join-Path $repo 'plugins/package.json'),(Join-Path $repo 'plugins/package-lock.json') -Destination $cache
# Per-command proxy settings; the user's global npm configuration is unchanged.
& npm.cmd ci --prefix $cache --ignore-scripts --no-audit --no-fund --omit=dev --omit=optional --proxy=null --https-proxy=null --noproxy=registry.npmjs.org --fetch-retries=0 --fetch-timeout=20000
if ($LASTEXITCODE -ne 0) { throw 'Could not prepare the pinned OpenCode plugin SDK cache.' }
$python = Join-Path (Split-Path $repo -Parent) '.venv/Scripts/python.exe'
& $python (Join-Path $PSScriptRoot 'install-plugin-deps.py')
exit $LASTEXITCODE
