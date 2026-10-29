"""Run the generated smoke.rknn on an RK3588 board and compare values."""
import argparse
from pathlib import Path

import numpy as np


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--model', type=Path,
                        default=Path(__file__).resolve().parents[1] / 'models/smoke.rknn')
    args = parser.parse_args()
    if not args.model.is_file():
        parser.error('Missing smoke.rknn: run the Linux converter first.')
    from rknnlite.api import RKNNLite

    runtime = RKNNLite()
    try:
        ret = runtime.load_rknn(str(args.model))
        if ret != 0:
            raise RuntimeError(f'load_rknn failed: {ret}')
        ret = runtime.init_runtime(core_mask=RKNNLite.NPU_CORE_AUTO)
        if ret != 0:
            raise RuntimeError(f'init_runtime failed: {ret}; check driver/runtime versions')
        x = np.linspace(-1, 1, 192, dtype=np.float32).reshape(1, 3, 8, 8)
        outputs = runtime.inference(inputs=[x], data_format=['nchw'])
        if outputs is None or len(outputs) != 1:
            raise RuntimeError('NPU inference failed')
        expected = np.maximum(x, 0)
        actual = outputs[0]
        if actual.shape == (1, 8, 8, 3):
            actual = actual.transpose(0, 3, 1, 2)
        np.testing.assert_allclose(actual, expected, rtol=0.01, atol=0.002)
        print('PASS: RK3588 NPU inference agrees with the CPU reference.')
    finally:
        runtime.release()


if __name__ == '__main__':
    main()
