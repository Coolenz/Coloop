#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
root="$PWD"
[[ -f .runtime/memory-config.json ]] || exit 0
if [[ "${1:-}" != --staging ]]; then
  python3 -c 'import json; assert json.load(open(".runtime/memory-config.json")).get("enabled")' || exit 0
fi
exec 8>.runtime/start-memory.lock
flock 8
if python3 -c 'import sys; sys.path.insert(0,"agent"); from memory_client import MemoryClient; assert MemoryClient(".").request("/health", timeout=2)["ready"]' 2>/dev/null; then exit 0; fi
nohup .venv-memory/bin/python -u agent/memory_service.py --root "$root" >> logs/memory-service.log 2>&1 < /dev/null 8>&- &
echo $! > .runtime/memory.pid
for _ in $(seq 1 60); do
  if python3 -c 'import sys; sys.path.insert(0,"agent"); from memory_client import MemoryClient; assert MemoryClient(".").request("/health", timeout=2)["ready"]' 2>/dev/null; then exit 0; fi
  kill -0 "$(cat .runtime/memory.pid)" 2>/dev/null || { tail -15 logs/memory-service.log; exit 1; }
  sleep 1
done
echo 'Mem0 startup timed out; inspect logs/memory-service.log'
exit 1
