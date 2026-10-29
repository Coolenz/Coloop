"""Run a fixed four-option benchmark on the Linux board, one fresh app per case."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import time

from score_qwen35_eval import score_report


def temperatures():
    readings = []
    for path in Path('/sys/class/thermal').glob('thermal_zone*/temp'):
        try:
            readings.append(int(path.read_text().strip()) / 1000)
        except (ValueError, OSError):
            continue
    return max(readings, default=None)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--app-dir', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--dataset', type=Path, default=Path(__file__).with_name('cmmlu-balanced-seed42-48.json'))
    parser.add_argument('--tokens', type=int, default=128)
    args = parser.parse_args()
    args.app_dir = args.app_dir.resolve()
    raw = args.dataset.read_bytes()
    dataset = json.loads(raw)
    stamp = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))).strftime('%Y%m%d-%H%M%S')
    destination = args.app_dir / 'eval-results' / (dataset.get('log_label', 'benchmark') + '-' + stamp)
    destination.mkdir(parents=True, exist_ok=False)
    (destination / 'dataset.json').write_bytes(raw)
    report = {'created_at': stamp, 'timezone': 'Asia/Shanghai', 'dataset': dataset['name'],
              'dataset_sha256': hashlib.sha256(raw).hexdigest(), 'dataset_provenance': dataset['provenance'],
              'planned_cases': len(dataset['cases']), 'status': 'running',
              'settings': {'context': 2048, 'max_new_tokens': args.tokens, 'thinking': False, 'top_k': 1,
                           'process_isolation': 'fresh RKLLM application process per case',
                           'cache': 'RKLLM application default; differs from PC no-cache reference'}, 'cases': []}
    environment = dict(os.environ, LANG='C.UTF-8', LC_ALL='C.UTF-8', RKLLM_LOG_LEVEL='1')
    for number, case in enumerate(dataset['cases'], 1):
        before_temp = temperatures()
        if before_temp is not None and before_temp >= 80:
            report['status'] = 'aborted'
            report['abort'] = 'temperature >= 80 C before case'
            break
        command = ['bash', str(args.app_dir / 'run.sh'), '--context', '2048', '--tokens', str(args.tokens),
                   '--prompt', case['prompt']]
        start = time.monotonic()
        process = subprocess.Popen(command, cwd=args.app_dir, env=environment, stdout=subprocess.PIPE,
                                   stderr=subprocess.STDOUT, start_new_session=True)
        abort = None
        try:
            output, _ = process.communicate(timeout=180)
        except subprocess.TimeoutExpired:
            abort = '180-second process timeout'
            os.killpg(process.pid, signal.SIGTERM)
            try:
                output, _ = process.communicate(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                output, _ = process.communicate()
        log = output.decode('utf-8', errors='replace')
        (destination / f'{number:02d}-{case["id"]}.txt').write_text(log, encoding='utf-8')
        answer = log.split('Answer: ', 1)[1].split('\nI rkllm:', 1)[0].split('\nTURN_SECONDS=', 1)[0].strip() if 'Answer: ' in log else ''
        item = {'id': case['id'], 'category': case['category'], 'prompt': case['prompt'],
                'expected': case['expected'], 'answer': answer,
                'automatic_match': answer == case['expected'], 'return_code': process.returncode, 'abort': abort,
                'elapsed_seconds': round(time.monotonic() - start, 3), 'max_temperature_c': temperatures()}
        item.update({key: case[key] for key in ['subject_zh', 'supercategory', 'is_math', 'is_hard'] if key in case})
        report['cases'].append(item)
        (destination / 'summary.json').write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding='utf-8')
        print(f'[{number}/{len(dataset["cases"])}] ' + json.dumps(item, ensure_ascii=False), flush=True)
        if abort or process.returncode:
            report['status'] = 'aborted'
            break
    if report['status'] == 'running':
        report['status'] = 'completed'
    (destination / 'summary.json').write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding='utf-8')
    if report['cases']:
        scores = score_report(report)
        (destination / 'scores.json').write_text(json.dumps(scores, indent=2, ensure_ascii=False), encoding='utf-8')
        print(json.dumps(scores, indent=2, ensure_ascii=False))
    print('Saved:', destination)


if __name__ == '__main__':
    main()
