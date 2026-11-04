"""Download the pinned Qwen3.5-0.8B W8A8/FP16 pair for RK3588."""
import argparse
import json
import urllib.request

from prepare_qwen35 import ROOT, fetch_model

DEST = ROOT / 'downloads/qwen3.5-0.8b-rk3588'
REPO = 'Qengineering/Qwen3.5-0.8B-rk3588'
REVISION = '3f6ecb50c6e3c5e17f6a2c1ac0fd8bceaddf7d2a'
FILES = {
    'qwen3.5-0.8b_w8a8_rk3588.rkllm': {
        'bytes': 1337292780,
        'sha256': 'ba85edac97e8f4ed2cdf0d94a3744b5609385b4706c45677f55cdaeb465ce054',
    },
    'qwen3.5-0.8b_vision_rk3588.rknn': {
        'bytes': 218787569,
        'sha256': 'e96a3f016163e7cf7ae516ed9878ccad7c576c658d71a60333f5cb154680fd81',
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
    card_url = f'https://huggingface.co/{REPO}/raw/{REVISION}/README.md'
    with urllib.request.urlopen(card_url, timeout=60) as response:
        (DEST / 'MODEL-CARD.md').write_bytes(response.read())
    manifest = {
        'repository': REPO,
        'revision': REVISION,
        'transport_endpoint': 'hf-mirror.com (direct)' if args.mirror else 'huggingface.co',
        'publisher': 'Qengineering community conversion',
        'target_platform': 'rk3588',
        'quantization': {'language': 'W8A8', 'vision': 'FP16'},
        'runtime_requirement_from_model_card': 'RKLLM 1.3.0; RKNN rknpu2',
        'toolkit_version': 'not independently verified',
        'license': 'conversion repository does not declare a license in model card metadata',
        'board_validation': 'not run',
        'files': FILES,
    }
    (DEST / 'manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
    print('Models ready:', DEST, flush=True)


if __name__ == '__main__':
    main()
