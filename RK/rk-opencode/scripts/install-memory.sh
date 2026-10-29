#!/usr/bin/env bash
# Use the caller's session-only proxy if required; no system/Python environment changes.
set -euo pipefail
cd "$(dirname "$0")/.."
[[ -x .venv-memory/bin/python ]] || python3 -m venv .venv-memory
.venv-memory/bin/python -m pip install -r requirements-memory.txt
.venv-memory/bin/python -m pip check
.venv-memory/bin/python -m pip freeze > logs/requirements-memory-board.lock.txt
