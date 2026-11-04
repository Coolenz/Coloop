#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
source "$root/scripts/profile.sh"
bash "$root/scripts/start.sh" >&2
bash "$root/scripts/start-memory.sh" >&2
export RK_AGENT_ROOT="$root"
export LANG=C.UTF-8 LC_ALL=C.UTF-8
if [[ $# -eq 0 ]]; then
    exec python3 -u "$root/scripts/hid-agent.py" --interactive
fi
exec python3 -u "$root/scripts/hid-agent.py" "$@"
