"""Fetch the pinned official SDK subset and prepare a board deployment folder."""
import concurrent.futures
import hashlib
import json
from pathlib import Path
import shutil
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
COMMIT = '42aa1d426c0a9e0869b6374edba009f7208a1926'
PREFIX = f'https://raw.githubusercontent.com/airockchip/rknn-toolkit2/{COMMIT}/'
SDK = ROOT / 'downloads/sdk/rknn-2.3.2'
BUNDLE = ROOT / 'deployment/board'
FILES = [
    'LICENSE',
    'rknn-toolkit2/packages/x86_64/requirements_cp310-2.3.2.txt',
    'rknn-toolkit2/packages/x86_64/rknn_toolkit2-2.3.2-cp310-cp310-manylinux_2_17_x86_64.manylinux2014_x86_64.whl',
    'rknn-toolkit-lite2/packages/rknn_toolkit_lite2-2.3.2-cp310-cp310-manylinux_2_17_aarch64.manylinux2014_aarch64.whl',
    'rknpu2/runtime/Linux/librknn_api/aarch64/librknnrt.so',
    'rknpu2/runtime/Linux/librknn_api/include/rknn_api.h',
    'rknpu2/runtime/Linux/librknn_api/include/rknn_custom_op.h',
    'rknpu2/runtime/Linux/librknn_api/include/rknn_matmul_api.h',
]


def fetch(item):
    path, entry = item
    destination = SDK / path
    destination.parent.mkdir(parents=True, exist_ok=True)
    data = destination.read_bytes() if destination.exists() else b''

    def valid(content):
        blob = b'blob ' + str(len(content)).encode() + b'\0' + content
        return len(content) == entry['size'] and hashlib.sha1(blob).hexdigest() == entry['sha']

    if not valid(data):
        with urllib.request.urlopen(PREFIX + path, timeout=120) as response:
            data = response.read()
        if not valid(data):
            raise RuntimeError(f'Upstream Git blob mismatch: {path}')
        temporary = destination.with_suffix(destination.suffix + '.part')
        temporary.write_bytes(data)
        temporary.replace(destination)
    print(f'OK {path} ({len(data)} bytes)', flush=True)
    return {'path': path, 'url': PREFIX + path, 'bytes': len(data),
            'git_blob_sha1': entry['sha'], 'sha256': hashlib.sha256(data).hexdigest()}


def main():
    request = urllib.request.Request(
        f'https://api.github.com/repos/airockchip/rknn-toolkit2/git/trees/{COMMIT}?recursive=1',
        headers={'User-Agent': 'LubanCat4-workspace'})
    with urllib.request.urlopen(request, timeout=45) as response:
        tree = json.load(response)
    entries = {e['path']: e for e in tree['tree']}
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        manifest = list(pool.map(fetch, [(p, entries[p]) for p in FILES]))
    (SDK / 'manifest.json').write_text(json.dumps(
        {'version': '2.3.2', 'commit': COMMIT, 'files': manifest}, indent=2), encoding='utf-8')
    for directory in ['scripts', 'tools', 'models', 'wheels', 'vendor/lib', 'vendor/include', 'logs']:
        (BUNDLE / directory).mkdir(parents=True, exist_ok=True)
    for name in ['setup-board.sh', 'run-board.sh']:
        shutil.copy2(ROOT / 'scripts' / name, BUNDLE / 'scripts' / name)
    for name in ['doctor.py', 'smoke_board.py']:
        shutil.copy2(ROOT / 'tools' / name, BUNDLE / 'tools' / name)
    shutil.copy2(ROOT / 'requirements-board.txt', BUNDLE / 'requirements-board.txt')
    shutil.copy2(SDK / 'LICENSE', BUNDLE / 'vendor/LICENSE-rknn.txt')
    shutil.copy2(SDK / FILES[4], BUNDLE / 'vendor/lib/librknnrt.so')
    for path in FILES[5:]:
        shutil.copy2(SDK / path, BUNDLE / 'vendor/include' / Path(path).name)
    shutil.copy2(SDK / FILES[3], BUNDLE / 'wheels' / Path(FILES[3]).name)
    example = ROOT / 'downloads/examples/rknn-toolkit2-2.3.2/rknn-toolkit-lite2/examples/resnet18'
    shutil.copytree(example, BUNDLE / 'official-resnet18', dirs_exist_ok=True)
    if (ROOT / 'models/smoke.rknn').is_file():
        shutil.copy2(ROOT / 'models/smoke.rknn', BUNDLE / 'models/smoke.rknn')
    print(f'Board bundle prepared: {BUNDLE}', flush=True)


if __name__ == '__main__':
    main()
