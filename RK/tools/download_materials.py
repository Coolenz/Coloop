"""Download official manuals and selected learning examples, without executing them."""
import concurrent.futures
import hashlib
import json
import re
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / 'downloads'
HEADERS = {'User-Agent': 'LubanCat-Learning-Materials/1.0'}


def url_ascii(url):
    return urllib.parse.quote(url, safe=':/?=&%+#')


def get(url):
    with urllib.request.urlopen(urllib.request.Request(url_ascii(url), headers=HEADERS),
                                timeout=40) as response:
        return response.read()


def tree(repo, ref):
    data = json.loads(get(f'https://api.github.com/repos/{repo}/git/trees/{ref}?recursive=1'))
    if data.get('truncated'):
        raise RuntimeError(f'Truncated tree: {repo}')
    return data['sha'], [x for x in data['tree'] if x['type'] == 'blob']


def plan():
    items = []
    repositories = []

    def add(path, url, size=None, git_sha=None):
        items.append({'path': path, 'url': url_ascii(url), 'expected_bytes': size,
                      'git_blob_sha': git_sha})

    # The official PDF directory uses a meta-refresh rather than a file listing.
    for name, directory in [
        ('Embedfire-RK3588-Quick-Start-CN.pdf',
         'https://doc.embedfire.com/linux/rk3588/quick_start/pdf/'),
        ('Embedfire-Edge-AI-Guide-CN.pdf',
         'https://doc.embedfire.com/linux/rk356x/Ai/pdf/'),
    ]:
        html = get(directory).decode('utf-8')
        match = re.search(r'url=([^"<>]+\.pdf)', html, re.I)
        if not match:
            raise RuntimeError(f'No official PDF redirect: {directory}')
        add(f'manuals/{name}', urllib.parse.urljoin(directory, match.group(1)))

    sdk_repo = 'airockchip/rknn-toolkit2'
    sdk_sha, sdk_files = tree(sdk_repo, 'v2.3.2')
    repositories.append({'repo': sdk_repo, 'ref': 'v2.3.2', 'commit': sdk_sha})
    for f in sdk_files:
        path = f['path']
        selected_doc = path.startswith('doc/') and (
            (path.endswith('_CN.pdf') and ('RKNPU' in path))
            or 'Support_Operator_List' in path or path.endswith('.md'))
        example = path.startswith('rknn-toolkit-lite2/examples/resnet18/') and (
            not path.endswith('.rknn') or 'rk3588' in path)
        if selected_doc or example or path in ('README.md', 'LICENSE'):
            folder = 'manuals/rknn-2.3.2' if selected_doc else 'examples/rknn-toolkit2-2.3.2'
            add(f'{folder}/{path}',
                f'https://raw.githubusercontent.com/{sdk_repo}/{sdk_sha}/{path}',
                f['size'], f['sha'])

    # Source snapshots omit wheels, shared libraries, training datasets and large weights.
    source_suffixes = {'.py', '.c', '.cc', '.cpp', '.h', '.hpp', '.cmake', '.sh', '.md',
                       '.txt', '.json', '.yaml', '.yml', '.ipynb', '.jpg', '.jpeg', '.png'}
    for repo, ref, folder in [
        ('LubanCat/lubancat_ai_manual_code', '30b276ea0a7bed623daeb4e9a673851f019085a7',
         'lubancat-ai-source'),
        ('airockchip/rknn_model_zoo', 'v2.3.2', 'rknn-model-zoo-2.3.2'),
    ]:
        sha, files = tree(repo, ref)
        repositories.append({'repo': repo, 'ref': ref, 'commit': sha})
        for f in files:
            path = f['path']
            if repo.startswith('LubanCat'):
                scope = (path.startswith(('base/', 'example/'))
                         or path in ('README.md', 'LICENSE', 'dev_env/README.md'))
            else:
                scope = (path.startswith(('examples/resnet/', 'examples/yolov8/', 'utils/'))
                         or '/' not in path)
            if scope and (Path(path).suffix.lower() in source_suffixes
                          or Path(path).name in ('LICENSE', 'CMakeLists.txt')) and f['size'] < 3_000_000:
                add(f'examples/{folder}/{path}',
                    f'https://raw.githubusercontent.com/{repo}/{sha}/{path}',
                    f['size'], f['sha'])
    return {'repositories': repositories, 'files': items}


