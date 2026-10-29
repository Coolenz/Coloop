"""Prepare and validate a LubanCat-4 image locally; never accesses USB devices."""
import hashlib
import json
import lzma
import struct
import subprocess
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DOWNLOADS = ROOT / 'downloads' / 'Ubuntu22.04'
SOURCE = DOWNLOADS / '20260702/server/2026-07-02-ubuntu-22.04-server-arm64-lubancat-4.img.xz'
ARCHIVE = DOWNLOADS / '刷机工具/RKDevTool_v3.37_for_window.7z'
DEST = ROOT / 'flash'


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        while chunk := stream.read(8 * 1024 * 1024):
            h.update(chunk)
    return h.hexdigest()


def inspect_gpt(path):
    with path.open('rb') as stream:
        mbr = stream.read(512)
        if mbr[510:512] != b'\x55\xaa':
            raise RuntimeError('Missing MBR signature')
        header = stream.read(512)
        if header[:8] != b'EFI PART':
            raise RuntimeError('This procedure expects a raw GPT disk image')
        size = struct.unpack_from('<I', header, 12)[0]
        if not 92 <= size <= 512:
            raise RuntimeError('Invalid GPT header size')
        expected_crc = struct.unpack_from('<I', header, 16)[0]
        checked = bytearray(header[:size])
        checked[16:20] = b'\0' * 4
        if zlib.crc32(checked) != expected_crc:
            raise RuntimeError('GPT header checksum mismatch')
        entries_lba, count, entry_size, expected_entries_crc = struct.unpack_from('<QIII', header, 72)
        if count * entry_size > 16 * 1024 * 1024 or entry_size < 128:
            raise RuntimeError('Unexpected GPT partition array')
        stream.seek(entries_lba * 512)
        entries = stream.read(count * entry_size)
        if zlib.crc32(entries) != expected_entries_crc:
            raise RuntimeError('GPT partition array checksum mismatch')
        partitions = []
        for i in range(count):
            entry = entries[i * entry_size:(i + 1) * entry_size]
            if entry[:16] == b'\0' * 16:
                continue
            first, last = struct.unpack_from('<QQ', entry, 32)
            if last < first or (last + 1) * 512 > path.stat().st_size:
                raise RuntimeError('Partition exceeds image length')
            partitions.append({'name': entry[56:128].decode('utf-16-le').rstrip('\0'),
                               'first_lba': first, 'last_lba': last,
                               'bytes': (last - first + 1) * 512})
        return partitions


def main():
    DEST.mkdir(exist_ok=True)
    tools = DEST / 'tools'
    tools.mkdir(exist_ok=True)
    listing = subprocess.run(['tar', '-tf', str(ARCHIVE)], check=True, capture_output=True)
    for name in listing.stdout.decode('utf-8', 'replace').splitlines():
        normalized = name.replace('\\', '/')
        if normalized.startswith('/') or '..' in normalized.split('/') or ':' in normalized:
            raise RuntimeError('Unsafe archive member')
    subprocess.run(['tar', '-xf', str(ARCHIVE), '-C', str(tools)], check=True)
    tool = tools / 'RKDevTool_v3.37_for_window' / 'RKDevTool.exe'
    loader = tool.parent / 'rk3588_spl_loader_v1.17.113.bin'
    if not tool.is_file() or not loader.is_file():
        raise RuntimeError('Expected vendor tool or loader missing')
    image = DEST / 'ubuntu22.04-server-lubancat4.img'
    partial = DEST / 'ubuntu22.04-server-lubancat4.img.part'
    if not image.exists():
        total = 0
        with lzma.open(SOURCE, 'rb') as compressed, partial.open('wb') as out:
            while chunk := compressed.read(8 * 1024 * 1024):
                out.write(chunk)
                total += len(chunk)
                if total % (512 * 1024 * 1024) == 0:
                    print(f'Extracted {total / 1024**3:.1f} GiB', flush=True)
        partial.replace(image)
    partitions = inspect_gpt(image)
    plan = {
        'prepared_date': '2026-10-27', 'target_board': 'LubanCat-4 (user reported)',
        'target_storage': 'eMMC (not yet confirmed)', 'device_written': False,
        'source_image': str(SOURCE), 'compressed_bytes': SOURCE.stat().st_size,
        'compressed_sha256': digest(SOURCE),
        'image': str(image), 'image_bytes': image.stat().st_size, 'image_sha256': digest(image),
        'integrity': 'XZ decoded without checksum errors; GPT header and entries CRC valid',
        'vendor_published_checksum': None,
        'partitions': partitions, 'tool': str(tool), 'tool_archive_sha256': digest(ARCHIVE),
        'loader': str(loader), 'loader_sha256': digest(loader),
        'instruction_source': str(next(DOWNLOADS.glob('2---*.txt'))),
        'pending': ['Confirm MASKROM in RKDevTool', 'Read/confirm eMMC and capacity',
                    'Confirm exact board and disposition of existing data before writing'],
    }
    (DEST / 'flash-plan.json').write_text(json.dumps(plan, ensure_ascii=False, indent=2),
                                          encoding='utf-8')
    print(json.dumps(plan, ensure_ascii=False, indent=2), flush=True)


if __name__ == '__main__':
    main()
