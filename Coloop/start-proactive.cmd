@echo off
setlocal
cd /d "%~dp0"
set "COLOOP_TARS_EXE=%~dp0release\tars-rk-0.13.0-20261104-r3\win-unpacked\Coloop.exe"
if exist "%COLOOP_TARS_EXE%" (
  start "" "%COLOOP_TARS_EXE%"
  exit /b 0
)
echo Agent TARS build is missing. See docs\agent-tars-architecture.md.
exit /b 1
