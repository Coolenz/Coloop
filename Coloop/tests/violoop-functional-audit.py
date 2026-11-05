"""Independent disk audits for actual product outputs, without modifying them."""
import argparse
import csv
import hashlib
import io
import json
from pathlib import Path
import xml.etree.ElementTree as ET
import zipfile
import tempfile
import re

S = {'s': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
     'c': 'http://schemas.openxmlformats.org/drawingml/2006/chart'}


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def workbook(path):
    with zipfile.ZipFile(path) as archive:
        shared = []
        if 'xl/sharedStrings.xml' in archive.namelist():
            shared = [''.join(item.itertext()) for item in ET.fromstring(archive.read('xl/sharedStrings.xml'))]
        book = ET.fromstring(archive.read('xl/workbook.xml'))
        sheets = {}
        formulas = {}
        for index, sheet in enumerate(book.find('s:sheets', S), 1):
            xml = ET.fromstring(archive.read(f'xl/worksheets/sheet{index}.xml'))
            rows = []
            for row in xml.findall('s:sheetData/s:row', S):
                values = []
                for cell in row:
                    column = 0
                    for letter in re.match(r'[A-Z]+', cell.get('r')).group():
                        column = column * 26 + ord(letter) - 64
                    while len(values) < column:
                        values.append('')
                    value = cell.find('s:v', S)
                    text = value.text if value is not None else ''
                    if cell.get('t') == 's':
                        text = shared[int(text)]
                    elif cell.get('t') == 'inlineStr':
                        text = ''.join(cell.find('s:is', S).itertext())
                    elif cell.get('t') not in ('str', 'e') and text:
                        text = float(text)
                    formula = cell.find('s:f', S)
                    if formula is not None:
                        formulas[f'{sheet.get("name")}!{cell.get("r")}'] = formula.text
                    values[column - 1] = text
                rows.append(values)
            sheets[sheet.get('name')] = rows
        charts = [ET.fromstring(archive.read(name)) for name in archive.namelist()
                  if name.startswith('xl/charts/chart') and name.endswith('.xml')]
        return sheets, formulas, charts


def sales(root, output):
    source = root / '销售原始.csv'
    raw = list(csv.reader(io.StringIO(source.read_text(encoding='utf-8-sig'))))
    sheets, formulas, charts = workbook(output)
    expected_names = ['原始数据', '有效交易', '异常', '区域汇总', '图表']
    trades = sheets.get('有效交易', [])[1:]
    records = {str(row[0]): row for row in trades if row and row[0]}
    trade_headers = sheets.get('有效交易', [[]])[0]
    signed_column = trade_headers.index('净收入') if '净收入' in trade_headers else 2
    signed_amounts = {order: row[signed_column] for order, row in records.items() if len(row) > signed_column}
    regions = {str(row[0]): row[1] for row in sheets.get('区域汇总', [])[1:] if len(row) > 1}
    numbers = [float(node.text) for chart in charts for node in chart.findall('.//c:val//c:numCache/c:pt/c:v', S)]
    original = sheets.get('原始数据', [])
    normalized = lambda rows: [[str(int(value)) if isinstance(value, float) and value.is_integer() else str(value or '') for value in row] for row in rows]
    checks = {
        'five_sheets': list(sheets) == expected_names,
        'source_rows_preserved': normalized(original) == normalized(raw),
        'four_unique_trades': len(trades) == 4 and set(records) == {'A001', 'A002', 'A003', 'A004'},
        'refund_negative': signed_amounts == {'A001': 100, 'A002': 200, 'A003': 150, 'A004': -50},
        'missing_amount_excluded': 'A005' not in records and any('A005' in str(row) and ('空' in str(row) or '缺' in str(row)) for row in sheets.get('异常', [])),
        'region_totals': regions.get('华东') == 250 and regions.get('华南') == 150,
        'grand_total': any(row[1] == 400 for row in sheets.get('区域汇总', []) if len(row) > 1),
        'calculated_formulas': sum(key.startswith('区域汇总!') for key in formulas) >= 3,
        'chart_values': len(charts) >= 1 and 250 in numbers and 150 in numbers,
        'no_formula_errors': not any(str(cell).startswith(('#REF!', '#VALUE!', '#DIV/0!', '#NAME?', '#N/A')) for rows in sheets.values() for row in rows for cell in row),
    }
    return {'checks': checks, 'source_sha256': digest(source), 'artifact_sha256': digest(output),
            'sheets': sheets, 'formulas': formulas, 'chart_cached_values': numbers}


