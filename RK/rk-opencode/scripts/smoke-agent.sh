#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
result_dir="logs/agent-$(date +%Y%m%d-%H%M%S)-$$"
mkdir -p workspace "$result_dir"
python3 - "$result_dir" <<'PYBOARD'
import secrets
import sys
from pathlib import Path
text='VERIFICATION_TOKEN=' + secrets.token_hex(6) + '\n'
Path('workspace/probe.txt').write_text(text)
(Path(sys.argv[1])/'probe.txt').write_text(text)
PYBOARD
set +e
timeout 240 bash scripts/opencode.sh run --format json --agent rk-local \
    'Read probe.txt with the read tool. Report the exact VERIFICATION_TOKEN from its contents.' \
    > "$result_dir/opencode.jsonl" 2> "$result_dir/opencode.stderr"
code=$?
set -e
python3 - "$code" "$result_dir" <<'PYBOARD'
import json
import sys
from pathlib import Path
folder=Path(sys.argv[2])
expected=(folder/'probe.txt').read_text().strip().split('=',1)[1]
events=[]
for line in (folder/'opencode.jsonl').read_text().splitlines():
    try: events.append(json.loads(line))
    except ValueError: pass
calls=[e for e in events if e.get('type')=='tool_use' and e.get('part',{}).get('tool')=='read'
       and e.get('part',{}).get('state',{}).get('status')=='completed']
answers='\n'.join(e.get('part',{}).get('text','') for e in events if e.get('type')=='text')
result={'read_tool_completed':bool(calls),'answer_contains_actual_token':expected in answers,
        'exit_code':int(sys.argv[1]),'passed':bool(calls) and expected in answers and int(sys.argv[1])==0,
        'result_dir':str(folder)}
(folder/'status.json').write_text(json.dumps(result,indent=2))
Path('logs/agent-status.json').write_text(json.dumps(result,indent=2))
print(json.dumps(result))
raise SystemExit(0 if result['passed'] else 1)
PYBOARD
