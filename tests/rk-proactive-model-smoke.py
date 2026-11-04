"""Explicit real RK classification-only smoke. No HID imports or cloud requests."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import shlex
import sys
import time


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--observation', type=Path)
    parser.add_argument('--classify-only', action='store_true', help='Compatibility flag; always enabled')
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=False)
    root = Path('D:/RK')
    sys.path.insert(0, str(root / 'tools'))
    import paramiko
    from board_remote import PinnedKey
    config = json.loads((root / 'config/board.json').read_text(encoding='utf-8-sig'))
    source = (Path(__file__).parents[1] / 'resources/rk-proactive-agent.py').read_bytes()
    observation = json.loads(args.observation.read_text(encoding='utf-8'))[-1] if args.observation else {
        'ocr_items': [{'id': 0, 'text': '产品发布计划'}]}
    compact = {'ocr_items': [{'id': row.get('id', index), 'text': row.get('text', row.get('name', ''))}
                             for index, row in enumerate(observation['ocr_items'])], 'is_editing': False}
    script = '''import base64,json,sys,time,types
from pathlib import Path
root=Path.home()/'rk-opencode'
sys.path.insert(0,str(root/'agent'))
mod=types.ModuleType('proactive_classify_smoke')
exec(base64.b64decode(SOURCE),mod.__dict__)
payload=json.loads(base64.b64decode(PAYLOAD))
started=time.monotonic()
try:
 result=mod.Qwen(root)(mod.CLASSIFY,payload,16)
 assert type(result) is int and result in (0,1,2),'invalid_gate'
 row={'case':'classify','generated':result,'result':result,'elapsed_ms':round((time.monotonic()-started)*1000),'ok':True}
except Exception as error:
 row={'case':'classify','error':type(error).__name__,'detail':str(error)[:200],
      'elapsed_ms':round((time.monotonic()-started)*1000),'ok':False}
print(json.dumps({'results':[row],'hid_inputs':0,'cloud_calls':0,'local_execution_calls':0},ensure_ascii=False))
'''.replace('SOURCE', repr(base64.b64encode(source).decode())).replace('PAYLOAD',
        repr(base64.b64encode(json.dumps(compact, ensure_ascii=False).encode()).decode()))
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(PinnedKey(config['host_key_sha256']))
    try:
        client.connect(config['host'], port=config.get('ssh_port', 22), username=config['user'],
                       password=os.environ['RK_BOARD_PASSWORD'], allow_agent=False,
                       look_for_keys=False, timeout=5)
        _, output, errors = client.exec_command('python3 -u -c ' + shlex.quote(script), timeout=240)
        raw, stderr = output.read().decode(), errors.read().decode()
        code = output.channel.recv_exit_status()
        (args.output / 'result.json').write_text(raw, encoding='utf-8')
        (args.output / 'stderr.txt').write_text(stderr, encoding='utf-8')
        manifest = {'source_sha256': hashlib.sha256(source).hexdigest(), 'exit_code': code,
                    'scope': 'real RK Qwen classify only; zero cloud/HID/local action translation',
                    'observation': 'recorded isolated live OCR' if args.observation else 'synthetic title',
                    'timestamp': time.time()}
        (args.output / 'manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
        print(raw)
        print(json.dumps(manifest))
        if code:
            raise SystemExit(code)
    finally:
        client.close()


if __name__ == '__main__':
    main()
