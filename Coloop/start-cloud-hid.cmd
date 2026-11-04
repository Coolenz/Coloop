@echo off
setlocal
cd /d "%~dp0"
if exist "release\rk-agent-state-0.13.0-20261102\win-unpacked\Coloop.exe" (
  start "" "release\rk-agent-state-0.13.0-20261102\win-unpacked\Coloop.exe"
  exit /b 0
)
echo Mouse-only Cloud HID build is missing. See docs\cloud-hid-relay.md.
pause
exit /b 1

