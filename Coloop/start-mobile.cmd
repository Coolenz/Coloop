@echo off
cd /d "%~dp0"
if exist "release\coloop-connected-0.13.0\win-unpacked\Coloop.exe" (
  start "" "release\coloop-connected-0.13.0\win-unpacked\Coloop.exe"
  exit /b 0
)
if exist "release\relay-recovery-20261031\win-unpacked\Coloop.exe" (
  start "" "release\relay-recovery-20261031\win-unpacked\Coloop.exe"
  exit /b 0
)
if not exist "release\aliyun-companion-0.12.0\win-unpacked\Coloop.exe" (
  echo Coloop server companion is not built yet.
  exit /b 1
)
start "" "release\aliyun-companion-0.12.0\win-unpacked\Coloop.exe"
