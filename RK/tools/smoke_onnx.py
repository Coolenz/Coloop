"""Generate a tiny Conv+Relu model and validate CPU inference numerically."""
from pathlib import Path

import numpy as np
import onnx
import onnxruntime as ort
from onnx import TensorProto, helper, numpy_helper


def main():
    root = Path(__file__).resolve().parents[1]
    target = root / 'models' / 'smoke.onnx'
    target.parent.mkdir(exist_ok=True)
    weight = np.eye(3, dtype=np.float32).reshape(3, 3, 1, 1)
    graph = helper.make_graph(
        [helper.make_node('Conv', ['input', 'weight'], ['conv'], kernel_shape=[1, 1]),
         helper.make_node('Relu', ['conv'], ['output'])],
        'rk3588_smoke',
        [helper.make_tensor_value_info('input', TensorProto.FLOAT, [1, 3, 8, 8])],
        [helper.make_tensor_value_info('output', TensorProto.FLOAT, [1, 3, 8, 8])],
        [numpy_helper.from_array(weight, name='weight')],
    )
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid('', 12)])
    model.ir_version = 8
    onnx.checker.check_model(model)
    onnx.save(model, target)
    sample = np.linspace(-1, 1, 192, dtype=np.float32).reshape(1, 3, 8, 8)
    session = ort.InferenceSession(str(target), providers=['CPUExecutionProvider'])
    actual = session.run(None, {'input': sample})[0]
    np.testing.assert_allclose(actual, np.maximum(sample, 0), rtol=1e-5, atol=1e-6)
    print(f'PASS: ONNX checker and CPU inference; model={target}; shape={actual.shape}')


if __name__ == '__main__':
    main()
