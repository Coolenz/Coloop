@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\testbench.ps1" -EnableHid %*
pause
