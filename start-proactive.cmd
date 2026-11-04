@echo off
setlocal
cd /d "%~dp0"
if exist "release\cloud-ocr-island-0.13.0-20261104-r1\win-unpacked\Coloop.exe" (
  start "" "release\cloud-ocr-island-0.13.0-20261104-r1\win-unpacked\Coloop.exe"
  exit /b 0
)
if exist "release\agent-state-check-0.13.0-20261103-r1\win-unpacked\Coloop.exe" (
  start "" "release\agent-state-check-0.13.0-20261103-r1\win-unpacked\Coloop.exe"
  exit /b 0
)
echo Coloop proactive build is missing. See docs\proactive-agent.md.
exit /b 1
