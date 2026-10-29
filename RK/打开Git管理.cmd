@echo off
cd /d "%~dp0"
git -C "%CD%" gui
if errorlevel 1 pause
