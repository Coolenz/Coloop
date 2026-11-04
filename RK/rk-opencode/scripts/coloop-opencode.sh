#!/usr/bin/env bash
# Adds the native local observation plugin; never downloads/upgrades models or plugins.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
export COLOOP_HOOK_CONNECTION="${COLOOP_HOOK_CONNECTION:-$root/.runtime/coloop-hook/connection.json}"
if [[ -z "${COLOOP_HOOK_CONNECTION:-}" || ! -f "$COLOOP_HOOK_CONNECTION" ]]; then
  echo 'Set COLOOP_HOOK_CONNECTION to the private connection file prepared by the PC launcher.' >&2
  exit 2
fi
python3 - <<'PY'
import json,os,stat
from pathlib import Path
path=Path(os.environ['COLOOP_HOOK_CONNECTION'])
if path.is_symlink() or not path.is_file() or stat.S_IMODE(path.stat().st_mode)&0o077:
 raise SystemExit('The hook connection file must be a regular user-only file (0600).')
try: value=json.loads(path.read_text(encoding='utf-8'))
except (OSError,ValueError): raise SystemExit('The hook connection file is invalid.')
if not isinstance(value,dict) or not value.get('url') or not value.get('token'):
 raise SystemExit('The hook connection file is incomplete.')
PY
export COLOOP_HOOK_ROOT="$root"
export OPENCODE_CONFIG_CONTENT="$(python3 - <<'PY'
import json,os
from pathlib import Path
root=Path(os.environ['COLOOP_HOOK_ROOT'])
try: cfg=json.loads(os.environ.get('OPENCODE_CONFIG_CONTENT','{}'))
except ValueError: raise SystemExit('Existing OPENCODE_CONFIG_CONTENT is invalid.')
plugin=(root/'plugins/coloop-hook.mjs').as_uri()
entries=cfg.setdefault('plugin',[])
if not isinstance(entries,list): raise SystemExit('Existing plugin setting is invalid.')
if plugin not in entries: entries.append(plugin)
# The local model bridge supports this request-level capability. Cloud providers are untouched.
headers=cfg.setdefault('provider',{}).setdefault('rkllm',{}).setdefault('options',{}).setdefault('headers',{})
headers['X-RK-Privacy']='metadata-only'
print(json.dumps(cfg,separators=(',',':')))
PY
)"
if [[ "${COLOOP_HOOK_BENCHMARK:-0}" != 1 ]]; then
  # Keep the established RK profile and Mem0 scheduling. Hook content is never enqueued.
  exec bash "$root/scripts/opencode.sh" --log-level ERROR "$@"
fi

# Benchmark mode uses a private config and only the hook/question tool. Config arrays
# merge in OpenCode, so an overlay alone cannot remove the normal memory plugins.
source "$root/scripts/profile.sh"
bash "$root/scripts/start.sh" >&2
export RK_AGENT_ROOT="$root" RK_AGENT_API_KEY="$(cat "$root/.runtime/api-key")"
export OPENCODE_DISABLE_AUTOUPDATE=true OPENCODE_DISABLE_MODELS_FETCH=true
export OPENCODE_DISABLE_LSP_DOWNLOAD=true OPENCODE_DISABLE_DEFAULT_PLUGINS=true
export OPENCODE_DISABLE_PROJECT_CONFIG=true OPENCODE_DISABLE_AUTOCOMPACT=true
export OPENCODE_DISABLE_PRUNE=true OPENCODE_DISABLE_CLAUDE_CODE=true
export LANG=C.UTF-8 LC_ALL=C.UTF-8
mkdir -p "$root/.runtime/coloop-hook-bench/config" "$root/.runtime/coloop-hook-bench/data"
export XDG_CONFIG_HOME="$root/.runtime/coloop-hook-bench/config"
export XDG_DATA_HOME="$root/.runtime/coloop-hook-bench/data"
export XDG_CACHE_HOME="$root/.runtime/cache"
export OPENCODE_CONFIG_CONTENT="$(python3 - <<'PY'
import json,os
from pathlib import Path
root=Path(os.environ['COLOOP_HOOK_ROOT'])
import sys
sys.path.insert(0,str(root))
from model_profiles import load_profile,opencode_config
cfg=opencode_config(load_profile(),root)
cfg['plugin']=[(root/'plugins/coloop-hook.mjs').as_uri()]
cfg['mcp']={name:{**value,'enabled':False} for name,value in cfg.get('mcp',{}).items()}
cfg['default_agent']='rk-coloop-hook-bench'
cfg['agent']['rk-coloop-hook-bench']={
 'mode':'primary','steps':3,'permission':{'*':'deny','question':'allow'},
 'prompt':'Use question with the exact questions provided by the user. Copy every label and empty description. After the tool result, answer briefly with the selected label. Do not call another tool.'}
cfg['provider']['rkllm']['options']['headers']={'X-RK-Privacy':'metadata-only','X-RK-Cache':'off'}
print(json.dumps(cfg,separators=(',',':')))
PY
)"
# This unique empty file contains no credentials or task text; complete config is process-only.
export OPENCODE_CONFIG="$(mktemp "$root/.runtime/coloop-hook-empty.XXXXXX.json")"
printf '{}\n' > "$OPENCODE_CONFIG"
chmod 600 "$OPENCODE_CONFIG"
cd "$root/workspace"
exec "$root/bin/opencode" --log-level ERROR "$@"
