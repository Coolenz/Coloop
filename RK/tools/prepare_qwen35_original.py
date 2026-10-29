"""Fetch and verify the official, unquantized Qwen3.5-4B checkpoint for PC comparison."""
import argparse
import hashlib
import json
import urllib.request

from prepare_qwen35 import ROOT, fetch_model

REPO = 'Qwen/Qwen3.5-4B'
REVISION = '851bf6e806efd8d0a36b00ddf55e13ccb7b8cd0a'
DEST = ROOT / 'downloads/qwen3.5-4b-original'
WEIGHTS = {
    'model.safetensors-00001-of-00002.safetensors': {
        'bytes': 5329398688,
        'sha256': '26a93f066e1916adb13453dae5a0c707c0fbc71299ed98779571a907b8e74c61'},
    'model.safetensors-00002-of-00002.safetensors': {
        'bytes': 3990429408,
        'sha256': 'cb544bd9bfae93dc59b0f22b292f5933573854a7f9b97835c67060d7d910e188'},
    'tokenizer.json': {'bytes': 12807982,
                       'sha256': '5f9e4d4901a92b997e463c1f46055088b6cca5ca61a6522d1b9f64c4bb81cb42'},
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--mirror', action='store_true')
    parser.add_argument('--workers', type=int, default=8, choices=range(1, 33))
    parser.add_argument('--metadata-only', action='store_true')
    args = parser.parse_args()
    DEST.mkdir(parents=True, exist_ok=True)
    with urllib.request.urlopen(f'https://huggingface.co/api/models/{REPO}/revision/{REVISION}?blobs=true', timeout=45) as response:
        metadata = json.load(response)
    selected = {'config.json', 'model.safetensors.index.json', 'tokenizer_config.json',
                'chat_template.jinja', 'generation_config.json', 'vocab.json', 'merges.txt', 'README.md'}
    files = dict(WEIGHTS)
    for entry in metadata['siblings']:
        name = entry['rfilename']
        if name not in selected:
            continue
        cached = DEST / name
        data = cached.read_bytes() if cached.exists() else b''
        cached_blob = hashlib.sha1(f'blob {len(data)}\0'.encode() + data).hexdigest()
        if cached_blob != entry['blobId']:
            with urllib.request.urlopen(f'https://huggingface.co/{REPO}/raw/{REVISION}/{name}', timeout=45) as response:
                data = response.read()
        blob = hashlib.sha1(f'blob {len(data)}\0'.encode() + data).hexdigest()
        if blob != entry['blobId']:
            raise ValueError(f'Git blob mismatch: {name}')
        (DEST / name).write_bytes(data)
        files[name] = {'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
    if not args.metadata_only:
        for name, spec in WEIGHTS.items():
            fetch_model(name, spec, args.workers, args.mirror,
                        destination=DEST, repository=REPO, revision=REVISION)
    manifest = {'repository': REPO, 'revision': REVISION, 'dtype': 'original BF16 (some tensors F32)',
                'quantized': False, 'files': files, 'metadata_only': args.metadata_only,
                'transport_endpoint': 'hf-mirror.com' if args.mirror else 'huggingface.co'}
    (DEST / 'manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
    print('Official checkpoint ready:', DEST, flush=True)


if __name__ == '__main__':
    main()
