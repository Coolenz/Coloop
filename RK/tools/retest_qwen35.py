"""Repeat isolated text inferences without changing the deployed model or settings."""
import datetime
import argparse
import getpass
import json
import os
import subprocess
import sys

from prepare_qwen35 import ROOT

ORIGINAL = '请用中文简短回答：20元买3支笔，每支4元，还剩多少钱？'
CASES = [
    ('original-1', ORIGINAL, '8元'),
    ('original-2', ORIGINAL, '8元'),
    ('original-3', ORIGINAL, '8元'),
    ('addition', '只回答数字：2加3等于多少？', '5'),
    ('subtraction', '只回答数字：20减12等于多少？', '8'),
    ('capital', '中国的首都是哪里？只回答城市名。', '北京'),
    ('copy', '请原样输出这四个字，不要添加其他内容：你好世界', '你好世界'),
    ('english', 'I have 20 yuan and buy 3 pens at 4 yuan each. How many yuan remain? Answer only with the number.', '8'),
]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--board-subdir', choices=['qwen35', 'qwen35-4b'], default='qwen35')
    args = parser.parse_args()
    environment = os.environ.copy()
    if not environment.get('RK_BOARD_PASSWORD'):
        environment['RK_BOARD_PASSWORD'] = getpass.getpass('Board password: ')
    environment['PYTHONIOENCODING'] = 'utf-8'
    timestamp = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))).strftime('%Y%m%d-%H%M%S')
    destination = ROOT / 'logs' / (args.board_subdir + '-retest-' + timestamp)
    destination.mkdir(parents=True, exist_ok=False)
    report = {'created_at': timestamp, 'timezone': 'Asia/Shanghai',
              'settings': {'context': 2048, 'max_new_tokens': 64, 'thinking': False,
                           'process_isolation': 'fresh model process for each case'},
              'cases': [], 'scope': 'Eight small repeated/text checks, not a general benchmark.'}
    for number, (name, question, expected) in enumerate(CASES, 1):
        case_dir = destination / f'{number:02d}-{name}'
        case_dir.mkdir()
        print(f'[{number}/{len(CASES)}] {name}: {question}', flush=True)
        command = [sys.executable, str(ROOT / 'tools/smoke_qwen35.py'), '--board-subdir', args.board_subdir, '--prompt', question,
                   '--tokens', '64', '--timeout', '240', '--output-dir', str(case_dir)]
        with (case_dir / 'controller.txt').open('w', encoding='utf-8') as output:
            result = subprocess.run(command, cwd=ROOT, env=environment, stdout=output,
                                    stderr=subprocess.STDOUT, timeout=300)
        status_path = case_dir / 'qwen35-text-status.json'
        if not status_path.exists():
            report['cases'].append({'name': name, 'controller_exit_code': result.returncode,
                                    'error': 'No inference report; inspect controller.txt'})
            break
        status = json.loads(status_path.read_text(encoding='utf-8'))
        samples = status.get('samples', [])
        item = {'name': name, 'prompt': question, 'expected': expected,
                'answer': status['answer'], 'elapsed_seconds': status['elapsed_seconds'],
                'inference_exit_code': status['return_code'], 'abort': status['abort'],
                'max_temperature_c': max((s['max_temperature_c'] for s in samples
                                          if s['max_temperature_c'] is not None), default=None),
                'correctness': 'pending manual review'}
        report['cases'].append(item)
        (destination / 'summary.json').write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding='utf-8')
        print(json.dumps(item, ensure_ascii=False), flush=True)
        if status['abort'] or status['return_code'] != 0:
            break
    (destination / 'summary.json').write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding='utf-8')
    print('Saved:', destination, flush=True)


if __name__ == '__main__':
    main()
