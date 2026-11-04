@echo off
setlocal
cd /d "%~dp0"
if exist "release\coloop-connected-0.13.0\win-unpacked\Coloop.exe" (
  start "" "release\coloop-connected-0.13.0\win-unpacked\Coloop.exe"
  exit /b 0
)
if exist "release\violoop-rk-0.12.0\win-unpacked\Coloop.exe" (
  start "" "release\violoop-rk-0.12.0\win-unpacked\Coloop.exe"
  exit /b
)
if exist "release\violoop-companion-0.12.0\win-unpacked\Coloop.exe" (
  start "" "release\violoop-companion-0.12.0\win-unpacked\Coloop.exe"
  exit /b
)
echo Coloop companion build is missing. Run npm run build first.
pause
