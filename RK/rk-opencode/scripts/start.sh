#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/profile.sh
mkdir -p logs .runtime workspace
exec 9>.runtime/start.lock
flock 9
if python3 scripts/check-health.py; then
    echo 'Local NPU model service is ready.'
    exit 0
fi
if [[ -f .runtime/bridge.pid ]]; then
    bash scripts/stop-model.sh
fi
[[ -x "build/rkllm-worker-$RK_AGENT_PROFILE" && -s .runtime/api-key &&
   -f ".runtime/worker-protocol-$RK_AGENT_PROFILE" &&
   "$(cat ".runtime/worker-protocol-$RK_AGENT_PROFILE")" == 2 ]] || bash scripts/build.sh
nohup bash scripts/start-model.sh >> logs/bridge.log 2>&1 < /dev/null 9>&- &
echo $! > .runtime/bridge.pid
for i in $(seq 1 60); do
    if python3 scripts/check-health.py; then
        echo 'Local NPU model service started.'
        exit 0
    fi
    if ! kill -0 "$(cat .runtime/bridge.pid)" 2>/dev/null; then
        echo 'Model service failed; see logs/bridge.log and logs/worker.log.'
        tail -8 logs/bridge.log
        exit 1
    fi
    sleep 1
done
echo 'Model initialization timed out; inspect logs/worker.log.'
exit 1
