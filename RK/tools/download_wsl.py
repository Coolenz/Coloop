"""Download the official WSL image with ranges and verify Microsoft's hash."""
import concurrent.futures
import hashlib
import html
import json
from pathlib import Path
import re
import sys
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]


def main():
    if '--torch' in sys.argv:
        manifest_url = 'https://download.pytorch.org/whl/cpu/torch/'
        with urllib.request.urlopen(manifest_url, timeout=30) as response:
            page = response.read().decode()
        links = re.findall(r'href="([^"]+)"', page)
        link = next(html.unescape(s) for s in links
                    if 'torch-2.4.0%2Bcpu-cp310-cp310-linux_x86_64.whl#sha256=' in s)
        url, digest = link.split('#sha256=')
        entry = {'Url': url, 'Sha256': digest}
        target = ROOT / 'downloads/wheels/linux-x86_64-cp310/torch-2.4.0+cpu-cp310-cp310-linux_x86_64.whl'
    else:
        manifest_url = 'https://raw.githubusercontent.com/microsoft/WSL/master/distributions/DistributionInfo.json'
        with urllib.request.urlopen(manifest_url, timeout=30) as response:
            manifest = json.load(response)
        entry = next(e for e in manifest['ModernDistributions']['Ubuntu']
                     if e['Name'] == 'Ubuntu-22.04')['Amd64Url']
        target = ROOT / 'downloads/wsl/ubuntu-22.04.5-wsl-amd64.wsl'
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists() and hashlib.file_digest(target.open('rb'), 'sha256').hexdigest() == entry['Sha256']:
        print('Official file already verified:', target.name, flush=True)
        return
    request = urllib.request.Request(entry['Url'], headers={'Range': 'bytes=0-0'})
    with urllib.request.urlopen(request, timeout=60) as response:
        if response.status != 206:
            raise RuntimeError('Server does not support ranged downloading')
        total = int(response.headers['Content-Range'].split('/')[-1])
    chunk = 4 * 1024 * 1024
    parts = target.parent / (target.name + '.' + entry['Sha256'][:12] + '.parts')
    parts.mkdir(exist_ok=True)

    def fetch(start):
        end = min(start + chunk, total) - 1
        path = parts / f'{start:012d}'
        if path.exists() and path.stat().st_size == end - start + 1:
            return path
        for attempt in range(3):
            try:
                req = urllib.request.Request(entry['Url'], headers={'Range': f'bytes={start}-{end}'})
                with urllib.request.urlopen(req, timeout=90) as response:
                    if response.status != 206 or response.headers.get('Content-Range') != f'bytes {start}-{end}/{total}':
                        raise RuntimeError('Unexpected Content-Range')
                    data = response.read()
                if len(data) != end - start + 1:
                    raise RuntimeError('Incomplete download chunk')
                path.write_bytes(data)
                return path
            except Exception:
                if attempt == 2:
                    raise
                time.sleep(2)

    completed = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        jobs = [pool.submit(fetch, start) for start in range(0, total, chunk)]
        for job in concurrent.futures.as_completed(jobs):
            result = job.result()
            completed += result.stat().st_size
            print(f'{target.name}: {completed * 100 // total}%', flush=True)
    combined = target.with_suffix('.verified.part')
    digest = hashlib.sha256()
    with combined.open('wb') as output:
        for start in range(0, total, chunk):
            data = (parts / f'{start:012d}').read_bytes()
            output.write(data)
            digest.update(data)
    if digest.hexdigest() != entry['Sha256']:
        raise RuntimeError('Official manifest SHA256 mismatch')
    combined.replace(target)
    (target.parent / 'source.json').write_text(json.dumps(
        {'manifest_url': manifest_url, **entry, 'bytes': total}, indent=2), encoding='utf-8')
    print('SHA256 verified. File ready:', target, flush=True)


if __name__ == '__main__':
    main()
