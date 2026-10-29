"""Download the pinned Qwen3.5-4B W8A8/FP16 pair for RK3588."""
import argparse
import json
import urllib.request

from prepare_qwen35 import ROOT, fetch_model

DEST = ROOT / 'downloads/qwen3.5-4b-rk3588'
REPO = 'Qengineering/Qwen3.5-4B-rk3588'
REVISION = 'ee09c44b420e031dbe96fcb489ef30c5f3e0d1a5'
FILES = {
    'qwen3.5-4b_w8a8_rk3588.rkllm': {
        'bytes': 5578247044,
        'sha256': '31ebf6a003675c82c72a2893bf46136720a0ae052a40bb12814e1bf67314b8ca',
    },
    'qwen3.5-4b_vision_rk3588.rknn': {
        'bytes': 704579761,
        'sha256': '36648344b174e5681b26004f5b9d417fc38b30e119836645f683cd174fbada60',
    },
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--workers', type=int, default=8, choices=range(1, 33))
    parser.add_argument('--mirror', action='store_true')
    args = parser.parse_args()
    DEST.mkdir(parents=True, exist_ok=True)
    for name, spec in FILES.items():
        fetch_model(name, spec, args.workers, args.mirror,
                    destination=DEST, repository=REPO, revision=REVISION)
    with urllib.request.urlopen(f'https://huggingface.co/{REPO}/raw/{REVISION}/README.md', timeout=60) as response:
        (DEST / 'MODEL-CARD.md').write_bytes(response.read())
    manifest = {'repository': REPO, 'revision': REVISION,
                'transport_endpoint': 'hf-mirror.com (direct)' if args.mirror else 'huggingface.co',
                'publisher': 'Qengineering community conversion; not Qwen/Rockchip official weights',
                'quantization': {'language': 'W8A8', 'vision': 'FP16'}, 'files': FILES}
    (DEST / 'manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
    print('Models ready:', DEST, flush=True)


if __name__ == '__main__':
    main()
