@echo off
cd /d "%~dp0"
if exist "release\cloud-ocr-island-0.13.0-20261104-r1\win-unpacked\Coloop.exe" (
  start "" "release\cloud-ocr-island-0.13.0-20261104-r1\win-unpacked\Coloop.exe"
  exit /b 0
)
if exist "release\acceptance-tools-0.13.0-20261104-r10\win-unpacked\Coloop.exe" (
  start "" "release\acceptance-tools-0.13.0-20261103-r6\win-unpacked\Coloop.exe"
  exit /b 0
)
if exist "release\acceptance-tools-0.13.0-20261103-r5\win-unpacked\Coloop.exe" (
  start "" "release\acceptance-tools-0.13.0-20261103-r5\win-unpacked\Coloop.exe"
  exit /b 0
)
if exist "release\script-tools-0.13.0-20261103-r3\win-unpacked\Coloop.exe" (
  start "" "release\script-tools-0.13.0-20261103-r3\win-unpacked\Coloop.exe"
  exit /b 0
)
if exist "release\script-tools-0.13.0-20261103-r2\win-unpacked\Coloop.exe" (
  start "" "release\script-tools-0.13.0-20261103-r2\win-unpacked\Coloop.exe"
  exit /b 0
)
if exist "release\script-tools-0.13.0-20261103-r1\win-unpacked\Coloop.exe" (
  start "" "release\script-tools-0.13.0-20261103-r1\win-unpacked\Coloop.exe"
  exit /b 0
)
if exist "release\input-recovery-0.13.0-20261103-r1\win-unpacked\Coloop.exe" (
  start "" "release\input-recovery-0.13.0-20261103-r1\win-unpacked\Coloop.exe"
  exit /b 0
)
if exist "release\agent-state-check-0.13.0-20261103-r1\win-unpacked\Coloop.exe" (
  start "" "release\agent-state-check-0.13.0-20261103-r1\win-unpacked\Coloop.exe"
  exit /b 0
)
if exist "release\unified-task-0.13.0-20261103-r3\win-unpacked\Coloop.exe" (
  start "" "release\unified-task-0.13.0-20261103-r3\win-unpacked\Coloop.exe"
  exit /b 0
)
if exist "release\task-routing-0.13.0-20261103-r2\win-unpacked\Coloop.exe" (
  start "" "release\task-routing-0.13.0-20261103-r2\win-unpacked\Coloop.exe"
  exit /b 0
)
if exist "release\task-recovery-0.13.0-20261103-r1\win-unpacked\Coloop.exe" (
  start "" "release\task-recovery-0.13.0-20261103-r1\win-unpacked\Coloop.exe"
  exit /b 0
)
if exist "release\proactive-glass-0.13.0-20261103-r4\win-unpacked\Coloop.exe" (
  start "" "release\proactive-glass-0.13.0-20261103-r4\win-unpacked\Coloop.exe"
  exit /b 0
)
if exist "release\coloop-connected-0.13.0\win-unpacked\Coloop.exe" (
  start "" "release\coloop-connected-0.13.0\win-unpacked\Coloop.exe"
  exit /b 0
)
if exist "release\remote-visible-20261030\win-unpacked\Coloop.exe" (
  start "" "release\remote-visible-20261030\win-unpacked\Coloop.exe"
  exit /b 0
)
if exist "release\memory-visibility-20261030\win-unpacked\Coloop.exe" (
  start "" "release\memory-visibility-20261030\win-unpacked\Coloop.exe"
  exit /b 0
)
if exist "release\window-recovery-20261030\win-unpacked\Coloop.exe" (
  start "" "release\window-recovery-20261030\win-unpacked\Coloop.exe"
  exit /b 0
)
if exist "release\android-companion-0.12.0\win-unpacked\Coloop.exe" (
  start "" "release\android-companion-0.12.0\win-unpacked\Coloop.exe"
  exit /b 0
)
if exist "release\deepseek-validated-0.12.0\win-unpacked\Coloop.exe" (
  start "" "release\deepseek-validated-0.12.0\win-unpacked\Coloop.exe"
  exit /b 0
)
if exist "release\session-control\win-unpacked\Coloop.exe" (
  start "" "release\session-control\win-unpacked\Coloop.exe"
  exit /b 0
)
if exist "release\0.11.0\Coloop-0.11.0-Windows-x64.exe" (
  start "" "release\0.11.0\Coloop-0.11.0-Windows-x64.exe"
  exit /b 0
)
if exist "release\Coloop-0.10.1-Windows-x64.exe" (
  start "" "release\Coloop-0.10.1-Windows-x64.exe"
  exit /b 0
)
if exist "release\Coloop-0.10.0-Windows-x64.exe" (
  start "" "release\Coloop-0.10.0-Windows-x64.exe"
  exit /b 0
)
if exist "release\win-unpacked\Coloop.exe" (
  start "" "release\win-unpacked\Coloop.exe"
  exit /b 0
)
if not exist "node_modules\electron\dist\electron.exe" (
  echo Run npm ci and npm run setup:electron first.
  pause
  exit /b 1
)
call npm run dev
