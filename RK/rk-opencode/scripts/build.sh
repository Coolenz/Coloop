#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/profile.sh
runtime="$RKLLM_APP"
mkdir -p build logs .runtime
target="build/rkllm-worker-$RK_AGENT_PROFILE"
g++ -std=c++17 -O2 -Wall -Wextra src/worker.cpp -I"$runtime/include" \
    -L"$runtime/lib" -lrkllmrt -Wl,-rpath,"$runtime/lib" -o "$target.pending"
if [[ -f "$target" ]]; then
    mkdir -p build/archive
    cp -p "$target" "build/archive/$(basename "$target")-$(date +%Y%m%d-%H%M%S)-$$"
fi
mv "$target.pending" "$target"
printf '2\n' > ".runtime/worker-protocol-$RK_AGENT_PROFILE"
if [[ ! -s .runtime/api-key ]]; then
    (umask 077; python3 -c 'import secrets; print(secrets.token_hex(32))' > .runtime/api-key)
fi
