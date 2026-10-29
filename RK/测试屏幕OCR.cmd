@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\screen-ocr.ps1" --delay 3 %*
if errorlevel 1 goto done
if "%~1"=="" start "" "%~dp0deployment\screen-ocr\results\latest-marked.png"
:done
pause
