#!/usr/bin/env bash
# Starts the host-installed managed profile. Never merges ordinary user config.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
connection="${COLOOP_MANAGED_CONNECTION:-${COLOOP_HOOK_CONNECTION:-$root/.runtime/coloop-hook/connection.json}}"
exec python3 - "$root" "$connection" "$@" <<'PY'
import hashlib,json,os,secrets,shutil,stat,sys
from pathlib import Path

root=Path(sys.argv[1]).resolve()
connection=Path(sys.argv[2])
arguments=sys.argv[3:]
def fail(code):raise SystemExit(code)
def private_file(path):
 info=path.lstat()
 if not stat.S_ISREG(info.st_mode) or path.is_symlink() or stat.S_IMODE(info.st_mode)&0o077 or info.st_uid!=os.getuid():fail('PRIVATE_MANAGED_FILE_REQUIRED')
 return path.read_bytes()
outer=json.loads(private_file(connection))
managed=outer.get('managed')
if not isinstance(managed,dict) or managed.get('version')!=1:fail('MANAGED_ENROLLMENT_REQUIRED')
config=root/'.runtime/coloop-managed/config.json'
if managed.get('configPath')!=str(config):fail('MANAGED_CONFIG_PATH_MISMATCH')
data=private_file(config)
if hashlib.sha256(data).hexdigest()!=managed.get('configSha256'):fail('MANAGED_CONFIG_CHANGED')
cfg=json.loads(data)
# Enrollment stays immutable. The selected live service must match its pinned route.
import urllib.request
key=private_file(root/'.runtime/api-key').decode().strip()
request=urllib.request.Request('http://127.0.0.1:8088/health',headers={'Authorization':'Bearer '+key})
with urllib.request.urlopen(request,timeout=2) as response:health=json.load(response)
if health.get('ready') is not True or cfg.get('model')!='rkllm/'+str(health.get('model')):fail('MANAGED_LIVE_MODEL_MISMATCH_REENROLL_REQUIRED')
limits=cfg.get('provider',{}).get('rkllm',{}).get('models',{}).get(health['model'],{}).get('limit',{})
if limits.get('context')!=health.get('context') or not 1<=limits.get('output',0)<=health.get('max_output',2048):fail('MANAGED_LIVE_LIMIT_MISMATCH_REENROLL_REQUIRED')
workspace=Path(managed.get('root',''))
if not workspace.is_absolute() or str(workspace.resolve())!=str(workspace) or not workspace.is_dir():fail('MANAGED_WORKSPACE_REQUIRED')
for value in arguments:
 if value.split('=',1)[0] in ('--attach','--config','--dir','--cwd','--project','--workspace'):
  fail('MANAGED_LAUNCH_OVERRIDE_REJECTED')
if arguments and arguments[0]=='serve':
 password=os.environ.get('OPENCODE_SERVER_PASSWORD','')
 if not 16<=len(password)<=128:fail('MANAGED_SERVER_PASSWORD_REQUIRED')
 for i,value in enumerate(arguments):
  if value=='--hostname' and (i+1==len(arguments) or arguments[i+1] not in ('127.0.0.1','::1')):fail('MANAGED_LOOPBACK_REQUIRED')
  if value.startswith('--hostname=') and value.split('=',1)[1] not in ('127.0.0.1','::1'):fail('MANAGED_LOOPBACK_REQUIRED')
os.umask(0o077)
base=root/'.runtime/coloop-managed'
if base.is_symlink():fail('MANAGED_DIRECTORY_SYMLINK')
run=base/('run-'+secrets.token_hex(16))
run.mkdir(mode=0o700)
for name in ('home','config','data','cache'):(run/name).mkdir(mode=0o700)

# OpenCode checks its pinned plugin SDK even when this plugin uses only Node
# built-ins. Copy the existing pure-JS offline cache into this isolated HOME.
sdk=root/'.runtime/config/opencode'
lock=(root/'plugins/package-lock.json').read_bytes()
if (sdk/'package-lock.json').read_bytes()!=lock:fail('PINNED_PLUGIN_SDK_LOCK_MISMATCH')
if json.loads((sdk/'package.json').read_text()).get('dependencies')!={'@opencode-ai/plugin':'1.19.5'}:fail('PINNED_PLUGIN_SDK_REQUIRED')
for name in ('plugin','sdk'):
 if json.loads((sdk/'node_modules/@opencode-ai'/name/'package.json').read_text()).get('version')!='1.19.5':fail('PINNED_PLUGIN_SDK_REQUIRED')
files=list((sdk/'node_modules').rglob('*'))
if not files or any(path.is_symlink() or path.suffix.lower() in ('.node','.exe','.dll','.so','.dylib') for path in files):fail('PURE_JS_PLUGIN_SDK_REQUIRED')
destination=run/'config/opencode'
destination.mkdir(mode=0o700)
for name in ('package.json','package-lock.json'):shutil.copy2(sdk/name,destination/name)
shutil.copytree(sdk/'node_modules',destination/'node_modules')

env={'PATH':os.environ.get('PATH','/usr/local/bin:/usr/bin:/bin'),'HOME':str(run/'home'),
 'XDG_CONFIG_HOME':str(run/'config'),'XDG_DATA_HOME':str(run/'data'),'XDG_CACHE_HOME':str(run/'cache'),
 'RK_AGENT_ROOT':str(root),'RK_AGENT_API_KEY':private_file(root/'.runtime/api-key').decode().strip(),
 'OPENCODE_CONFIG':str(config),'COLOOP_HOOK_CONNECTION':str(connection),
 'COLOOP_MANAGED_CONNECTION':str(connection),'LANG':'C.UTF-8','LC_ALL':'C.UTF-8',
 'TERM':os.environ.get('TERM','xterm-256color')}
for flag in ('AUTOUPDATE','MODELS_FETCH','LSP_DOWNLOAD','DEFAULT_PLUGINS','PROJECT_CONFIG','AUTOCOMPACT','PRUNE','CLAUDE_CODE','EXTERNAL_SKILLS'):
 env['OPENCODE_DISABLE_'+flag]='true'
if os.environ.get('OPENCODE_SERVER_PASSWORD'):
 env['OPENCODE_SERVER_USERNAME']='opencode'
 env['OPENCODE_SERVER_PASSWORD']=os.environ['OPENCODE_SERVER_PASSWORD']
os.chdir(workspace)
os.execve(str(root/'bin/opencode'),[str(root/'bin/opencode'),'--log-level=ERROR',*arguments],env)
PY
