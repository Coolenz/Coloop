@echo off
setlocal
cd /d "%~dp0"
set "COLOOP_DESKTOP_EXE=%~dp0release\tars-rk-0.13.0-20261104-r3\win-unpacked\Coloop.exe"
if exist "%COLOOP_DESKTOP_EXE%" (
  start "" "%COLOOP_DESKTOP_EXE%"
  exit /b 0
)
echo Desktop build not found. See docs\agent-tars-architecture.md.
exit /b 1
