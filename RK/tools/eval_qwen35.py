"""Run a fixed diagnostic set with isolated board processes and separate answer review."""
import argparse
import datetime
import getpass
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

from prepare_qwen35 import ROOT


def normalize(answer):
    return answer.strip().strip('。.!！\n\r ')


def check_answer(case, answer):
    if 'json_expected' in case:
        try:
            return json.loads(answer) == case['json_expected']
        except (json.JSONDecodeError, TypeError):
            return False
    return normalize(answer) in {normalize(x) for x in case.get('accepted', [case['expected']])}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--board-subdir', choices=['qwen35', 'qwen35-4b', 'qwen35-4b-131'], default='qwen35-4b')
    parser.add_argument('--dataset', type=Path, default=ROOT / 'tools/evalsets/qwen35-diverse-v1.json')
    parser.add_argument('--tokens', type=int, default=128)
    args = parser.parse_args()
    raw = args.dataset.read_bytes()
    dataset = json.loads(raw)
    assert len({x['id'] for x in dataset['cases']}) == len(dataset['cases'])
    environment = os.environ.copy()
    environment['PYTHONIOENCODING'] = 'utf-8'
    if not environment.get('RK_BOARD_PASSWORD'):
        environment['RK_BOARD_PASSWORD'] = getpass.getpass('Board password: ')
    timestamp = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))).strftime('%Y%m%d-%H%M%S')
    destination = ROOT / 'logs' / f'{args.board_subdir}-{dataset.get("log_label", "diverse")}-{timestamp}'
    destination.mkdir(parents=True, exist_ok=False)
    (destination / 'dataset.json').write_bytes(raw)
    report = {'created_at': timestamp, 'timezone': 'Asia/Shanghai', 'dataset': dataset['name'],
              'dataset_sha256': hashlib.sha256(raw).hexdigest(), 'dataset_source': dataset['source'],
              'dataset_provenance': dataset.get('provenance'),
              'board_subdir': args.board_subdir,
              'settings': {'context': 2048, 'max_new_tokens': args.tokens, 'thinking': False, 'top_k': 1,
                           'process_isolation': 'fresh model process for each case'},
              'scope': dataset['scope'], 'cases': []}
    report['planned_cases'] = len(dataset['cases'])
    for number, case in enumerate(dataset['cases'], 1):
        case_dir = destination / f'{number:02d}-{case["id"]}'
        case_dir.mkdir()
        print(f'[{number}/{len(dataset["cases"])}] {case["category"]}/{case["id"]}', flush=True)
        command = [sys.executable, str(ROOT / 'tools/smoke_qwen35.py'), '--board-subdir', args.board_subdir,
                   '--prompt', case['prompt'], '--tokens', str(args.tokens), '--timeout', '180',
                   '--output-dir', str(case_dir)]
        with (case_dir / 'controller.txt').open('w', encoding='utf-8') as output:
            try:
                result = subprocess.run(command, cwd=ROOT, env=environment, stdout=output,
                                        stderr=subprocess.STDOUT, timeout=240)
            except subprocess.TimeoutExpired:
                result = None
        status_path = case_dir / 'qwen35-text-status.json'
        if not status_path.exists():
            report['cases'].append(dict(case, answer='', error='No inference report; inspect controller.txt'))
            break
        status = json.loads(status_path.read_text(encoding='utf-8'))
        passed = check_answer(case, status['answer'])
        item = {'id': case['id'], 'category': case['category'], 'prompt': case['prompt'],
                'expected': case['expected'], 'answer': status['answer'],
                'automatic_match': passed, 'review': 'pending manual review',
                'elapsed_seconds': status['elapsed_seconds'], 'return_code': status['return_code'],
                'abort': status['abort'], 'controller_return_code': None if result is None else result.returncode,
                'max_temperature_c': max((s['max_temperature_c'] for s in status['samples']
                                          if s['max_temperature_c'] is not None), default=None)}
        item.update({key: case[key] for key in ['subject_zh', 'supercategory', 'is_math', 'is_hard'] if key in case})
        report['cases'].append(item)
        (destination / 'summary.json').write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding='utf-8')
        print(json.dumps(item, ensure_ascii=False), flush=True)
        if item['return_code'] or item['abort']:
            break
    (destination / 'summary.json').write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding='utf-8')
    if all(case['expected'] in {'A', 'B', 'C', 'D'} for case in dataset['cases']):
        from score_qwen35_eval import score_report
        scores = score_report(report)
        (destination / 'scores.json').write_text(json.dumps(scores, indent=2, ensure_ascii=False), encoding='utf-8')
        print('Scores:', json.dumps(scores, ensure_ascii=False), flush=True)
    print('Saved:', destination, flush=True)


if __name__ == '__main__':
    main()
