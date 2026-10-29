"""Freeze a stratified C-Eval validation subset before inference (requires pyarrow)."""
import concurrent.futures
import hashlib
import json
import random
import urllib.request

from prepare_qwen35 import ROOT

REVISION = '617524a00b307ff6f9933702f724131fe12ca7ce'
MAPPING_REVISION = 'cba65ae93bcf189149ced9f66ae0c958201faed9'
SEED = 42
PER_SUBJECT = 5
MATH = {'advanced_mathematics', 'probability_and_statistics', 'discrete_mathematics',
        'high_school_mathematics', 'middle_school_mathematics'}
HARD = {'advanced_mathematics', 'discrete_mathematics', 'probability_and_statistics',
        'college_chemistry', 'college_physics', 'high_school_mathematics',
        'high_school_chemistry', 'high_school_physics'}


def fetch(path, url):
    if not path.exists():
        with urllib.request.urlopen(url, timeout=90) as response:
            path.write_bytes(response.read())
    return path.read_bytes()


def main():
    import pyarrow.parquet as pq
    destination = ROOT / 'downloads/ceval' / REVISION
    destination.mkdir(parents=True, exist_ok=True)
    mapping_url = f'https://raw.githubusercontent.com/hkust-nlp/ceval/{MAPPING_REVISION}/subject_mapping.json'
    mapping_raw = fetch(destination / 'subject_mapping.json', mapping_url)
    mapping = json.loads(mapping_raw)
    subjects = sorted(mapping)
    assert len(subjects) == 52

    def download(subject):
        url = f'https://huggingface.co/datasets/ceval/ceval-exam/resolve/{REVISION}/{subject}/val-00000-of-00001.parquet'
        path = destination / (subject + '.parquet')
        raw = fetch(path, url)
        rows = pq.read_table(path).to_pylist()
        return subject, url, raw, rows

    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        downloaded = list(pool.map(download, subjects))
    generator = random.Random(SEED)
    files, cases = {}, []
    for subject, url, raw, rows in downloaded:
        indices = sorted(generator.sample(range(len(rows)), PER_SUBJECT))
        files[subject] = {'source': url, 'sha256': hashlib.sha256(raw).hexdigest(),
                          'total_rows': len(rows), 'selected_zero_based_row_indices': indices}
        for index in indices:
            row = rows[index]
            answer = row['answer'].strip()
            assert answer in {'A', 'B', 'C', 'D'}
            options = {key: row[key] for key in 'ABCD'}
            prompt = ('请回答下面的单项选择题，只输出正确选项的大写字母A、B、C或D，不要解释。\n'
                      + row['question'] + '\n' + '\n'.join(f'{key}. {value}' for key, value in options.items()))
            cases.append({'id': f'{subject}-{index}', 'category': subject,
                          'subject_zh': mapping[subject][1], 'supercategory': mapping[subject][2],
                          'is_math': subject in MATH, 'is_hard': subject in HARD,
                          'prompt': prompt, 'expected': answer, 'accepted': [answer],
                          'source_row_index': index, 'source_id': row['id'],
                          'question': row['question'], 'options': options})
    assert len(cases) == 260 and sum(item['total_rows'] for item in files.values()) == 1346
    dataset = {'name': 'ceval-val-all52-seed42-260', 'log_label': 'ceval260',
               'source': 'Official ceval/ceval-exam validation split; original questions, options and answer keys.',
               'scope': '260 zero-shot answer-only questions, five random validation rows per each of all 52 subjects. Not the full validation or official hidden-test leaderboard score.',
               'provenance': {'repository': 'https://huggingface.co/datasets/ceval/ceval-exam',
                              'revision': REVISION, 'split': 'val', 'seed': SEED,
                              'sampling': 'Python random.Random(42), five rows per subject, lexicographically sorted subjects; chosen before inference, no output-dependent filtering.',
                              'mapping_source': mapping_url, 'mapping_sha256': hashlib.sha256(mapping_raw).hexdigest(),
                              'license': 'CC BY-NC-SA 4.0',
                              'attribution': 'Yuzhen Huang et al., C-Eval: A Multi-Level Multi-Discipline Chinese Evaluation Suite for Foundation Models, NeurIPS 2023, arXiv:2305.08322.',
                              'math_subjects': sorted(MATH), 'hard_subjects': sorted(HARD),
                              'subjects': subjects, 'files': files}, 'cases': cases}
    output = ROOT / 'tools/evalsets/ceval-val-all52-seed42-260.json'
    output.write_text(json.dumps(dataset, indent=2, ensure_ascii=False), encoding='utf-8')
    print(json.dumps({'path': str(output), 'sha256': hashlib.sha256(output.read_bytes()).hexdigest(),
                      'cases': len(cases), 'validation_population': sum(x['total_rows'] for x in files.values())}))


if __name__ == '__main__':
    main()
