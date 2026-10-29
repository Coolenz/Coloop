"""Deploy to the known USB-connected board with a session-only loopback proxy."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import shlex
import socket
import threading
import time
from urllib.parse import urlsplit

import paramiko

ROOT = Path(__file__).resolve().parents[1]


class PinnedKey(paramiko.MissingHostKeyPolicy):
    def __init__(self, expected):
        self.expected = expected

    def missing_host_key(self, client, hostname, key):
        actual = base64.b64encode(hashlib.sha256(key.asbytes()).digest()).decode().rstrip('=')
        if actual != self.expected:
            raise paramiko.SSHException(f'Board host key mismatch for {hostname}')


def relay(source, destination):
    try:
        while data := source.recv(65536):
            destination.sendall(data)
    except (OSError, EOFError):
        pass
    finally:
        try:
            destination.shutdown(socket.SHUT_WR)
        except (OSError, EOFError):
            pass


def proxy_request(channel):
    upstream = None
    try:
        header = b''
        while b'\r\n\r\n' not in header:
            data = channel.recv(4096)
            if not data or len(header) > 65536:
                return
            header += data
        headers, body = header.split(b'\r\n\r\n', 1)
        lines = headers.split(b'\r\n')
        method, target, version = lines[0].decode('ascii').split(' ', 2)
        if method == 'CONNECT':
            address, port = target.rsplit(':', 1)
            upstream = socket.create_connection((address, int(port)), timeout=45)
            channel.sendall(b'HTTP/1.1 200 Connection Established\r\n\r\n')
        else:
            parsed = urlsplit(target)
            if parsed.scheme != 'http' or not parsed.hostname:
                raise ValueError('An absolute HTTP URL is required')
            upstream = socket.create_connection((parsed.hostname, parsed.port or 80), timeout=45)
            path = parsed.path or '/'
            if parsed.query:
                path += '?' + parsed.query
            kept = [line for line in lines[1:] if not line.lower().startswith(
                (b'connection:', b'proxy-connection:'))]
            upstream.sendall(f'{method} {path} {version}\r\n'.encode() +
                             b'\r\n'.join(kept) + b'\r\nConnection: close\r\n\r\n' + body)
        upstream.settimeout(120)
        sender = threading.Thread(target=relay, args=(channel, upstream), daemon=True)
        sender.start()
        relay(upstream, channel)
    except Exception as exc:
        print(f'Proxy request failed: {type(exc).__name__}: {exc}', flush=True)
        try:
            channel.sendall(b'HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n')
        except (OSError, EOFError):
            pass
    finally:
        channel.close()
        if upstream:
            upstream.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--upload', action='store_true')
    parser.add_argument('--command-file', type=Path)
    parser.add_argument('--run', choices=['check', 'smoke', 'resnet'])
    parser.add_argument('--sudo', action='store_true')
    parser.add_argument('--proxy', action='store_true')
    parser.add_argument('--wait', type=int, default=0, help='Retry an unavailable USB SSH link for this many seconds')
    parser.add_argument('--log', type=Path, default=ROOT / 'logs/board-remote.txt')
    args = parser.parse_args()
    cfg = json.loads((ROOT / 'config/board.json').read_text(encoding='utf-8-sig'))
    password = os.environ.get('RK_BOARD_PASSWORD')
    if not password:
        import getpass
        password = getpass.getpass('Board password: ')
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(PinnedKey(cfg['host_key_sha256']))
    deadline = time.monotonic() + args.wait
    while True:
        try:
            client.connect(cfg['host'], port=cfg.get('ssh_port', 22), username=cfg['user'],
                           password=password, allow_agent=False, look_for_keys=False, timeout=4,
                           banner_timeout=10, auth_timeout=10)
            break
        except (TimeoutError, OSError, paramiko.ssh_exception.NoValidConnectionsError):
            if time.monotonic() >= deadline:
                raise
            time.sleep(2)
    try:
        transport = client.get_transport()
        transport.set_keepalive(20)
        if args.proxy:
            # Listen only on the board's loopback address, for this SSH session.
            transport.request_port_forward('127.0.0.1', 18080)

            def accept_proxy():
                while transport.is_active():
                    channel = transport.accept(1)
                    if channel:
                        threading.Thread(target=proxy_request, args=(channel,), daemon=True).start()

            threading.Thread(target=accept_proxy, daemon=True).start()
        if args.upload:
            sftp = client.open_sftp()
            source = ROOT / 'deployment/board'
            for path in sorted(source.rglob('*')):
                relative = path.relative_to(source).as_posix()
                remote = cfg['project_dir'] + '/' + relative
                parent = cfg['project_dir'] if '/' not in relative else remote.rsplit('/', 1)[0]
                # All upload paths come from the generated local bundle.
                current = ''
                for part in parent.split('/'):
                    if not part:
                        continue
                    current += '/' + part
                    try:
                        sftp.stat(current)
                    except FileNotFoundError:
                        sftp.mkdir(current)
                if path.is_dir():
                    try:
                        sftp.stat(remote)
                    except FileNotFoundError:
                        sftp.mkdir(remote)
                elif path.is_file():
                    sftp.put(str(path), remote)
                    print(f'Uploaded {relative} ({path.stat().st_size} bytes)', flush=True)
            sftp.close()
        if args.command_file or args.run:
            command = (args.command_file.read_text(encoding='utf-8-sig') if args.command_file else
                       'bash ' + shlex.quote(cfg['project_dir'] + '/scripts/run-board.sh') + ' ' + args.run)
            if args.proxy:
                command = ('export http_proxy=http://127.0.0.1:18080 '
                           'https_proxy=http://127.0.0.1:18080;\n' + command)
            remote_command = 'bash -lc ' + shlex.quote(command)
            if args.sudo:
                remote_command = "sudo -S -p '' " + remote_command
            stdin, stdout, stderr = client.exec_command(remote_command)
            stdout.channel.set_combine_stderr(True)
            if args.sudo:
                stdin.write(password + '\n')
                stdin.flush()
            stdin.channel.shutdown_write()
            args.log.parent.mkdir(parents=True, exist_ok=True)
            with args.log.open('w', encoding='utf-8') as log:
                for line in iter(stdout.readline, ''):
                    print(line, end='', flush=True)
                    log.write(line)
            status = stdout.channel.recv_exit_status()
            print(f'Remote exit code: {status}', flush=True)
            if status:
                raise SystemExit(status)
    finally:
        client.close()


if __name__ == '__main__':
    main()
