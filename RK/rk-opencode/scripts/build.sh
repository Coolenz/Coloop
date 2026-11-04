#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/profile.sh
python3 model_profiles.py check
mkdir -p build logs .runtime
target="build/rkllm-worker-$RK_AGENT_PROFILE"
g++ -std=c++17 -O2 -Wall -Wextra src/worker.cpp -I"$RKLLM_INCLUDE" \
    -L"$RKLLM_RUNTIME" -lrkllmrt -Wl,-rpath,"$RKLLM_RUNTIME" -o "$target.pending"
if [[ -f "$target" ]]; then
    mkdir -p build/archive
    cp -p "$target" "build/archive/$(basename "$target")-$(date +%Y%m%d-%H%M%S)-$$"
fi
mv "$target.pending" "$target"
python3 model_profiles.py build-signature > ".runtime/worker-build-$RK_AGENT_PROFILE"
if [[ ! -s .runtime/api-key ]]; then
    (umask 077; python3 -c 'import secrets; print(secrets.token_hex(32))' > .runtime/api-key)
fi
