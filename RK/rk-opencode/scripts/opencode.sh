#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
source "$root/scripts/profile.sh"
bash "$root/scripts/start-memory.sh"
export RK_AGENT_API_KEY="$(cat "$root/.runtime/api-key")"
export OPENCODE_CONFIG="$root/$RK_AGENT_CONFIG"
export RK_AGENT_ROOT="$root"
export OPENCODE_DISABLE_AUTOUPDATE=true
export OPENCODE_DISABLE_MODELS_FETCH=true
export OPENCODE_DISABLE_LSP_DOWNLOAD=true
export OPENCODE_DISABLE_DEFAULT_PLUGINS=true
export OPENCODE_DISABLE_PROJECT_CONFIG=true
export OPENCODE_DISABLE_AUTOCOMPACT=true
export OPENCODE_DISABLE_PRUNE=true
export OPENCODE_DISABLE_CLAUDE_CODE=true
export XDG_CONFIG_HOME="$root/.runtime/config"
export XDG_DATA_HOME="$root/.runtime/data"
export XDG_CACHE_HOME="$root/.runtime/cache"
export LANG=C.UTF-8 LC_ALL=C.UTF-8
cd "$root/workspace"
exec "$root/bin/opencode" "$@"
