"""Fetch the existing DeepSeek model and the pinned official RKLLM 1.3.1 SDK."""
import concurrent.futures
import hashlib
import json
from pathlib import Path
import shutil
import threading
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / 'downloads/deepseek-rkllm-1.1.4'
SDK_COMMIT = 'f7390530443bf84f0394255a449d7cbe81e69d1c'
SDK_DEST = ROOT / 'downloads/rkllm-1.3.1'
SDK_FILES = {
    'LICENSE': '8d670a646eb8cf28fb7c63a5c9126c224a3a3f8124b00a3b9184df9a2ed298b8',
    'README.md': 'b1f258d927ad3a0ea7033f96865abbc1371127b0176d8e77636d22602f51e0d8',
    'rkllm-runtime/Linux/librkllm_api/aarch64/librkllmrt.so': 'f25e9b099db08aaacd0a3ac62b4697d3951d6ae61ae41ea09f6702cfa89eb32c',
    'rkllm-runtime/Linux/librkllm_api/include/rkllm.h': '4ad19442de58df1b7d1ed0884ed75b8d4b5107cc4e75b7e44900b1f95a32c57c',
    'examples/rkllm_api_demo/deploy/src/llm_demo.cpp': '6dd944c8b823521532b2d26e1ff536bda46d0dc0d2b05a63a6c4c3f97451db2c',
}
MODEL_REPO = 'VRxiaojie/DeepSeek-R1-Distill-Qwen-1.5B-RK3588S-RKLLM1.1.4'
MODEL_REV = 'bb9ef8749ad138cedb3ed09e9ba72bd177cf0a15'
MODEL_FILE = 'deepseek-r1-1.5B-rkllm1.1.4.rkllm'
MODEL_SIZE = 2035400060
MODEL_SHA = '85f87f2e1bf0c70f1e9f4058bc0c6659b7db5728f00bd806e343a93e0a7dd66e'


def fetch(url):
    with urllib.request.urlopen(url, timeout=60) as response:
        return response.read()


def sdk_files():
    def download(entry):
        relative, expected_sha = entry
        path = SDK_DEST / relative
        url = f"https://raw.githubusercontent.com/airockchip/rknn-llm/{SDK_COMMIT}/{relative}"
        data = path.read_bytes() if path.exists() else fetch(url)
        sha = hashlib.sha256(data).hexdigest()
        if sha != expected_sha:
            raise ValueError(f"SDK SHA256 check failed: {relative}")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        print(f"SDK verified: {relative}", flush=True)
        return {'path': relative, 'url': url, 'sha256': sha}

    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        return list(pool.map(download, SDK_FILES.items()))


def model_file():
    path = DEST / MODEL_FILE
    partial = path.with_suffix('.rkllm.partial')
    url = f'https://huggingface.co/{MODEL_REPO}/resolve/{MODEL_REV}/{MODEL_FILE}'
    if not path.exists():
        parts_dir = DEST / 'parts'
        parts_dir.mkdir(exist_ok=True)
        part_size = 16 * 1024 * 1024
        count = (MODEL_SIZE + part_size - 1) // part_size
        progress = {'done': 0, 'last': time.monotonic()}
        lock = threading.Lock()

        def part(index):
            start = index * part_size
            end = min(start + part_size, MODEL_SIZE) - 1
            expected = end - start + 1
            output_path = parts_dir / f'{index:04d}'
            for attempt in range(5):
                offset = output_path.stat().st_size if output_path.exists() else 0
                if offset == expected:
                    break
                try:
                    headers = {'Range': f'bytes={start + offset}-{end}'}
                    request = urllib.request.Request(url + f'?download=true&part={index}&offset={offset}', headers=headers)
                    with urllib.request.urlopen(request, timeout=45) as response:
                        content_range = f'bytes {start + offset}-{end}/{MODEL_SIZE}'
                        if response.status != 206 or response.headers.get('Content-Range') != content_range:
                            raise ValueError('Incorrect HTTP range response')
                        with output_path.open('ab') as output:
                            while chunk := response.read(1024 * 1024):
                                output.write(chunk)
                    if output_path.stat().st_size != expected:
                        raise ValueError('Incomplete part')
                    break
                except Exception as exc:
                    print(f'Part {index}, retry {attempt + 1}: {exc}', flush=True)
                    if attempt == 4:
                        raise
            with lock:
                progress['done'] += expected
                if time.monotonic() - progress['last'] > 10:
                    print(f"Model download: {progress['done'] / MODEL_SIZE:.1%} ({progress['done'] / 1e6:.0f} MB)", flush=True)
                    progress['last'] = time.monotonic()
            return output_path

        with concurrent.futures.ThreadPoolExecutor(max_workers=48) as pool:
            parts = list(pool.map(part, range(count)))
        with partial.open('wb') as output:
            for part_path in parts:
                with part_path.open('rb') as stream:
                    shutil.copyfileobj(stream, output, 8 * 1024 * 1024)
        source = partial
    else:
        source = path
    digest = hashlib.sha256()
    with source.open('rb') as stream:
        while chunk := stream.read(8 * 1024 * 1024):
            digest.update(chunk)
    if source.stat().st_size != MODEL_SIZE or digest.hexdigest() != MODEL_SHA:
        raise ValueError('Model SHA256/size check failed')
    if source == partial:
        partial.replace(path)
    print('Model SHA256 verified.', flush=True)
    return {'url': url, 'repository': MODEL_REPO, 'revision': MODEL_REV,
            'file': MODEL_FILE, 'bytes': MODEL_SIZE, 'sha256': MODEL_SHA,
            'publisher': 'Community conversion by VRxiaojie; not an Embedfire/Rockchip release'}


def main():
    DEST.mkdir(parents=True, exist_ok=True)
    card_url = f'https://huggingface.co/{MODEL_REPO}/raw/{MODEL_REV}/README.md'
    (DEST / 'MODEL-CARD.md').write_bytes(fetch(card_url))
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        sdk = pool.submit(sdk_files)
        model = pool.submit(model_file)
        manifest = {'sdk_commit': SDK_COMMIT, 'sdk_version': '1.3.1',
                    'sdk_files': sdk.result(), 'model': model.result()}
    (DEST / 'manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
    print('Ready:', DEST, flush=True)


if __name__ == '__main__':
    main()
