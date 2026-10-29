"""Download and verify the community Qwen3.5-9B RK3588 model pair."""
import argparse
import concurrent.futures
import hashlib
import json
from pathlib import Path
import shutil
import threading
import time
import urllib.request
import urllib.error

ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / 'downloads/qwen3.5-9b-rk3588'
REPO = 'Qengineering/Qwen3.5-9B-rk3588'
REVISION = '8e14580be5ac58feadd2f463efd4200963ec7b9e'
FILES = {
    'qwen3.5-9b_w8a8_rk3588.rkllm': {
        'bytes': 10083149164,
        'sha256': '4180199f3cef72a8fa30328475f4c83fcc88508fa167e0407d28321030508281',
    },
    'qwen3.5-9b_vision_rk3588.rknn': {
        'bytes': 955398641,
        'sha256': '6f16af0ba5bd86c951acb26b443480dcfc7ca50400d3100f1d0f576eace0d59f',
    },
}


def digest(path):
    result = hashlib.sha256()
    with path.open('rb') as stream:
        while chunk := stream.read(8 * 1024 * 1024):
            result.update(chunk)
    return result.hexdigest()


def fetch_model(name, spec, workers, mirror=False, *, destination=DEST, repository=REPO, revision=REVISION,
                source_url=None):
    target = destination / name
    if target.exists():
        if target.stat().st_size != spec['bytes'] or digest(target) != spec['sha256']:
            raise ValueError(f'Existing model failed verification: {name}')
        print(f'Already verified: {name}', flush=True)
        return
    # Parts survive interruptions. Reject a server that ignores Range requests.
    parts_dir = destination / (name + '.parts')
    parts_dir.mkdir(parents=True, exist_ok=True)
    block = 16 * 1024 * 1024
    count = (spec['bytes'] + block - 1) // block
    progress = {'done': 0, 'last': 0.0, 'retry_after': 0.0}
    lock = threading.Lock()
    endpoint = 'hf-mirror.com' if mirror else 'huggingface.co'
    url = source_url or f'https://{endpoint}/{repository}/resolve/{revision}/{name}'

    def part(index):
        start = index * block
        end = min(start + block, spec['bytes']) - 1
        size = end - start + 1
        path = parts_dir / f'{index:05d}'
        for attempt in range(6):
            with lock:
                cooldown = progress['retry_after'] - time.monotonic()
            if cooldown > 0:
                time.sleep(cooldown)
            offset = path.stat().st_size if path.exists() else 0
            if offset == size:
                break
            if offset > size:
                raise ValueError(f'Oversized part: {path}')
            try:
                request = urllib.request.Request(
                    url + f'?download=true&part={index}&offset={offset}',
                    headers={'Range': f'bytes={start + offset}-{end}'})
                # Optional transport mirror; the official HF revision, size and
                # SHA256 above remain the authority for accepting either file.
                opener = (urllib.request.build_opener(urllib.request.ProxyHandler({}))
                          if mirror else urllib.request.build_opener())
                with opener.open(request, timeout=60) as response:
                    expected = f'bytes {start + offset}-{end}/{spec["bytes"]}'
                    if response.status != 206 or response.headers.get('Content-Range') != expected:
                        raise ValueError('Unexpected range response')
                    with path.open('ab') as output:
                        while chunk := response.read(1024 * 1024):
                            output.write(chunk)
                if path.stat().st_size != size:
                    raise ValueError('Incomplete part')
                break
            except Exception as exc:
                if isinstance(exc, urllib.error.HTTPError) and exc.code == 429:
                    try:
                        delay = max(60, int(exc.headers.get('Retry-After', '60')))
                    except ValueError:
                        delay = 60
                    with lock:
                        progress['retry_after'] = max(progress['retry_after'], time.monotonic() + delay)
                print(f'{name} part {index} retry {attempt + 1}: {exc}', flush=True)
                if attempt == 5:
                    raise
                time.sleep(min(2 ** attempt, 10))
        with lock:
            progress['done'] += size
            if time.monotonic() - progress['last'] >= 10:
                print(f'{name}: {progress["done"] / spec["bytes"]:.1%} '
                      f'({progress["done"] / 1e9:.2f} GB)', flush=True)
                progress['last'] = time.monotonic()
        return path

    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        parts = list(pool.map(part, range(count)))
    partial = target.with_suffix(target.suffix + '.partial')
    with partial.open('wb') as output:
        for path in parts:
            with path.open('rb') as stream:
                shutil.copyfileobj(stream, output, 8 * 1024 * 1024)
    if partial.stat().st_size != spec['bytes'] or digest(partial) != spec['sha256']:
        raise ValueError(f'SHA256 mismatch: {name}')
    partial.replace(target)
    # Remove only the enumerated pieces after the assembled model is verified.
    for path in parts:
        path.unlink()
    parts_dir.rmdir()
    print(f'SHA256 verified: {name}', flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--workers', type=int, default=12, choices=range(1, 33))
    parser.add_argument('--vision-only', action='store_true')
    parser.add_argument('--mirror', action='store_true',
                        help='Use direct hf-mirror transport; retain official pinned SHA256 verification')
    args = parser.parse_args()
    DEST.mkdir(parents=True, exist_ok=True)
    names = list(FILES)
    if args.vision_only:
        names = [name for name in names if name.endswith('.rknn')]
    for name in names:
        fetch_model(name, FILES[name], args.workers, args.mirror)
    # Small metadata uses the official raw endpoint; mirror resolve-cache
    # redirects for text files are not consistently available.
    with urllib.request.urlopen(f'https://huggingface.co/{REPO}/raw/{REVISION}/README.md', timeout=60) as response:
        (DEST / 'MODEL-CARD.md').write_bytes(response.read())
    manifest = {'repository': REPO, 'revision': REVISION,
                'transport_endpoint': 'hf-mirror.com (direct)' if args.mirror else 'huggingface.co',
                'publisher': 'Qengineering community conversion; not Qwen/Rockchip official weights',
                'files': {name: spec for name, spec in FILES.items()
                          if (DEST / name).exists()}}
    (DEST / 'manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
    print('Models ready:', DEST, flush=True)


if __name__ == '__main__':
    main()