def archive_files(root, output, baseline, evidence):
    inbox = root / 'inbox'
    organized = root / '整理'
    mapping = list(csv.DictReader(io.StringIO((organized / '清单.csv').read_text(encoding='utf-8-sig'))))
    original = baseline['files']
    norm = lambda value: value.replace('\\', '/').removeprefix('./')
    current = {norm(str(path.relative_to(inbox))): digest(path) for path in inbox.rglob('*') if path.is_file()}
    original = {norm(name): value for name, value in original.items()}
    checks = {'source_unchanged': current == original, 'twelve_mappings': len(mapping) == 12,
              'unique_originals': len({row['原路径'] for row in mapping}) == 12,
              'unique_destinations': len({row['新路径'] for row in mapping}) == 12}
    extracted = Path(tempfile.mkdtemp(prefix='independent-extract-', dir=evidence))
    with zipfile.ZipFile(output) as archive:
        for entry in archive.infolist():
            destination = (extracted / entry.filename).resolve()
            if not destination.is_relative_to(extracted.resolve()):
                raise ValueError('Archive traversal detected')
        archive.extractall(extracted)
        checks['zip_excludes_itself'] = not any(entry.filename.endswith(output.name) for entry in archive.infolist())
    for index, row in enumerate(mapping):
        before, after = norm(row['原路径']), norm(row['新路径'])
        destination = (organized / after).resolve()
        if not destination.is_relative_to(organized.resolve()):
            raise ValueError('Mapping traversal detected')
        expected = original.get(before)
        checks[f'file_{index+1}_copy_and_extract'] = bool(expected and row['SHA256'].lower() == expected
            and digest(destination) == expected and digest(extracted / after) == expected)
        category = '票据' if before.lower().endswith('.pdf') else '照片' if before.lower().endswith('.jpg') else '文档'
        checks[f'file_{index+1}_category'] = after.split('/')[0] == category
    checks['empty_directory_preserved'] = all((organized / name).is_dir() and (extracted / name).is_dir() for name in baseline['empty_directories'])
    return {'checks': checks, 'artifact_sha256': digest(output), 'mapping': mapping, 'extraction': str(extracted)}


def mixed_orders(root, output, baseline):
    sheets, formulas, _charts = workbook(output)
    rows = sheets.get('订单明细', [])
    headers = rows[0] if rows else []
    expected_headers = ['订单号', '客户', '日期', '金额', '来源文件', '来源位置']
    records = [dict(zip(headers, row)) for row in rows[1:] if row and row[0]]
    by_id = {str(row.get('订单号')): row for row in records}
    expected = baseline['valid_orders']
    totals = [value for row in sheets.get('日汇总', [])[1:] for value in row if isinstance(value, (int, float))]
    actual_hashes = {path.name: digest(path) for path in (root / 'input').iterdir() if path.is_file()}
    checks = {
        'required_sheets': all(name in sheets for name in ['订单明细', '异常', '日汇总']),
        'required_columns': headers == expected_headers,
        'four_unique_orders': len(records) == 4 and set(by_id) == set(expected),
        'amounts_match': all(by_id.get(order, {}).get('金额') == amount for order, amount in expected.items()),
        'dates_match': all(row.get('日期') == baseline['expected_day'] for row in records),
        'sum_280': sum(row.get('金额', 0) for row in records if isinstance(row.get('金额'), (int, float))) == 280 and 280 in totals,
        'daily_formula': any(key.startswith('日汇总!') for key in formulas),
        'unclear_not_counted': 'M005' not in by_id and any('M005' in str(row) for row in sheets.get('异常', [])),
        'source_unchanged': actual_hashes == baseline['sha256'],
        'provenance_complete': all(row.get('来源文件') and row.get('来源位置') for row in records),
        'csv_provenance': 'orders.csv' in str(by_id.get('M001', {}).get('来源文件')),
        'text_provenance': 'order.txt' in str(by_id.get('M003', {}).get('来源文件')),
        'pdf_page_two': 'scan-order.pdf' in str(by_id.get('M004', {}).get('来源文件')) and '2' in str(by_id.get('M004', {}).get('来源位置')),
        'm002_source_line': bool(re.search(r'(?<!\d)3(?!\d)', str(by_id.get('M002', {}).get('来源位置')))) if 'orders.csv' in str(by_id.get('M002', {}).get('来源文件')) else bool(re.search(r'(?<!\d)2(?!\d)', str(by_id.get('M002', {}).get('来源位置')))),
        'daily_valid_count': any(len(row) > 1 and row[0] == baseline['expected_day'] and row[1] == 4 for row in sheets.get('日汇总', [])[1:]),
    }
    return {'checks': checks, 'sheets': sheets, 'formulas': formulas, 'artifact_sha256': digest(output)}


