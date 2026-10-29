@echo off
cd /d "%~dp0"
set PYTHONIOENCODING=utf-8
"%~dp0.venv-qwen-pc\Scripts\python.exe" -u "%~dp0tools\eval_qwen35_pc.py" --no-cache --dataset "%~dp0tools\evalsets\ceval-val-all52-seed42-260.json"
pause
