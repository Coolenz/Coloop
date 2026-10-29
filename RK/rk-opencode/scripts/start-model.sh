#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/profile.sh
runtime="$RKLLM_APP"
exec python3 -u bridge/server.py \
    --model "$RKLLM_MODEL" --profile "$RK_AGENT_PROFILE" \
    --runtime "$runtime/lib" --context "$RKLLM_CONTEXT" --cache-mode "$RK_AGENT_CACHE_MODE"
