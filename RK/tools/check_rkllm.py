"""Check the isolated converter; optionally compile a tiny, untrained Qwen2 model."""
import argparse
import importlib.metadata
import json
import os
from pathlib import Path
import platform

os.environ.setdefault('CUDA_VISIBLE_DEVICES', '')
os.environ.setdefault('TOKENIZERS_PARALLELISM', 'false')
ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--conversion', action='store_true')
    args = parser.parse_args()
    import torch
    from rkllm.api import RKLLM
    report = {
        'python': platform.python_version(),
        'rkllm_toolkit': importlib.metadata.version('rkllm-toolkit'),
        'torch': torch.__version__,
        'conversion_device': 'cpu',
        'target_platform': 'rk3588',
        'full_deepseek_conversion_tested': False,
    }
    assert report['rkllm_toolkit'] == '1.3.1', report
    llm = RKLLM()
    report['initialization'] = 'passed'
    if args.conversion:
        from tokenizers import ByteLevelBPETokenizer
        from transformers import AutoTokenizer, Qwen2Tokenizer, Qwen2Config, Qwen2ForCausalLM
        work = ROOT / 'tmp/rkllm-toolkit-smoke'
        model_dir = work / 'tiny-qwen2-untrained'
        model_dir.mkdir(parents=True, exist_ok=True)
        torch.manual_seed(42)
        trainer = ByteLevelBPETokenizer()
        trainer.train_from_iterator([' '.join(f'word{i}' for i in range(200))] * 4,
                                    vocab_size=512, min_frequency=2, special_tokens=['<|endoftext|>'])
        spec = json.loads(trainer.to_str())['model']
        vocab = spec['vocab']
        while len(vocab) < 512:
            vocab[f'<unused{len(vocab)}>'] = len(vocab)
        fast = Qwen2Tokenizer(vocab=vocab, merges=[tuple(pair) for pair in spec['merges']], bos_token='<|endoftext|>',
                              model_max_length=2048)
        fast.save_pretrained(model_dir)
        config = Qwen2Config(vocab_size=512, hidden_size=256, intermediate_size=768,
                             num_hidden_layers=2, num_attention_heads=4, num_key_value_heads=2,
                             max_position_embeddings=2048, bos_token_id=0, eos_token_id=0,
                             pad_token_id=0, tie_word_embeddings=False)
        model = Qwen2ForCausalLM(config)
        with torch.no_grad():
            model(**fast('word1 word2 word3', return_tensors='pt'))
        model.save_pretrained(model_dir)
        del model
        reloaded = AutoTokenizer.from_pretrained(model_dir)
        assert len(reloaded('word1 word2')['input_ids']) > 0
        dataset = work / 'calibration.json'
        dataset.write_text(json.dumps([
            {'input': ' '.join(f'word{(i+j) % 100}' for j in range(32)),
             'target': 'word101 word102'}
            for i in range(4)
        ]), encoding='utf-8')
        code = llm.load_huggingface(model=str(model_dir), device='cpu')
        if code != 0:
            raise RuntimeError(f'load_huggingface failed: {code}')
        code = llm.build(do_quantization=True, optimization_level=1, quantized_dtype='w8a8',
                         quantized_algorithm='normal', target_platform='rk3588', num_npu_core=3,
                         extra_qparams=None, dataset=str(dataset), max_context=2048)
        if code != 0:
            raise RuntimeError(f'build failed: {code}')
        output = work / 'tiny-qwen2-untrained.rkllm'
        code = llm.export_rkllm(str(output))
        if code != 0 or not output.exists() or output.stat().st_size == 0:
            raise RuntimeError(f'export_rkllm failed: {code}')
        report['tiny_model_conversion'] = 'passed'
        report['output_bytes'] = output.stat().st_size
        report['scope'] = 'Untrained tiny Qwen2, CPU W8A8 conversion and export only; no board inference.'
    (ROOT / 'logs').mkdir(exist_ok=True)
    (ROOT / 'logs/rkllm-toolkit-status.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
