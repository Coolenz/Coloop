@echo off
setlocal
set "COLOOP_DESKTOP_EXE=%~dp0release\desktop-batch-0.12.0\win-unpacked\Coloop.exe"
if exist "%COLOOP_DESKTOP_EXE%" (
  start "" "%COLOOP_DESKTOP_EXE%"
  exit /b 0
)
echo Desktop build not found. See docs\desktop-operation.md.
exit /b 1
