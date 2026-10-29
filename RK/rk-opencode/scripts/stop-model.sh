#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
pidfile="$root/.runtime/bridge.pid"
[[ -f "$pidfile" ]] || exit 0
pid="$(cat "$pidfile")"
[[ "$pid" =~ ^[0-9]+$ ]] || { echo 'Invalid saved process id'; exit 1; }
if kill -0 "$pid" 2>/dev/null; then
    [[ "$(readlink "/proc/$pid/cwd")" == "$root" ]] && \
        grep -azq 'bridge/server.py' "/proc/$pid/cmdline" || { echo 'Saved process id belongs to another application'; exit 1; }
    kill -TERM "$pid"
    for i in $(seq 1 30); do
        kill -0 "$pid" 2>/dev/null || break
        sleep 0.2
    done
    if kill -0 "$pid" 2>/dev/null && [[ "$(readlink "/proc/$pid/cwd")" == "$root" ]]; then
        echo 'Model service has not exited; keeping its process id for inspection.'
        exit 1
    fi
fi
rm -f "$pidfile"
