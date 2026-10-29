#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[[ $(uname -m) == x86_64 ]] || { echo 'Run in x86_64 Linux, not on the board.'; exit 1; }
ENV_DIR="$HOME/.venvs/lubancat4-rkllm-1.3.1"
python3.10 -m venv "$ENV_DIR"
PY="$ENV_DIR/bin/python"
WHEEL_DIR="$ROOT/downloads/rkllm-1.3.1"
WHEEL="$WHEEL_DIR/rkllm_toolkit-1.3.1-cp310-cp310-linux_x86_64.whl"
mkdir -p "$WHEEL_DIR" "$ROOT/logs"
if [[ ! -f "$WHEEL" ]]; then
  curl --fail --location --retry 3 \
    'https://raw.githubusercontent.com/airockchip/rknn-llm/f7390530443bf84f0394255a449d7cbe81e69d1c/rkllm-toolkit/packages/rkllm_toolkit-1.3.1-cp310-cp310-linux_x86_64.whl' \
    -o "$WHEEL.partial"
  mv "$WHEEL.partial" "$WHEEL"
fi
printf '%s  %s\n' '3b2dd5749d72ee6f02e651421a6e52153914e619776f3e5f7b2cae7885f2ea1b' "$WHEEL" | sha256sum -c -
"$PY" -m pip install 'torch==2.6.0+cpu' 'torchvision==0.21.0+cpu' \
  --index-url https://download.pytorch.org/whl/cpu
"$PY" -m pip install --index-url "${RK_PIP_INDEX:-https://pypi.tuna.tsinghua.edu.cn/simple}" \
  --find-links "$WHEEL_DIR" -r "$ROOT/requirements-rkllm.txt"
"$PY" -m pip check
"$PY" -m pip freeze > "$ROOT/logs/requirements-rkllm-resolved.txt"
"$PY" -c 'from rkllm.api import RKLLM; import torch; model = RKLLM(); print("RKLLM initialized; PyTorch:", torch.__version__)'
echo "Ready: source $ENV_DIR/bin/activate"
