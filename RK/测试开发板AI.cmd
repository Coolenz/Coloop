@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\board.ps1" -Action resnet
pause
