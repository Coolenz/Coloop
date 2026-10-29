"""Convert a local supported Hugging Face model to RK3588 W8A8 RKLLM."""
import argparse
import json
import os
from pathlib import Path

os.environ.setdefault('CUDA_VISIBLE_DEVICES', '')
os.environ.setdefault('TOKENIZERS_PARALLELISM', 'false')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--model', type=Path, required=True, help='Local Hugging Face model directory')
    parser.add_argument('--dataset', type=Path, required=True, help='Calibration JSON with input/target pairs')
    parser.add_argument('--output', type=Path, required=True, help='New .rkllm output path')
    args = parser.parse_args()
    if not (args.model / 'config.json').is_file():
        parser.error('--model must contain config.json, tokenizer files and original model weights')
    if args.output.exists():
        parser.error('--output already exists; choose a new filename')
    if args.output.suffix != '.rkllm':
        parser.error('--output must end in .rkllm')
    samples = json.loads(args.dataset.read_text(encoding='utf-8'))
    if not isinstance(samples, list) or not samples or not all(
        isinstance(row, dict) and isinstance(row.get('input'), str) and isinstance(row.get('target'), str)
        for row in samples
    ):
        parser.error('--dataset must be a nonempty JSON list of input/target strings')
    from rkllm.api import RKLLM
    llm = RKLLM()
    result = llm.load_huggingface(model=str(args.model.resolve()), device='cpu')
    if result != 0:
        raise RuntimeError(f'Model load failed: {result}')
    result = llm.build(do_quantization=True, optimization_level=1, quantized_dtype='w8a8',
                       quantized_algorithm='normal', target_platform='rk3588', num_npu_core=3,
                       extra_qparams=None, dataset=str(args.dataset.resolve()))
    if result != 0:
        raise RuntimeError(f'Model build failed: {result}')
    args.output.parent.mkdir(parents=True, exist_ok=True)
    result = llm.export_rkllm(str(args.output.resolve()))
    if result != 0:
        raise RuntimeError(f'Model export failed: {result}')
    print('Exported:', args.output.resolve())


if __name__ == '__main__':
    main()
