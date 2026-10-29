#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export LD_LIBRARY_PATH="$ROOT/vendor/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
PY="$ROOT/.venv-board/bin/python"
[[ -x "$PY" ]] || { echo 'Run bash scripts/setup-board.sh first.'; exit 1; }
case "${1:-check}" in
  check) exec "$PY" "$ROOT/tools/doctor.py" --board ;;
  smoke) exec "$PY" "$ROOT/tools/smoke_board.py" ;;
  resnet)
    cd "$ROOT/official-resnet18"
    exec "$PY" test.py ;;
  *) echo 'Usage: bash scripts/run-board.sh [check|smoke|resnet]'; exit 2 ;;
esac