def download(item):
    target = ROOT / item['path']
    target.parent.mkdir(parents=True, exist_ok=True)
    partial = target.with_name(target.name + '.part')
    for attempt in range(3):
        try:
            if not target.exists():
                with urllib.request.urlopen(urllib.request.Request(item['url'], headers=HEADERS),
                                            timeout=40) as response, partial.open('wb') as out:
                    content_length = response.headers.get('Content-Length')
                    count = 0
                    while chunk := response.read(1024 * 256):
                        out.write(chunk)
                        count += len(chunk)
                        if count > 250_000_000:
                            raise RuntimeError('Unexpected file size >250 MB')
                    if content_length and count != int(content_length):
                        raise RuntimeError('Incomplete HTTP body')
                # Validate before promoting a partial file to a completed download.
                candidate = partial
            else:
                candidate = target
            content = candidate.read_bytes()
            if item.get('expected_bytes') is not None and len(content) != item['expected_bytes']:
                raise RuntimeError('Size differs from official Git tree')
            if target.suffix.lower() == '.pdf' and not content.startswith(b'%PDF-'):
                raise RuntimeError('Response is not a PDF')
            if content.startswith(b'version https://git-lfs.github.com/spec/'):
                raise RuntimeError('Git LFS pointer received instead of actual file')
            if item.get('git_blob_sha'):
                blob = b'blob ' + str(len(content)).encode() + b'\0' + content
                if hashlib.sha1(blob).hexdigest() != item['git_blob_sha']:
                    raise RuntimeError('Git blob checksum mismatch')
            if candidate == partial:
                partial.replace(target)
            return {**item, 'status': 'downloaded', 'bytes': len(content),
                    'sha256': hashlib.sha256(content).hexdigest()}
        except Exception as exc:
            if attempt == 2:
                return {**item, 'status': 'failed', 'error': str(exc)}
            time.sleep(1 + attempt)


def main():
    ROOT.mkdir(exist_ok=True)
    plan_path = ROOT / 'download-plan.json'
    if plan_path.exists():
        data = json.loads(plan_path.read_text(encoding='utf-8'))
    else:
        data = plan()
        plan_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')
    manifest = {'downloaded_at_utc': datetime.now(timezone.utc).isoformat(),
                'repositories': data['repositories'], 'files': []}
    print(f'Downloading {len(data["files"])} official files...', flush=True)
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        tasks = [pool.submit(download, f) for f in data['files']]
        for task in concurrent.futures.as_completed(tasks):
            result = task.result()
            manifest['files'].append(result)
            (ROOT / 'manifest.json').write_text(
                json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
            count = len(manifest['files'])
            if result['status'] == 'failed' or count % 25 == 0 or result['path'].endswith('.pdf'):
                print(f'[{count}/{len(tasks)}] {result["status"]}: {result["path"]}', flush=True)
    ok = [x for x in manifest['files'] if x['status'] == 'downloaded']
    failed = [x for x in manifest['files'] if x['status'] == 'failed']
    lines = [
        '# 下载结果', '',
        f'- 成功：{len(ok)} / {len(tasks)} 个文件',
        f'- 大小：{sum(x["bytes"] for x in ok)/1024**2:.1f} MiB（不含清单文件）',
        f'- PDF：{sum(x["path"].endswith(".pdf") for x in ok)} 份',
        f'- 失败：{len(failed)} 个', '',
        '逐文件来源及 SHA256 见 manifest.json，仓库版本见 download-plan.json。',
        '源码按学习用途选取，非全量 SDK；完整范围说明见 README.md。',
    ]
    if failed:
        lines += ['', '未成功的文件：', '']
        lines += [f'- {x["path"]}: {x["error"]}' for x in failed]
    (ROOT / 'DOWNLOAD-SUMMARY.md').write_text('\n'.join(lines) + '\n', encoding='utf-8')
    print(f'Completed: {len(ok)}/{len(tasks)}, {sum(x["bytes"] for x in ok)/1024**2:.1f} MiB',
          flush=True)
    if failed:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
