"""Fixed stdin/stdout relay to the private vault. No commands or payloads in argv."""

import os
import select
import socket
import sys


def main():
    with socket.socket(socket.AF_UNIX) as channel:
        channel.settimeout(3)
        channel.connect("/run/rk-credential-vault/service.sock")
        channel.setblocking(False)
        inputs = [channel, sys.stdin.buffer]
        while True:
            ready, _, _ = select.select(inputs, [], [], 15)
            if not ready:
                return
            if sys.stdin.buffer in ready:
                data = os.read(sys.stdin.fileno(), 16385)
                if not data:
                    channel.shutdown(socket.SHUT_WR)
                    inputs.remove(sys.stdin.buffer)
                else:
                    channel.sendall(data)
            if channel in ready:
                data = channel.recv(16385)
                if not data:
                    return
                sys.stdout.buffer.write(data)
                sys.stdout.buffer.flush()


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print('{"ok":false,"error":"VAULT_UNAVAILABLE"}')
        sys.exit(1)
