#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/profile.sh
exec python3 -u bridge/server.py --profile "$RK_AGENT_PROFILE"