def long_document(root, baseline, progress=False):
    index_name, summary_name = ('总索引.csv', '总摘要.md') if progress else ('索引.csv', '摘要.md')
    index = list(csv.DictReader(io.StringIO((root / index_name).read_text(encoding='utf-8-sig'))))
    summary = (root / summary_name).read_text(encoding='utf-8-sig')
    by_id = {row['段落ID']: row for row in index}
    checks = {
        'sixty_rows': len(index) == baseline['count'],
        'all_ids_once': len(by_id) == len(index) and set(by_id) == set(baseline['ids']),
        'amounts': all(float(by_id.get(order, {}).get('金额', 'nan')) == amount for order, amount in baseline['amounts'].items()),
        'source_lines': all(int(by_id.get(order, {}).get('来源行', -1)) == ((int(order[1:]) - 1) % 15 + 1 if progress else int(order[1:])) for order in baseline['ids']),
        'titles': all(by_id.get(order, {}).get('标题') == f'测试项目{int(order[1:]):02d}' for order in baseline['ids']),
    }
    if progress:
        checks['source_unchanged'] = all(digest(root / name) == expected for name, expected in baseline['source_files'].items())
        checks['source_files'] = all(by_id.get(order, {}).get('来源文件') == f'卷{(int(order[1:]) - 1) // 15 + 1}.txt' for order in baseline['ids'])
        for part in range(1, 5):
            path = root / (f'卷{part}摘要-修订版.md' if (root / f'卷{part}摘要-修订版.md').exists() else f'卷{part}摘要.md')
            actual = set(re.findall(r'\bS\d{3}\b', path.read_text(encoding='utf-8-sig')))
            checks[f'volume_{part}_summary'] = actual == {f'S{i:03d}' for i in range((part - 1) * 15 + 1, part * 15 + 1)}
        checks['total_summary_links_parts'] = all(f'卷{part}摘要' in summary for part in range(1, 5))
    else:
        checks['summary_all_ids'] = set(re.findall(r'\bS\d{3}\b', summary)) == set(baseline['ids'])
        checks['source_unchanged'] = digest(root / 'source.txt') == baseline['source_sha256']
    return {'checks': checks, 'index_sha256': digest(root / index_name), 'summary_sha256': digest(root / summary_name)}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('case', choices=['F09', 'F08', 'F14', 'A05', 'A05-progress'])
    parser.add_argument('root', type=Path)
    parser.add_argument('output', type=Path)
    parser.add_argument('--baseline', type=Path)
    parser.add_argument('--report', type=Path, required=True)
    args = parser.parse_args()
    try:
        if args.case == 'F09':
            result = sales(args.root, args.output)
        elif args.case == 'F08':
            result = archive_files(args.root, args.output, json.loads(args.baseline.read_text(encoding='utf-8')), args.report.parent)
        elif args.case == 'F14':
            result = mixed_orders(args.root, args.output, json.loads(args.baseline.read_text(encoding='utf-8')))
        else:
            result = long_document(args.root, json.loads(args.baseline.read_text(encoding='utf-8')), args.case == 'A05-progress')
    except Exception as error:
        result = {'checks': {'audit_completed': False}, 'error': f'{type(error).__name__}: {error}'}
    result['status'] = 'PASS' if all(result['checks'].values()) else 'FAIL'
    args.report.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'status': result['status'], 'checks': result['checks']}, ensure_ascii=False))
    raise SystemExit(0 if result['status'] == 'PASS' else 1)
