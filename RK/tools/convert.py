"""Convert ONNX to RK3588 RKNN. Preprocessing must match model training."""
import argparse
from pathlib import Path


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--input', required=True, type=Path)
    p.add_argument('--output', required=True, type=Path)
    p.add_argument('--dataset', type=Path, help='Calibration image list; enables INT8 quantization')
    p.add_argument('--mean', nargs=3, type=float, default=[0, 0, 0])
    p.add_argument('--std', nargs=3, type=float, default=[1, 1, 1])
    a = p.parse_args()
    if not a.input.is_file():
        p.error(f'Missing ONNX file: {a.input}')
    if a.dataset and not a.dataset.is_file():
        p.error(f'Missing calibration list: {a.dataset}')
    from rknn.api import RKNN

    rknn = RKNN(verbose=True)
    try:
        steps = [
            ('config', lambda: rknn.config(target_platform='rk3588',
                                           mean_values=[a.mean], std_values=[a.std])),
            ('load_onnx', lambda: rknn.load_onnx(model=str(a.input.resolve()))),
            ('build', lambda: rknn.build(do_quantization=a.dataset is not None,
                                        dataset=str(a.dataset.resolve()) if a.dataset else None)),
        ]
        for name, action in steps:
            ret = action()
            if ret not in (0, None):
                raise RuntimeError(f'{name} failed: {ret}')
        a.output.parent.mkdir(parents=True, exist_ok=True)
        ret = rknn.export_rknn(str(a.output.resolve()))
        if ret != 0:
            raise RuntimeError(f'export_rknn failed: {ret}')
        print(f'RK3588 model saved: {a.output}')
    finally:
        rknn.release()


if __name__ == '__main__':
    main()
