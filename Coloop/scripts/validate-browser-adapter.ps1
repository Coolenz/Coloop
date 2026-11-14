$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'workspace-cache.ps1')
Push-Location (Join-Path $PSScriptRoot '..')
try {
  & npm.cmd test -- tests/browser-executable.test.ts tests/browser-preferences.test.ts tests/browser-adapter-maintenance.test.ts tests/browser-selection.test.ts tests/browser-profile.test.ts tests/stagehand-runtime.test.ts tests/web-reader.test.ts tests/web-session.test.ts tests/tars-agent.test.ts
  if ($LASTEXITCODE -ne 0) { throw 'Browser adapter regression tests failed' }
  & npm.cmd run build
  if ($LASTEXITCODE -ne 0) { throw 'Coloop build failed' }
} finally {
  Pop-Location
}
