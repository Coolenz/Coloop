"""Start the existing RK service, recovering only an identified idle dead worker."""
import contextlib
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import urllib.error
import urllib.request


def bridge_identity(root, proc=Path('/proc')):
    pidfile = root / '.runtime/bridge.pid'
    if not pidfile.exists():
        return None
    pid = int(pidfile.read_text().strip())
    if pid <= 1:
        raise RuntimeError('Invalid bridge process id')
    directory = proc / str(pid)
    if not directory.exists():
        return None
    args = (directory / 'cmdline').read_bytes().split(b'\0')
    allowed = {b'bridge/server.py', os.fsencode(str(root / 'bridge/server.py'))}
    if Path(os.readlink(directory / 'cwd')).resolve() != root or not allowed.intersection(args):
        raise RuntimeError('Saved process id belongs to another application')
    # Start time prevents a recycled PID from passing the final ownership check.
    start = (directory / 'stat').read_text().rsplit(')', 1)[1].split()[19]
    return pid, start


def model_health(root, port):
    key = (root / '.runtime/api-key').read_text().strip()
    request = urllib.request.Request(
        f'http://127.0.0.1:{port}/health', headers={'Authorization': 'Bearer ' + key})
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            return response.status, json.loads(response.read(8192))
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read(8192))


@contextlib.contextmanager
def exclusive_lock(path):
    import fcntl
    with open(path, 'a') as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError('RK model or recovery is busy; retry after its current task')
        try:
            yield
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)


def start_model(directory, port):
    root = Path(directory).expanduser().resolve()
    if port != 8088:
        raise RuntimeError('Existing start script requires port 8088')
    required = ['scripts/start.sh', 'scripts/stop-model.sh', 'build/rkllm-worker-qwen35-4b',
                '.runtime/api-key', '.runtime/worker-protocol-qwen35-4b', 'model_profiles.py']
    if any(not (root / name).is_file() for name in required):
        raise RuntimeError('RK service installation incomplete; deploy from RK project first')
    sys.path.insert(0, str(root))
    from model_profiles import load_profile, WORKER_PROTOCOL
    profile = load_profile('qwen35-4b')
    if (WORKER_PROTOCOL not in (2, 3) or profile['model_id'] != 'qwen35-4b-rkllm'
            or profile['prompt_format'] != 'embedded'
            # Older deployments retain marker 2 after a verified protocol-3 build.
            # The authenticated health reply below must match the running protocol.
            or (root / '.runtime/worker-protocol-qwen35-4b').read_text().strip() not in ('2', '3')):
        raise RuntimeError('RK model profile is not supported')
    env = {**os.environ, 'RK_AGENT_PROFILE': 'qwen35-4b', 'RKLLM_CONTEXT': '16384'}
    with exclusive_lock(root / '.runtime/coloop-model-recovery.lock'):
        identity = bridge_identity(root)
        # A live inference, including another client or memory maintenance, owns this lock.
        with exclusive_lock(profile['lock']):
            if identity is not None:
                status, health = model_health(root, port)
                if (status != 503 or health.get('ready') is not False
                        or health.get('model') != profile['model_id']
                        or health.get('worker_protocol') != WORKER_PROTOCOL
                        or (WORKER_PROTOCOL == 3 and (
                            health.get('profile') != 'qwen35-4b'
                            or health.get('profile_fingerprint') != profile['fingerprint']
                            or health.get('privacy_metadata_only') is not True))):
                    raise RuntimeError('Existing bridge process is not a verified dead worker')
                if bridge_identity(root) != identity:
                    raise RuntimeError('Bridge ownership changed during recovery')
                # The existing launcher uses SIGTERM/service stop, never a broad kill.
                subprocess.run(['bash', 'scripts/stop-model.sh'], cwd=root, env=env,
                               check=True, capture_output=True, timeout=30)
                if bridge_identity(root) is not None:
                    raise RuntimeError('Old bridge has not exited')
            else:
                with socket.socket() as connection:
                    connection.settimeout(1)
                    if connection.connect_ex(('127.0.0.1', port)) == 0:
                        raise RuntimeError('Service port already in use')
        # Release the model lock before its worker acquires it; recovery stays serialized.
        subprocess.run(['bash', 'scripts/start.sh'], cwd=root, env=env,
                       check=True, capture_output=True, timeout=95)
    print(json.dumps({'started': True, 'recoveredDeadWorker': identity is not None}))
