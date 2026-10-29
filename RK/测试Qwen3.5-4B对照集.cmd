@echo off
cd /d "%~dp0"
set PYTHONIOENCODING=utf-8
"%~dp0.venv\Scripts\python.exe" -u "%~dp0tools\eval_qwen35.py" --board-subdir qwen35-4b --dataset "%~dp0tools\evalsets\cmmlu-balanced-seed42-48.json"
pause
