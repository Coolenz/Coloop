"""Small NumPy reference labs. These do not implement RKLLM kernels.

Read docs/学习路线.md section 0 before comparing these reference solutions.
"""

import argparse
import numpy as np


def layout():
    """A tensor's shape and strides describe how indices address storage."""
    x = np.arange(6, dtype=np.float32).reshape(2, 3)
    for name, value in [('original', x), ('transpose', x.T), ('slice', x[:, ::2])]:
        print(f'{name}:\n{value}')
        print('shape=', value.shape, 'byte strides=', value.strides,
              'C-contiguous=', value.flags.c_contiguous,
              'shares storage=', np.shares_memory(x, value))

    transposed = x.T
    packed = np.ascontiguousarray(transposed)
    print('packed transpose: byte strides=', packed.strides,
          'shares original storage=', np.shares_memory(x, packed))
    np.testing.assert_array_equal(packed, transposed)
    assert not np.shares_memory(x, packed)

    # A coordinate in the original tensor and its transposed view addresses
    # the same value. NumPy strides here are measured in BYTES.
    offset_x = 1 * x.strides[0] + 2 * x.strides[1]
    offset_t = 2 * transposed.strides[0] + 1 * transposed.strides[1]
    print('x[1,2] and x.T[2,1]: value=', x[1, 2], 'byte offset=', offset_x)
    assert offset_x == offset_t == 20

    w = np.array([[1, 2], [3, 4], [5, 6]], dtype=np.float32)
    manual = np.zeros((x.shape[0], w.shape[1]), dtype=np.float32)
    for i in range(x.shape[0]):
        for j in range(w.shape[1]):
            for k in range(x.shape[1]):
                manual[i, j] += x[i, k] * w[k, j]
    print('three-loop matmul:\n', manual)
    np.testing.assert_allclose(manual, x @ w, rtol=0, atol=0)
    print('PASS: address offsets, independent packed storage and matmul agree.')


def quantize_symmetric(x, limit=None):
    """Teaching convention: signed [-127, 127], one scale, zero point 0."""
    limit = float(np.max(np.abs(x))) if limit is None else float(limit)
    scale = limit / 127 if limit > 0 else 1.0
    rounded = np.rint(x / scale)
    clipped = int(np.count_nonzero((rounded < -127) | (rounded > 127)))
    q = np.clip(rounded, -127, 127).astype(np.int8)
    return q, scale, clipped


def rmse(a, b):
    return float(np.sqrt(np.mean((a - b) ** 2)))


def quant():
    """Observe rounding versus clipping, then a wide integer accumulator."""
    x = np.array([-.8, -.25, -.03, .03, .25, .8, 20.0], dtype=np.float64)
    print('values (last one is an outlier):', x)
    for label, limit in [('cover outlier', 20.0), ('clip outlier', 1.0)]:
        q, scale, clipped = quantize_symmetric(x, limit)
        restored = q.astype(np.float64) * scale
        print(label, 'scale=', scale, 'clipped count=', clipped)
        print('q=', q, '\nrestored=', restored)
        print('RMSE all=', rmse(x, restored),
              'RMSE excluding outlier=', rmse(x[:-1], restored[:-1]))

    a = np.array([[.1, -.7, 1.2], [1.1, .4, -.6]], dtype=np.float64)
    w = np.array([[.2, -.8], [.7, .3], [-.4, 1.3]], dtype=np.float64)
    qa, sa, _ = quantize_symmetric(a)
    qw, sw, _ = quantize_symmetric(w)
    # Cast BEFORE matmul: widening an already overflowed result is too late.
    integer_accumulator = qa.astype(np.int32) @ qw.astype(np.int32)
    restored_output = integer_accumulator.astype(np.float64) * sa * sw
    float_reference = a @ w
    dequantized_reference = (qa.astype(np.float64) * sa) @ (qw.astype(np.float64) * sw)
    np.testing.assert_allclose(restored_output, dequantized_reference, atol=1e-12, rtol=1e-12)
    print('INT32 accumulator:\n', integer_accumulator)
    print('FP64 reference:\n', float_reference, '\nquantized result:\n', restored_output)
    print('output RMSE=', rmse(float_reference, restored_output))

    small_a = np.array([[100, 100]], dtype=np.int8)
    small_b = np.array([[2], [2]], dtype=np.int8)
    wrapped = small_a @ small_b
    widened = small_a.astype(np.int32) @ small_b.astype(np.int32)
    print('NumPy INT8 matmul (overflow example)=', wrapped.item(),
          '; widened accumulator=', widened.item())
    assert widened.item() == 400
    assert wrapped.item() != widened.item()
    print('PASS: integer scaling agrees with dequantized arithmetic; errors remain versus original.')


def causal_attention(q, k, v, query_start=0):
    """Single head, additive mask, absolute query positions, no RoPE."""
    scores = q @ k.T / np.sqrt(q.shape[-1])
    query_positions = query_start + np.arange(q.shape[0])[:, None]
    key_positions = np.arange(k.shape[0])[None, :]
    scores = np.where(key_positions <= query_positions, scores, -np.inf)
    shifted = scores - np.max(scores, axis=-1, keepdims=True)
    probabilities = np.exp(shifted)
    probabilities /= np.sum(probabilities, axis=-1, keepdims=True)
    return probabilities @ v


def attention():
    """Compare full causal attention with prefill + chunked cached calls."""
    rng = np.random.default_rng(42)
    x = rng.normal(size=(8, 6))
    wq, wk, wv = [rng.normal(size=(6, 4)) / np.sqrt(6) for _ in range(3)]
    full = causal_attention(x @ wq, x @ wk, x @ wv)

    def cached(chunks, broken_offset=False):
        k_cache, v_cache = np.empty((0, 4)), np.empty((0, 4))
        output = []
        start = 0
        for size in chunks:
            new_x = x[start:start + size]
            q = new_x @ wq
            k_cache = np.concatenate((k_cache, new_x @ wk), axis=0)
            v_cache = np.concatenate((v_cache, new_x @ wv), axis=0)
            output.append(causal_attention(q, k_cache, v_cache,
                                           0 if broken_offset else start))
            start += size
        assert start == len(x)
        return np.concatenate(output, axis=0)

    for chunks in [(3, 1, 1, 1, 1, 1), (3, 2, 1, 2), (8,)]:
        actual = cached(chunks)
        error = float(np.max(np.abs(full - actual)))
        print('chunks=', chunks, 'max absolute error=', error)
        np.testing.assert_allclose(actual, full, atol=1e-12, rtol=1e-12)

    # Independent causal check: changing future inputs must not affect the past.
    modified = x.copy()
    modified[5:] += 30
    modified_full = causal_attention(modified @ wq, modified @ wk, modified @ wv)
    np.testing.assert_allclose(modified_full[:5], full[:5], atol=1e-12, rtol=1e-12)

    # Deliberately ignore cached query-position offsets: same shapes, wrong result.
    broken = cached((3, 2, 1, 2), broken_offset=True)
    broken_error = float(np.max(np.abs(broken - full)))
    print('wrong query offset: max absolute error=', broken_error)
    assert broken_error > 1e-3
    print('PASS: full/chunked outputs agree, future tokens are masked, wrong offsets are detected.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('lab', choices=['layout', 'quant', 'attention', 'all'])
    args = parser.parse_args()
    labs = {'layout': layout, 'quant': quant, 'attention': attention}
    selected = labs if args.lab == 'all' else {args.lab: labs[args.lab]}
    for name, run in selected.items():
        print(f'\n--- {name} ---')
        run()
