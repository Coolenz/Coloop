"""Download the pinned official Windows CUDA PyTorch wheel with resumable ranges."""
from prepare_qwen35 import ROOT, fetch_model

NAME = 'torch-2.11.0+cu128-cp312-cp312-win_amd64.whl'
SPEC = {'bytes': 2753189216,
        'sha256': '7c78215c3af4f62e63f2b2e360f1722fc719b0853c7ac22666483d9810613a4c'}
URL = 'https://download.pytorch.org/whl/cu128/torch-2.11.0%2Bcu128-cp312-cp312-win_amd64.whl'


def main():
    destination = ROOT / 'downloads/wheels/qwen-pc'
    destination.mkdir(parents=True, exist_ok=True)
    # Direct official CDN transport; acceptance uses the official index's SHA256.
    fetch_model(NAME, SPEC, 8, True, destination=destination, source_url=URL)


if __name__ == '__main__':
    main()
