@echo off
setlocal
set "COLOOP_EXE=%LOCALAPPDATA%\Programs\Coloop\Coloop.exe"
if not exist "%COLOOP_EXE%" (
  echo Coloop is not installed. See AGENTS.md for local deployment instructions.
  exit /b 1
)
start "" "%COLOOP_EXE%"
exit /b 0
