"""Run bounded text/image checks, recording board memory and temperature."""
import argparse
import json
from pathlib import Path
import re
import shlex
import time

from deploy_qwen35 import connect
from prepare_qwen35 import ROOT


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--image', action='store_true')
    parser.add_argument('--board-subdir', choices=['qwen35', 'qwen35-4b', 'qwen35-4b-131'], default='qwen35')
    parser.add_argument('--prompt')
    parser.add_argument('--tokens', type=int, default=64)
    parser.add_argument('--context', type=int, default=2048,
                        help='Context budget; default 2048 preserves existing comparison protocols')
    parser.add_argument('--timeout', type=int, default=600)
    parser.add_argument('--output-dir', type=Path)
    args = parser.parse_args()
    if not 512 <= args.context <= 16384 or not 1 <= args.tokens <= 1024 or args.tokens >= args.context:
        parser.error('Require context 512..16384, output 1..1024, and output < context')
    if args.output_dir is None:
        args.output_dir = ROOT / 'logs' / args.board_subdir if args.board_subdir != 'qwen35' else ROOT / 'logs'
    mode = 'image' if args.image else 'text'
    question = args.prompt or ('请用中文简短描述这张图片，指出主要人物、地点和手里的物品。'
                               if args.image else '请用中文简短回答：20元买3支笔，每支4元，还剩多少钱？')
    client, cfg, _ = connect()
    remote = cfg['project_dir'].rstrip('/') + '/' + args.board_subdir
    argv = ['bash', 'run.sh', '--context', str(args.context), '--tokens', str(args.tokens), '--prompt', question]
    if args.image:
        argv += ['--image', 'samples/moon.jpg']
    command = ('cd ' + shlex.quote(remote) + '; echo TASK_PID=$$; exec timeout --signal=TERM '
               f'--kill-after=10s {args.timeout}s /usr/bin/time -v ' + shlex.join(argv))
    start = time.monotonic()
    monitor_at = 0.0
    collected = bytearray()
    samples = []
    abort = None
    pid = None
    args.output_dir.mkdir(parents=True, exist_ok=True)
    log_path = args.output_dir / f'qwen35-{mode}-smoke.txt'
    try:
        _, stdout, _ = client.exec_command('bash -lc ' + shlex.quote(command))
        channel = stdout.channel
        channel.set_combine_stderr(True)
        with log_path.open('wb') as log:
            while True:
                if channel.recv_ready():
                    data = channel.recv(65536)
                    collected.extend(data)
                    log.write(data)
                    log.flush()
                    print(data.decode('utf-8', errors='replace'), end='', flush=True)
                    if pid is None and b'TASK_PID=' in collected:
                        remainder = collected.split(b'TASK_PID=', 1)[1]
                        if b'\n' in remainder:
                            pid = int(remainder.split(b'\n', 1)[0].strip())
                if channel.exit_status_ready() and not channel.recv_ready():
                    break
                if time.monotonic() >= monitor_at:
                    script = ("printf 'MEM '; awk '/MemAvailable:|SwapFree:/{printf \"%s=%s \",$1,$2}' /proc/meminfo; "
                              "printf '\\nTEMP '; cat /sys/class/thermal/thermal_zone*/temp; "
                              "printf 'RSS '; ps -C qwen35 -o rss=")
                    _, status, _ = client.exec_command(script)
                    reading = status.read().decode()
                    temperatures = [int(line) / 1000 for line in reading.splitlines() if line.strip().isdigit()]
                    # First temperature shares the TEMP prefix, unlike subsequent lines.
                    for line in reading.splitlines():
                        if line.startswith('TEMP ') and line[5:].strip().isdigit():
                            temperatures.append(int(line[5:]) / 1000)
                    sample = {'seconds': round(time.monotonic() - start, 1), 'raw': reading,
                              'max_temperature_c': max(temperatures, default=None)}
                    samples.append(sample)
                    if temperatures and max(temperatures) >= 80:
                        abort = 'temperature >= 80 C'
                    if time.monotonic() - start > args.timeout + 20:
                        abort = 'wall timeout'
                    if abort and pid:
                        client.exec_command(f'kill -TERM {pid}')
                        print('\nStopped bounded test:', abort, flush=True)
                    monitor_at = time.monotonic() + 5
                time.sleep(0.1)
        rc = channel.recv_exit_status()
    finally:
        client.close()
    decoded = collected.decode('utf-8', errors='replace')
    answer = decoded.split('Answer: ', 1)[1].split('\nI rkllm:', 1)[0].strip() if 'Answer: ' in decoded else ''
    answer_check = None
    if mode == 'text' and args.prompt is None:
        # A later mention of 8 does not validate a contradictory first answer.
        lead = answer.splitlines()[0] if answer else ''
        answer_check = bool(re.search(r'(?<!\d)8(?!\d)|八元', lead))
    report = {'model_directory': remote, 'mode': mode, 'prompt': question, 'max_new_tokens': args.tokens, 'context': args.context,
              'elapsed_seconds': round(time.monotonic() - start, 2), 'return_code': rc,
              'abort': abort, 'answer': answer, 'arithmetic_answer_check': answer_check, 'samples': samples,
              'scope': 'Single bounded inference, not a general quality or sustained-load benchmark'}
    (args.output_dir / f'qwen35-{mode}-status.json').write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding='utf-8')
    print('\nReport:', json.dumps({k: v for k, v in report.items() if k != 'samples'}, ensure_ascii=False))
    if rc or abort or answer_check is False:
        raise SystemExit(rc or 1)


if __name__ == '__main__':
    main()
