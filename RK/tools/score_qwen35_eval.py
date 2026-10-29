"""Score unchanged four-option benchmark keys and compare identical question sets."""
import argparse
from collections import defaultdict
import json
from pathlib import Path


def score_report(report):
    cases = report['cases']
    if not cases or any(case.get('expected') not in {'A', 'B', 'C', 'D'} for case in cases):
        raise ValueError('This scorer requires single-choice cases with original A/B/C/D answer keys')
    groups = defaultdict(lambda: {'count': 0, 'matches': 0})
    matches = formats = incomplete = 0
    for case in cases:
        answer = case.get('answer', '').strip()
        good = answer == case['expected']
        matches += good
        formats += answer in {'A', 'B', 'C', 'D'}
        incomplete += bool(case.get('error') or case.get('abort') or case.get('return_code', 0)
                           or case.get('output_limit_reached') or case.get('time_limit_reached'))
        groups[case['category']]['count'] += 1
        groups[case['category']]['matches'] += good
    math_cases = [case for case in cases if case.get('is_math', 'mathematics' in case['category'])]
    nonmath_cases = [case for case in cases if not case.get('is_math', 'mathematics' in case['category'])]
    supergroups = defaultdict(lambda: {'count': 0, 'matches': 0})
    hard_cases = [case for case in cases if case.get('is_hard', False)]
    for case in cases:
        if 'supercategory' in case:
            supergroups[case['supercategory']]['count'] += 1
            supergroups[case['supercategory']]['matches'] += case.get('answer', '').strip() == case['expected']
    return {'scoring': 'Exact uppercase option after whitespace stripping; original dataset keys unchanged.',
            'completed_cases': len(cases), 'planned_cases': report.get('planned_cases', len(cases)),
            'matches_original_key': matches, 'percentage': round(100 * matches / len(cases), 2),
            'valid_single_letter_outputs': formats, 'incomplete_or_failed_cases': incomplete,
            'by_subject': dict(groups),
            'by_supercategory': dict(supergroups),
            'hard': {'count': len(hard_cases), 'matches': sum(c.get('answer', '').strip() == c['expected'] for c in hard_cases)},
            'math': {'count': len(math_cases), 'matches': sum(c.get('answer', '').strip() == c['expected'] for c in math_cases)},
            'nonmath': {'count': len(nonmath_cases), 'matches': sum(c.get('answer', '').strip() == c['expected'] for c in nonmath_cases)},
            'scope': 'Fixed sampled subset only; not a full benchmark leaderboard score or a quantization-loss estimate.'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('summary', type=Path)
    parser.add_argument('--reference', type=Path)
    args = parser.parse_args()
    report = json.loads(args.summary.read_text(encoding='utf-8'))
    scores = score_report(report)
    (args.summary.parent / 'scores.json').write_text(json.dumps(scores, indent=2, ensure_ascii=False), encoding='utf-8')
    print(json.dumps(scores, indent=2, ensure_ascii=False))
    if args.reference:
        reference = json.loads(args.reference.read_text(encoding='utf-8'))
        left = {case['id']: case for case in reference['cases']}
        right = {case['id']: case for case in report['cases']}
        if set(left) != set(right) or any(left[key]['prompt'] != right[key]['prompt']
                                         or left[key]['expected'] != right[key]['expected'] for key in left):
            raise ValueError('Comparison requires exactly the same IDs, prompts and original answer keys')
        changed = [{'id': key, 'reference': left[key]['answer'], 'current': right[key]['answer'],
                    'expected': right[key]['expected']} for key in left if left[key]['answer'].strip() != right[key]['answer'].strip()]
        transitions = {'both_match_key': 0, 'reference_only_matches_key': 0,
                       'current_only_matches_key': 0, 'neither_matches_key': 0}
        for key in left:
            old_matches = left[key]['answer'].strip() == left[key]['expected']
            new_matches = right[key]['answer'].strip() == right[key]['expected']
            label = ('both_match_key' if old_matches and new_matches else
                     'reference_only_matches_key' if old_matches else
                     'current_only_matches_key' if new_matches else 'neither_matches_key')
            transitions[label] += 1
        comparison = {'reference': str(args.reference), 'current': str(args.summary),
                      'same_answer_count': len(left) - len(changed), 'total': len(left), 'changed_answers': changed,
                      'answer_key_transitions': transitions,
                      'reference_scores': score_report(reference), 'current_scores': scores}
        (args.summary.parent / 'comparison.json').write_text(json.dumps(comparison, indent=2, ensure_ascii=False), encoding='utf-8')
        print('Saved comparison:', args.summary.parent / 'comparison.json')


if __name__ == '__main__':
    main()
