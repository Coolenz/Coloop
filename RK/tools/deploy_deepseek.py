"""Deploy the pinned RKLLM demo without changing system NPU libraries."""
import argparse
import getpass
import hashlib
import json
import os
import shlex
import time

import paramiko
from board_remote import PinnedKey
from prepare_deepseek import DEST, SDK_DEST, MODEL_FILE, MODEL_SHA, MODEL_SIZE, ROOT


def runtime_bundle():
    bundle = ROOT / 'deployment/deepseek'
    files = {
        'lib/librkllmrt.so': SDK_DEST / 'rkllm-runtime/Linux/librkllm_api/aarch64/librkllmrt.so',
        'include/rkllm.h': SDK_DEST / 'rkllm-runtime/Linux/librkllm_api/include/rkllm.h',
        'LICENSE': SDK_DEST / 'LICENSE',
        'MODEL-CARD.md': DEST / 'MODEL-CARD.md',
    }
    for relative, source in files.items():
        target = bundle / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(source.read_bytes())
    source = (SDK_DEST / 'examples/rkllm_api_demo/deploy/src/llm_demo.cpp').read_text(encoding='utf-8')
    source = source.replace('#include "rkllm.h"', '#include "rkllm.h"\n#include "input_utf8.h"')
    source = source.replace('std::getline(std::cin, input_str);',
                            'if (!std::getline(std::cin, input_str)) break;\n'
                            "        if (!input_str.empty() && input_str.back() == '\\r') input_str.pop_back();\n"
                            '        if (input_str.empty()) continue;\n'
                            '        if (!valid_utf8_input(input_str)) {\n'
                            '            std::cerr << "输入不是有效的 UTF-8，已忽略。请通过更新后的启动入口重试。" << std::endl;\n'
                            '            continue;\n'
                            '        }')
    source = source.replace('// rkllm_set_chat_template(llmHandle, "", "<｜User｜>", "<｜Assistant｜>");',
                            'rkllm_set_chat_template(llmHandle, "", "<｜begin▁of▁sentence｜><｜User｜>", "<｜Assistant｜>");')
    source = source.replace('RKLLMInput rkllm_input;', 'RKLLMInput rkllm_input = {};')
    source = source.replace('printf("%s", result->text);', 'printf("%s", result->text);\n        fflush(stdout);')
    source = source.replace('rkllm_run(llmHandle, &rkllm_input, &rkllm_infer_params, NULL);',
                            'ret = rkllm_run(llmHandle, &rkllm_input, &rkllm_infer_params, NULL);\n'
                            '        if (ret != 0) { rkllm_destroy(llmHandle); return 2; }')
    start = source.index('    vector<string> pre_input;')
    end = source.index('    cout <<', start)
    source = source[:start] + ('    vector<string> pre_input;\n'
                              '    pre_input.push_back("请用中文简单介绍你自己。");\n'
                              '    pre_input.push_back("有28位小朋友排成一行，从左边数第10位的小朋友，从右边数是第几位？");\n') + source[end:]
    (bundle / 'llm_demo.cpp').write_text(source, encoding='utf-8')
    (bundle / 'run.sh').write_text(
        '#!/usr/bin/env bash\nset -euo pipefail\n'
        'cd "$(dirname "$(readlink -f "$0")")"\n'
        'export LD_LIBRARY_PATH="$PWD/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"\n'
        'export RKLLM_LOG_LEVEL="${RKLLM_LOG_LEVEL:-1}"\n'
        'exec flock -n -E 75 "$PWD/.inference.lock" ./llm_demo '
        f'"$PWD/{MODEL_FILE}" "${{1:-512}}" "${{2:-2048}}"\n', encoding='utf-8', newline='\n')
    return bundle


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--stage', choices=['runtime', 'model', 'all'], default='all')
    args = parser.parse_args()
    cfg = json.loads((ROOT / 'config/board.json').read_text(encoding='utf-8-sig'))
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(PinnedKey(cfg['host_key_sha256']))
    password = os.environ.get('RK_BOARD_PASSWORD') or getpass.getpass('Board password: ')
    client.connect(cfg['host'], port=cfg.get('ssh_port', 22), username=cfg['user'],
                   password=password, allow_agent=False, look_for_keys=False, timeout=8)
    client.get_transport().set_keepalive(20)
    remote = cfg['project_dir'] + '/deepseek'

    def command(script):
        _, stdout, _ = client.exec_command('bash -lc ' + shlex.quote('set -e\n' + script))
        stdout.channel.set_combine_stderr(True)
        for line in stdout:
            print(line, end='', flush=True)
        status = stdout.channel.recv_exit_status()
        if status:
            raise RuntimeError(f'Remote command failed with status {status}')

    try:
        command('mkdir -p ' + shlex.quote(remote + '/lib') + ' ' + shlex.quote(remote + '/include'))
        with client.open_sftp() as sftp:
            if args.stage in ('runtime', 'all'):
                bundle = runtime_bundle()
                for path in sorted(bundle.rglob('*')):
                    if not path.is_file():
                        continue
                    target = remote + '/' + path.relative_to(bundle).as_posix()
                    sftp.put(str(path), target)
                    digest = hashlib.sha256(path.read_bytes()).hexdigest()
                    command('printf %s ' + shlex.quote(digest + '  ' + target + '\n') + ' | sha256sum -c -')
                command('cd ' + shlex.quote(remote) + '\n'
                        "g++ -O2 -std=c++11 -Iinclude llm_demo.cpp -Llib -lrkllmrt -Wl,-rpath,'$ORIGIN/lib' -o llm_demo\n"
                        'chmod +x run.sh\nldd ./llm_demo')
            if args.stage in ('model', 'all'):
                source = DEST / MODEL_FILE
                if not source.exists() or source.stat().st_size != MODEL_SIZE:
                    raise RuntimeError('Run prepare_deepseek.py to complete the model first')
                manifest = json.loads((DEST / 'manifest.json').read_text(encoding='utf-8'))
                if manifest['model']['sha256'] != MODEL_SHA:
                    raise RuntimeError('Unexpected model manifest')
                target = remote + '/' + MODEL_FILE
                last = [time.monotonic()]

                def progress(done, total):
                    if time.monotonic() - last[0] > 10:
                        print(f'Model upload: {done / total:.1%}', flush=True)
                        last[0] = time.monotonic()

                sftp.put(str(source), target + '.partial', callback=progress)
                command('printf %s ' + shlex.quote(MODEL_SHA + '  ' + target + '.partial\n') +
                        ' | sha256sum -c -\nmv -- ' + shlex.quote(target + '.partial') + ' ' + shlex.quote(target))
                sftp.put(str(DEST / 'manifest.json'), remote + '/manifest.json')
                print('Model upload and board SHA256 verification passed.', flush=True)
    finally:
        client.close()


if __name__ == '__main__':
    main()
