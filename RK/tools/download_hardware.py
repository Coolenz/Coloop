"""Fetch official LubanCat-4/4-BTB schematics and retain source checksums."""
import concurrent.futures
import json
import re
import shutil
import urllib.parse
import zipfile
from datetime import datetime, timezone
from pathlib import Path

import download_materials as downloader

PAGE = ('https://doc.embedfire.com/lubancat-rk/hardware/'
        'ebf_lubancat_rk_hardware/zh/latest/board/ebf_lubancat_rk.html')
ROOT = Path(__file__).resolve().parents[1] / 'downloads' / 'hardware'


def extract_archive(path, folder):
    folder.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path) as archive:
        bad = archive.testzip()
        if bad:
            raise RuntimeError(f'ZIP CRC check failed: {bad}')
        for entry in archive.infolist():
            name = entry.filename
            if not entry.flag_bits & 0x800:
                try:
                    name = name.encode('cp437').decode('gbk')
                except (UnicodeError, LookupError):
                    pass
            target = (folder / name.replace('\\', '/')).resolve()
            if not target.is_relative_to(folder.resolve()):
                raise RuntimeError(f'Unsafe archive path: {name}')
            if (entry.external_attr >> 16) & 0o170000 == 0o120000:
                raise RuntimeError(f'Archive symlink rejected: {name}')
            if entry.is_dir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(entry) as src, target.open('wb') as dst:
                    shutil.copyfileobj(src, dst)


def main():
    ROOT.mkdir(parents=True, exist_ok=True)
    html = downloader.get(PAGE).decode('utf-8')
    items = []
    for link, label in re.findall(r'<a\b[^>]*href="([^"]+)"[^>]*>(.*?)</a>', html, re.S):
        name = re.sub('<[^>]+>', '', label).strip()
        if ('鲁班猫4' in name or 'LubanCat4_' in name) and name.endswith(('.pdf', '.zip')):
            board = 'LubanCat4-BTB' if '4BTB' in name or '4_BTB' in name else 'LubanCat4'
            items.append({'path': f'{board}/{name}',
                          'url': downloader.url_ascii(urllib.parse.urljoin(PAGE, link))})
    if len(items) != 5:
        raise RuntimeError(f'Official file list changed ({len(items)} files); review before download')
    downloader.ROOT = ROOT
    with concurrent.futures.ThreadPoolExecutor(max_workers=5) as pool:
        files = list(pool.map(downloader.download, items))
    report = {'source_page': PAGE, 'downloaded_at_utc': datetime.now(timezone.utc).isoformat(),
              'files': files}
    (ROOT / 'manifest.json').write_text(json.dumps(report, ensure_ascii=False, indent=2),
                                       encoding='utf-8')
    for item in files:
        print(item['status'], item['path'], flush=True)
        if item['status'] != 'downloaded':
            raise RuntimeError(item['error'])
        path = ROOT / item['path']
        if path.suffix == '.zip':
            extract_archive(path, path.parent / 'extracted' / path.stem)
    print(f'PASS: {len(files)} files downloaded; ZIP CRC checks and extraction completed.')
    for path in ROOT.rglob('*.pdf'):
        print(path.relative_to(ROOT).as_posix())


if __name__ == '__main__':
    main()
