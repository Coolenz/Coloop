#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[[ $(uname -m) == aarch64 ]] || { echo 'Run this on the Linux aarch64 development board.'; exit 1; }
grep -aq rk3588 /proc/device-tree/compatible || { echo 'RK3588 was not detected.'; exit 1; }
if [[ $EUID -eq 0 ]]; then SUDO=(); else SUDO=(sudo); fi
if [[ ${RK_SKIP_APT:-0} != 1 ]]; then
  "${SUDO[@]}" apt-get update
  "${SUDO[@]}" apt-get install -y python3 python3-venv python3-dev build-essential cmake ninja-build \
    pkg-config git libgl1 libglib2.0-0 libgomp1 v4l-utils
fi
python3 -c 'import sys; assert (3,9) <= sys.version_info[:2] <= (3,12), "Use Python 3.9-3.12; consult wheel support for other versions"'
python3 -m venv "$ROOT/.venv-board"
PY="$ROOT/.venv-board/bin/python"
if [[ -d "$ROOT/wheels" ]] && compgen -G "$ROOT/wheels/rknn_toolkit_lite2-*.whl" >/dev/null; then
  "$PY" -m pip install --no-index --find-links "$ROOT/wheels" -r "$ROOT/requirements-board.txt"
else
  "$PY" -m pip install --upgrade 'pip<26' 'setuptools==75.8.2' wheel
  "$PY" -m pip install -r "$ROOT/requirements-board.txt"
fi
"$PY" -m pip check
if [[ -f "$ROOT/vendor/lib/librknnrt.so" ]]; then
  # Lite2 also checks /usr/lib explicitly. Install there only when absent.
  if [[ ! -e /usr/lib/librknnrt.so ]]; then
    "${SUDO[@]}" install -m 0755 "$ROOT/vendor/lib/librknnrt.so" /usr/lib/librknnrt.so
    "${SUDO[@]}" ldconfig
  fi
  export LD_LIBRARY_PATH="$ROOT/vendor/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
fi
mkdir -p "$ROOT/logs"
"$PY" -m pip freeze > "$ROOT/logs/requirements-board-resolved.txt"
"$PY" "$ROOT/tools/doctor.py" --board
echo 'Python environment installed. NPU inference still requires a matching vendor runtime and driver.'
