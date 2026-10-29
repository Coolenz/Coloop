#!/usr/bin/env bash
# Sourced by build/start/OpenCode; models and their libraries are never replaced.
RK_AGENT_PROFILE="${RK_AGENT_PROFILE:-qwen35-4b}"
case "$RK_AGENT_PROFILE" in
  qwen35-4b)
    RKLLM_APP="${RKLLM_APP:-$HOME/rk-edge-ai/qwen35-4b}"
    RKLLM_MODEL="${RKLLM_MODEL:-$RKLLM_APP/qwen3.5-4b_w8a8_rk3588.rkllm}"
    RK_AGENT_MODEL_ID=qwen35-4b-rkllm
    RK_AGENT_CONFIG=opencode-qwen.json
    RKLLM_CONTEXT="${RKLLM_CONTEXT:-16384}"
    RK_AGENT_CACHE_MODE="${RK_AGENT_CACHE_MODE:-native}"
    ;;
  deepseek)
    RKLLM_APP="${RKLLM_APP:-$HOME/rk-edge-ai/deepseek}"
    RKLLM_MODEL="${RKLLM_MODEL:-$RKLLM_APP/deepseek-r1-1.5B-rkllm1.1.4.rkllm}"
    RK_AGENT_MODEL_ID=deepseek-rkllm
    RK_AGENT_CONFIG=opencode.json
    RKLLM_CONTEXT="${RKLLM_CONTEXT:-4096}"
    RK_AGENT_CACHE_MODE="${RK_AGENT_CACHE_MODE:-off}"
    ;;
  *) echo 'Unsupported RK_AGENT_PROFILE' >&2; return 2 ;;
esac
export RK_AGENT_PROFILE RKLLM_APP RKLLM_MODEL RK_AGENT_MODEL_ID RKLLM_CONTEXT RK_AGENT_CACHE_MODE
