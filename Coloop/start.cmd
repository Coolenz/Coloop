@echo off
cd /d "%~dp0"
if exist "release\Coloop-0.7.0-Windows-x64.exe" (
  start "" "release\Coloop-0.7.0-Windows-x64.exe"
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
