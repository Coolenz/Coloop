"""Check only the dependencies appropriate to the selected machine."""
import argparse
import ctypes
import importlib
import importlib.metadata
import json
import platform
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    group = parser.add_mutually_exclusive_group()
    group.add_argument('--rknn', action='store_true')
    group.add_argument('--board', action='store_true')
    args = parser.parse_args()
    result = {'system': platform.platform(), 'python': platform.python_version(), 'checks': {}}
    modules = [('numpy', 'numpy'), ('cv2', 'opencv-python')]
    if args.board:
        modules.append(('rknnlite.api', 'rknn-toolkit-lite2'))
    else:
        modules += [('onnx', 'onnx'), ('onnxruntime', 'onnxruntime')]
        if args.rknn:
            modules.append(('rknn.api', 'rknn-toolkit2'))
        else:
            modules += [('serial', 'pyserial'), ('PIL', 'Pillow')]
    failed = False
    for module, package in modules:
        try:
            importlib.import_module(module)
            result['checks'][package] = importlib.metadata.version(package)
        except Exception as exc:
            result['checks'][package] = f'FAIL: {exc}'
            failed = True
    if args.board:
        try:
            compatible = Path('/proc/device-tree/compatible').read_bytes()
            assert b'rk3588' in compatible, 'Not an RK3588 board'
            ctypes.CDLL('librknnrt.so')
            result['checks']['board_runtime'] = 'RK3588 detected; librknnrt.so loadable'
        except Exception as exc:
            result['checks']['board_runtime'] = f'FAIL: {exc}'
            failed = True
    root = Path(__file__).resolve().parents[1]
    (root / 'logs').mkdir(exist_ok=True)
    name = 'board' if args.board else ('linux' if args.rknn else 'host')
    report = json.dumps(result, ensure_ascii=False, indent=2)
    (root / 'logs' / f'doctor-{name}.json').write_text(report, encoding='utf-8')
    print(report)
    raise SystemExit(1 if failed else 0)


if __name__ == '__main__':
    main()
