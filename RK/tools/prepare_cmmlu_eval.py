"""Prepare a reproducible, non-math diagnostic subset from public CMMLU test files."""
import csv
import argparse
import hashlib
import io
import json
import random
import urllib.request

from prepare_qwen35 import ROOT

REVISION = 'd6e7b716d8ac694f38969a6c0407437d1fded799'
SUBJECTS = ['elementary_chinese', 'elementary_commonsense', 'chinese_history',
            'world_history', 'chinese_literature', 'business_ethics']
SEED = 42
PER_SUBJECT = 4


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--profile', choices=['nonmath24', 'balanced48'], default='nonmath24')
    args = parser.parse_args()
    subjects = SUBJECTS
    per_subject = PER_SUBJECT
    name = 'cmmlu-nonmath-seed42-24'
    if args.profile == 'balanced48':
        subjects = ['elementary_chinese', 'elementary_commonsense', 'chinese_history', 'world_history',
                    'chinese_literature', 'computer_science', 'elementary_mathematics', 'high_school_mathematics']
        per_subject = 6
        name = 'cmmlu-balanced-seed42-48'
    destination = ROOT / 'downloads/cmmlu' / REVISION
    destination.mkdir(parents=True, exist_ok=True)
    generator = random.Random(SEED)
    files, cases = {}, []
    for subject in subjects:
        url = f'https://raw.githubusercontent.com/haonan-li/CMMLU/{REVISION}/data/test/{subject}.csv'
        path = destination / f'{subject}.csv'
        if not path.exists():
            with urllib.request.urlopen(url, timeout=45) as response:
                path.write_bytes(response.read())
        raw = path.read_bytes()
        rows = list(csv.DictReader(io.StringIO(raw.decode('utf-8-sig'))))
        indices = sorted(generator.sample(range(len(rows)), per_subject))
        files[subject] = {'source': url, 'sha256': hashlib.sha256(raw).hexdigest(),
                          'total_rows': len(rows), 'selected_zero_based_row_indices': indices}
        for index in indices:
            row = rows[index]
            question = row['Question']
            options = '\n'.join(f'{key}. {row[key]}' for key in 'ABCD')
            prompt = ('请回答下面的单项选择题，只输出正确选项的大写字母A、B、C或D，不要解释。\n'
                      + question + '\n' + options)
            answer = row['Answer'].strip()
            assert answer in 'ABCD' and len(answer) == 1
            cases.append({'id': f'{subject}-{index}', 'category': subject, 'prompt': prompt,
                          'expected': answer, 'accepted': [answer], 'source_row_index': index,
                          'question': question, 'options': {key: row[key] for key in 'ABCD'}})
    dataset = {'name': name, 'log_label': 'cmmlu' if args.profile == 'nonmath24' else 'cmmlu-balanced48',
               'source': 'Public CMMLU data/test; original questions, options and answer keys.',
               'scope': f'{len(cases)} zero-shot questions, {per_subject} per selected subject. Fixed diagnostic subset; not a full CMMLU benchmark or comparable leaderboard score.',
               'provenance': {'repository': 'https://github.com/haonan-li/CMMLU', 'revision': REVISION,
                              'seed': SEED, 'sampling': f'Python random.Random(42), {per_subject} random rows per subject, in fixed subject order; selected before inference.',
                              'subjects': subjects, 'files': files}, 'cases': cases}
    output = ROOT / 'tools/evalsets' / (name + '.json')
    output.write_text(json.dumps(dataset, indent=2, ensure_ascii=False), encoding='utf-8')
    print('Prepared:', output)
    for case in cases:
        print(json.dumps({'id': case['id'], 'question': case['question'], 'answer': case['expected']}, ensure_ascii=False))


if __name__ == '__main__':
    main()
