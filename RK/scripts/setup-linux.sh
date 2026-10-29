#!/usr/bin/env bash
set -euo pipefail
ROOT="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
[[ $(uname -m) == x86_64 ]] || { echo 'This converter setup requires Linux x86_64.'; exit 1; }
. /etc/os-release
[[ "$ID" == ubuntu && "$VERSION_ID" == 22.04 ]] || { echo 'Use Ubuntu 22.04 for this pinned environment.'; exit 1; }
if [[ $EUID -eq 0 ]]; then SUDO=(); else SUDO=(sudo); fi
"${SUDO[@]}" apt-get update
"${SUDO[@]}" apt-get install -y python3.10 python3.10-venv python3-dev build-essential cmake ninja-build \
  gcc-aarch64-linux-gnu g++-aarch64-linux-gnu pkg-config git git-lfs curl unzip \
  openssh-client adb libgl1 libglib2.0-0 libgomp1
# Keep the Linux venv on the Linux filesystem for performance and symlink support.
ENV_DIR="$HOME/.venvs/lubancat4-rknn-2.3.2"
python3.10 -m venv "$ENV_DIR"
PY="$ENV_DIR/bin/python"
PIP_INDEX="${RK_PIP_INDEX:-https://pypi.tuna.tsinghua.edu.cn/simple}"
"$PY" -m pip install --index-url "$PIP_INDEX" --upgrade 'pip<26' 'setuptools==75.8.2' wheel
shopt -s nullglob
TORCH_WHEELS=("$ROOT"/downloads/wheels/linux-x86_64-cp310/torch-2.4.0+cpu-*.whl)
if [[ ${#TORCH_WHEELS[@]} -gt 0 ]]; then
  "$PY" -m pip install --index-url "$PIP_INDEX" "${TORCH_WHEELS[0]}"
else
  "$PY" -m pip install 'torch==2.4.0+cpu' --index-url https://download.pytorch.org/whl/cpu
fi
REQUIREMENTS="$ROOT/requirements-rknn.txt"
if [[ -f "$ROOT/requirements-rknn.lock.txt" ]]; then REQUIREMENTS="$ROOT/requirements-rknn.lock.txt"; fi
"$PY" -m pip install --index-url "$PIP_INDEX" \
  --find-links "$ROOT/downloads/sdk/rknn-2.3.2/rknn-toolkit2/packages/x86_64" \
  --find-links "$ROOT/downloads/wheels/linux-x86_64-cp310" \
  -r "$REQUIREMENTS"
"$PY" -m pip check
mkdir -p "$ROOT/logs"
"$PY" -m pip freeze > "$ROOT/logs/requirements-linux-resolved.txt"
"$PY" "$ROOT/tools/doctor.py" --rknn
"$PY" "$ROOT/tools/smoke_onnx.py"
"$PY" "$ROOT/tools/convert.py" --input "$ROOT/models/smoke.onnx" --output "$ROOT/models/smoke.rknn"
echo "Ready. Activate with: source $ENV_DIR/bin/activate"
echo "Project: $ROOT"
