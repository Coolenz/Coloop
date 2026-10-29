"""Evaluate original BF16 Qwen3.5-4B on the PC with bounded GPU/CPU/disk offload."""
import argparse
from collections import Counter
import gc
import datetime
import functools
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import platform
import time

os.environ.setdefault('TOKENIZERS_PARALLELISM', 'false')
os.environ.setdefault('HF_HUB_OFFLINE', '1')
os.environ.setdefault('HF_HUB_DISABLE_TELEMETRY', '1')

from prepare_qwen35 import ROOT


def trim_own_working_set():
    """Release this process's reclaimable file-backed pages after checkpoint loading."""
    gc.collect()
    if os.name != 'nt':
        return False
    import ctypes
    from ctypes import wintypes
    kernel = ctypes.windll.kernel32
    kernel.GetCurrentProcess.restype = wintypes.HANDLE
    trim = ctypes.windll.psapi.EmptyWorkingSet
    trim.argtypes = [wintypes.HANDLE]
    trim.restype = wintypes.BOOL
    return bool(trim(kernel.GetCurrentProcess()))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--model', type=Path, default=ROOT / 'downloads/qwen3.5-4b-original')
    parser.add_argument('--gpu-memory-gib', type=float, default=4.5)
    parser.add_argument('--cpu-memory-gib', type=float, default=0.75)
    parser.add_argument('--tokens', type=int, default=128)
    parser.add_argument('--limit', type=int)
    parser.add_argument('--no-cache', action='store_true', help='Recompute each prefix to diagnose cache-path errors')
    parser.add_argument('--offload-read-backend', choices=['mmap', 'pread'], default='pread' if os.name == 'nt' else 'mmap',
                        help='Safetensors disk reader; pread avoids the observed Windows mmap access violation')
    parser.add_argument('--dataset', type=Path, action='append', help='Repeat to select exact public dataset files')
    args = parser.parse_args()
    stamp = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))).strftime('%Y%m%d-%H%M%S')
    destination = ROOT / 'logs' / ('qwen35-pc-bf16-' + stamp)
    destination.mkdir(parents=True, exist_ok=False)
    report = {'created_at': stamp, 'timezone': 'Asia/Shanghai', 'model': str(args.model),
              'checkpoint': json.loads((args.model / 'manifest.json').read_text(encoding='utf-8')),
              'platform': platform.platform(), 'status': 'initializing', 'cases': [],
              'settings': {'dtype': 'bfloat16', 'quantized': False, 'thinking': False, 'do_sample': False,
                           'max_new_tokens': args.tokens, 'max_input_plus_output_tokens': 2048,
                           'gpu_weight_budget_gib': args.gpu_memory_gib,
                           'cpu_weight_budget_gib': args.cpu_memory_gib,
                           'use_cache': not args.no_cache,
                           'offload_read_backend': args.offload_read_backend,
                           'process_isolation': 'model loaded once; independent prompt and new generation cache per case'}}

    def save():
        (destination / 'summary.json').write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding='utf-8')

    save()
    try:
        import torch
        import psutil
        from accelerate import init_empty_weights
        from safetensors import safe_open
        from transformers import AutoTokenizer, Qwen3_5ForCausalLM, Qwen3_5TextConfig, TextStreamer

        # Select the supported byte-reading backend only for this process's disk
        # offload reader; checkpoint bytes and tensor dtypes are unchanged.
        import accelerate.utils.offload as offload
        offload.safe_open = functools.partial(safe_open, backend=args.offload_read_backend)

        torch.set_num_threads(4)
        if not torch.cuda.is_available():
            raise RuntimeError('CUDA is not available in this isolated environment')
        if not torch.cuda.is_bf16_supported():
            raise RuntimeError('GPU does not support BF16')
        free, total = torch.cuda.mem_get_info()
        report['resources_before_load'] = {'gpu': torch.cuda.get_device_name(0),
                                            'gpu_total_bytes': total, 'gpu_free_bytes': free,
                                            'ram_available_bytes': psutil.virtual_memory().available}
        report['packages'] = {name: importlib.metadata.version(name)
                              for name in ['torch', 'transformers', 'accelerate', 'safetensors']}
        if free < (args.gpu_memory_gib + 0.6) * 1024**3:
            raise RuntimeError('Not enough currently free VRAM for the requested weight budget and workspace')
        if psutil.virtual_memory().available < 1.5 * 1024**3:
            raise RuntimeError('Less than 1.5 GiB host memory currently available; cannot safely load the baseline')

        config_json = json.loads((args.model / 'config.json').read_text(encoding='utf-8'))
        config = Qwen3_5TextConfig(**config_json['text_config'])
        config.tie_word_embeddings = True
        tokenizer = AutoTokenizer.from_pretrained(args.model, local_files_only=True)
        config_stop_ids = config.eos_token_id if isinstance(config.eos_token_id, list) else [config.eos_token_id]
        stop_ids = sorted({value for value in config_stop_ids + [tokenizer.eos_token_id] if value is not None})
        report['settings']['stop_token_ids'] = stop_ids
        with init_empty_weights():
            empty = Qwen3_5ForCausalLM(config)
        expected = {name: tuple(value.shape) for name, value in empty.state_dict().items()}
        del empty
        index = json.loads((args.model / 'model.safetensors.index.json').read_text(encoding='utf-8'))
        prefix = 'model.language_model.'
        actual, dtype_counts = {}, Counter()
        for shard in sorted(set(index['weight_map'].values())):
            with safe_open(str(args.model / shard), framework='pt', device='cpu') as archive:
                for name in archive.keys():
                    if name.startswith(prefix):
                        sliced = archive.get_slice(name)
                        mapped = 'model.' + name[len(prefix):]
                        actual[mapped] = tuple(sliced.get_shape())
                        dtype_counts[sliced.get_dtype()] += 1
        missing = set(expected) - set(actual)
        unexpected = set(actual) - set(expected)
        wrong_shapes = [name for name in actual if name in expected and actual[name] != expected[name]]
        if missing != {'lm_head.weight'} or unexpected or wrong_shapes:
            raise RuntimeError(f'Checkpoint text mapping failed: missing={missing}, unexpected={unexpected}, wrong_shapes={wrong_shapes}')
        report['checkpoint_text_validation'] = {'tensor_count': len(actual), 'dtypes': dict(dtype_counts),
                                               'shape_validation': 'passed',
                                               'only_missing_key': 'lm_head.weight (tied to token embeddings)',
                                               'excluded_components': ['vision encoder', 'MTP head']}
        save()
        print('Loading original BF16 text weights with bounded offload...', flush=True)
        started = time.monotonic()
        model, loading = Qwen3_5ForCausalLM.from_pretrained(
            args.model, config=config, dtype=torch.bfloat16, local_files_only=True,
            key_mapping={r'^model\.language_model\.': 'model.'},
            device_map='auto', max_memory={0: int(args.gpu_memory_gib * 1024**3),
                                          'cpu': int(args.cpu_memory_gib * 1024**3)},
            offload_folder=str(ROOT / 'tmp/qwen35-pc-offload'), offload_state_dict=True,
            attn_implementation='sdpa', output_loading_info=True)
        model.eval()
        if loading.get('missing_keys') or loading.get('mismatched_keys') or loading.get('error_msgs'):
            raise RuntimeError(f'Weights were not loaded completely: {loading}')
        if model.lm_head.weight is not model.model.embed_tokens.weight:
            raise RuntimeError('Language head is not tied to the original embedding weights')
        report['loading_seconds'] = round(time.monotonic() - started, 3)
        report['device_map'] = {name: str(device) for name, device in model.hf_device_map.items()}
        report['loading_info'] = {key: sorted(value) if isinstance(value, set) else value
                                  for key, value in loading.items() if key != 'unexpected_keys'}
        report['ignored_nontext_checkpoint_keys'] = len(loading.get('unexpected_keys', []))
        verified_samples = []
        for name in ['model.embed_tokens.weight', 'model.layers.0.input_layernorm.weight',
                     'model.layers.0.linear_attn.in_proj_qkv.weight',
                     'model.layers.3.self_attn.q_proj.weight', 'model.layers.13.mlp.down_proj.weight']:
            parameter = model.get_parameter(name)
            if parameter.is_meta:
                continue
            original_name = prefix + name[len('model.'):]
            with safe_open(str(args.model / index['weight_map'][original_name]), framework='pt', device='cpu') as archive:
                sliced = archive.get_slice(original_name)
                expected_sample = sliced[:2, :8] if parameter.ndim == 2 else sliced[:8]
            sample = parameter[:2, :8] if parameter.ndim == 2 else parameter[:8]
            if not torch.equal(sample.detach().cpu(), expected_sample.to(dtype=parameter.dtype)):
                raise RuntimeError(f'Loaded weight differs from checkpoint sample: {name}')
            verified_samples.append(name)
        report['bitwise_weight_samples_verified'] = verified_samples
        report['memory_after_load_before_trim'] = {'available_bytes': psutil.virtual_memory().available,
                                                   'process_rss_bytes': psutil.Process().memory_info().rss}
        report['own_working_set_trimmed'] = trim_own_working_set()
        report['memory_after_load_after_trim'] = {'available_bytes': psutil.virtual_memory().available,
                                                  'process_rss_bytes': psutil.Process().memory_info().rss}
        report['status'] = 'running'
        save()
        print('READY', json.dumps({key: report[key] for key in ['loading_seconds', 'device_map']}, ensure_ascii=False), flush=True)
        datasets = args.dataset or [ROOT / 'tools/evalsets/qwen35-diverse-v1.json',
                                   ROOT / 'tools/evalsets/cmmlu-nonmath-seed42-24.json']
        cases = []
        report['datasets'] = []
        for path in datasets:
            raw = path.read_bytes()
            dataset = json.loads(raw)
            report['datasets'].append({'name': dataset['name'], 'sha256': hashlib.sha256(raw).hexdigest()})
            for case in dataset['cases']:
                cases.append(dict(case, dataset=dataset['name']))
        # Check the repeatedly failing board question first; no prompt content is changed.
        cases.sort(key=lambda case: case['id'] != 'math-original')
        if args.limit:
            cases = cases[:args.limit]
        report['planned_cases'] = len(cases)
        from eval_qwen35 import check_answer
        for number, case in enumerate(cases, 1):
            memory = psutil.virtual_memory()
            if memory.available < 800 * 1024**2:
                trim_own_working_set()
                memory = psutil.virtual_memory()
            if memory.available < 550 * 1024**2:
                raise RuntimeError('Host available memory fell below 550 MiB; stopping the bounded comparison')
            messages = [{'role': 'user', 'content': case['prompt']}]
            prompt = tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True,
                                                   enable_thinking=False)
            inputs = tokenizer(prompt, return_tensors='pt', add_special_tokens=False).to('cuda:0')
            if inputs.input_ids.shape[1] + args.tokens > 2048:
                raise RuntimeError('Prompt exceeds comparison context budget')
            torch.cuda.reset_peak_memory_stats()
            before = time.monotonic()
            print(f'[{number}/{len(cases)}] {case["id"]}', flush=True)
            with torch.inference_mode():
                outputs = model.generate(**inputs, max_new_tokens=args.tokens, do_sample=False,
                                         num_beams=1, repetition_penalty=1.0, use_cache=not args.no_cache,
                                         pad_token_id=tokenizer.pad_token_id or tokenizer.eos_token_id,
                                         eos_token_id=stop_ids, max_time=180,
                                         logits_to_keep=1,
                                         streamer=TextStreamer(tokenizer, skip_prompt=True, skip_special_tokens=True))
            torch.cuda.synchronize()
            generated = outputs[0, inputs.input_ids.shape[1]:].tolist()
            answer = tokenizer.decode(generated, skip_special_tokens=True).strip()
            item = {'id': case['id'], 'category': case['category'], 'dataset': case['dataset'],
                    'prompt': case['prompt'], 'expected': case['expected'], 'answer': answer,
                    'automatic_match': check_answer(case, answer), 'review': 'pending manual review',
                    'prompt_tokens': inputs.input_ids.shape[1], 'generated_tokens': len(generated),
                    'generated_token_ids': generated, 'rendered_prompt': prompt,
                    'elapsed_seconds': round(time.monotonic() - before, 3),
                    'gpu_peak_allocated_bytes': torch.cuda.max_memory_allocated(),
                    'process_rss_bytes': psutil.Process().memory_info().rss,
                    'host_available_bytes': psutil.virtual_memory().available,
                    'output_limit_reached': len(generated) >= args.tokens,
                    'ended_with_eos': bool(generated and generated[-1] in stop_ids),
                    'time_limit_reached': time.monotonic() - before >= 180 and not (generated and generated[-1] in stop_ids)}
            item.update({key: case[key] for key in ['subject_zh', 'supercategory', 'is_math', 'is_hard'] if key in case})
            report['cases'].append(item)
            save()
            print(json.dumps({key: item[key] for key in ['id', 'expected', 'answer', 'automatic_match',
                                                        'elapsed_seconds', 'generated_tokens']}, ensure_ascii=False), flush=True)
            del inputs, outputs
        report['status'] = 'completed'
        if all(case['expected'] in {'A', 'B', 'C', 'D'} for case in cases):
            from score_qwen35_eval import score_report
            report['scores'] = score_report(report)
            (destination / 'scores.json').write_text(json.dumps(report['scores'], indent=2, ensure_ascii=False), encoding='utf-8')
            print('Scores:', json.dumps(report['scores'], ensure_ascii=False), flush=True)
        save()
    except BaseException as exc:
        report['status'] = 'failed'
        report['error'] = {'type': type(exc).__name__, 'message': str(exc)}
        save()
        raise
    print('Saved:', destination, flush=True)


if __name__ == '__main__':
    main()
