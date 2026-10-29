#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
exec 8>.runtime/start-memory.lock
flock 8
pidfile=.runtime/memory.pid
[[ -f "$pidfile" ]] || exit 0
pid="$(cat "$pidfile")"
[[ "$pid" =~ ^[0-9]+$ ]] || { echo 'Invalid saved memory process id'; exit 1; }
if kill -0 "$pid" 2>/dev/null; then
  [[ "$(readlink "/proc/$pid/cwd")" == "$root" ]] &&
    grep -azq 'agent/memory_service.py' "/proc/$pid/cmdline" || { echo 'Memory PID belongs to another application'; exit 1; }
  python3 - <<'PY'
import sys
sys.path.insert(0, 'agent')
from memory_client import MemoryClient
c = MemoryClient('.')
c.request('/activity', {'session_id': 'memory-shutdown', 'active': True})
c.request('/ready-for-foreground', {}, timeout=185)
PY
  kill -TERM "$pid"
  for _ in $(seq 1 30); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.2
  done
  if kill -0 "$pid" 2>/dev/null; then echo 'Memory process has not exited'; exit 1; fi
fi
rm -f "$pidfile"
