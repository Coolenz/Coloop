"""Deploy Qwen3.5-9B into its own board directory; preserve system runtimes."""
import argparse
import getpass
import json
import os
import shlex
import threading
import time

import paramiko
from board_remote import PinnedKey, proxy_request
from build_qwen35_bundle import BUNDLE, main as build_bundle
from prepare_qwen35 import DEST, FILES, ROOT, REPO, REVISION, digest


def connect():
    cfg = json.loads((ROOT / 'config/board.json').read_text(encoding='utf-8-sig'))
    password = os.environ.get('RK_BOARD_PASSWORD') or getpass.getpass('Board password: ')
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(PinnedKey(cfg['host_key_sha256']))
    client.connect(cfg['host'], port=cfg.get('ssh_port', 22), username=cfg['user'],
                   password=password, allow_agent=False, look_for_keys=False, timeout=8)
    client.get_transport().set_keepalive(20)
    return client, cfg, password


def command(client, script, password=None):
    remote_command = 'bash -lc ' + shlex.quote('set -e\n' + script)
    if password is not None:
        remote_command = "sudo -S -p '' " + remote_command
    stdin, stdout, _ = client.exec_command(remote_command)
    stdout.channel.set_combine_stderr(True)
    if password is not None:
        stdin.write(password + '\n')
        stdin.flush()
    stdin.channel.shutdown_write()
    for line in stdout:
        print(line, end='', flush=True)
    rc = stdout.channel.recv_exit_status()
    if rc:
        raise RuntimeError(f'Board command exited with status {rc}')


def dependencies(client, password):
    _, clock_output, _ = client.exec_command('date +%s')
    board_epoch = int(clock_output.read().decode().strip())
    if abs(time.time() - board_epoch) > 120:
        print('Correcting board clock from the host before signed package-index checks.', flush=True)
        command(client, 'date -u -s @' + str(int(time.time())), password)
    transport = client.get_transport()
    # Board packages use a proxy only while this authenticated SSH session lives.
    port = transport.request_port_forward('127.0.0.1', 0)

    def accept():
        while transport.is_active():
            channel = transport.accept(1)
            if channel:
                threading.Thread(target=proxy_request, args=(channel,), daemon=True).start()

    threading.Thread(target=accept, daemon=True).start()
    command(client, f'''export LANG=C.UTF-8 LC_ALL=C.UTF-8
export http_proxy=http://127.0.0.1:{port} https_proxy=http://127.0.0.1:{port}
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    libopencv-core-dev libopencv-imgproc-dev libopencv-imgcodecs-dev time
''', password)


def mkdirs(sftp, path):
    current = ''
    for part in path.split('/'):
        if not part:
            continue
        current += '/' + part
        try:
            sftp.stat(current)
        except FileNotFoundError:
            sftp.mkdir(current)


def runtime(client, remote, *, bundle=BUNDLE, builder=build_bundle):
    builder()
    with client.open_sftp() as sftp:
        for path in sorted(bundle.rglob('*')):
            if not path.is_file():
                continue
            target = remote + '/' + path.relative_to(bundle).as_posix()
            mkdirs(sftp, target.rsplit('/', 1)[0])
            sftp.put(str(path), target)
    command(client, 'cd ' + shlex.quote(remote) + '''
cp -L /usr/lib/librknnrt.so lib/librknnrt.so
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build -j2
chmod +x run.sh
ldd build/qwen35 | awk '/librkllmrt|librknnrt|not found/'
./build/qwen35 --help
''')


def models(client, remote, text_only=False, *, destination=DEST, files=FILES, repository=REPO, revision=REVISION):
    uploaded = {}
    with client.open_sftp() as sftp:
        mkdirs(sftp, remote)
        for name, spec in files.items():
            if text_only and name.endswith('.rknn'):
                continue
            local = destination / name
            if not local.exists() or local.stat().st_size != spec['bytes'] or digest(local) != spec['sha256']:
                raise RuntimeError(f'Prepare and verify the model first: {name}')
            target = remote + '/' + name
            try:
                stat = sftp.stat(target)
            except FileNotFoundError:
                stat = None
            if stat is not None:
                if stat.st_size != spec['bytes']:
                    raise RuntimeError(f'Unexpected existing board model: {target}')
                command(client, 'printf %s ' + shlex.quote(spec['sha256'] + '  ' + target + '\n') + ' | sha256sum -c -')
                uploaded[name] = spec
                continue
            partial = target + '.partial'
            try:
                offset = sftp.stat(partial).st_size
            except FileNotFoundError:
                offset = 0
            if offset > spec['bytes']:
                raise RuntimeError('Oversized partial upload')
            last = time.monotonic()
            print(f'Uploading {name}, resume offset {offset}', flush=True)
            with local.open('rb') as source, sftp.open(partial, 'ab') as output:
                source.seek(offset)
                output.set_pipelined(True)
                done = offset
                while chunk := source.read(1024 * 1024):
                    output.write(chunk)
                    done += len(chunk)
                    if time.monotonic() - last >= 10:
                        print(f'Upload {name}: {done / spec["bytes"]:.1%}', flush=True)
                        last = time.monotonic()
            command(client, 'printf %s ' + shlex.quote(spec['sha256'] + '  ' + partial + '\n') +
                    ' | sha256sum -c -\nmv -- ' + shlex.quote(partial) + ' ' + shlex.quote(target))
            uploaded[name] = spec
        with sftp.open(remote + '/model-manifest.json', 'w') as output:
            output.write(json.dumps({'repository': repository, 'revision': revision,
                                     'files_verified_on_board': uploaded}, indent=2))
    print(f'{len(uploaded)} board model SHA256 checks passed.', flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--stage', choices=['dependencies', 'runtime', 'models', 'all'], default='all')
    parser.add_argument('--text-model-only', action='store_true', help='Upload only the language model')
    args = parser.parse_args()
    client, cfg, password = connect()
    remote = cfg['project_dir'].rstrip('/') + '/qwen35'
    try:
        if args.stage in ('dependencies', 'all'):
            dependencies(client, password)
        if args.stage in ('runtime', 'all'):
            runtime(client, remote)
        if args.stage in ('models', 'all'):
            models(client, remote, args.text_model_only)
    finally:
        client.close()


if __name__ == '__main__':
    main()
