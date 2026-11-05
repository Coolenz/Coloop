"""Prepare isolated acceptance inputs. Never create the expected output files."""
import csv
import hashlib
import html
import json
from pathlib import Path
import zipfile


def prepare_sales(root):
    folder = root / 'F09' / 'main'
    folder.mkdir(parents=True, exist_ok=True)
    rows = [
        ['订单号', '区域', '金额', '类型'],
        ['A001', '华东', 100, '销售'],
        ['A002', '华南', 200, '销售'],
        ['A003', '华东', 150, '销售'],
        ['A004', '华南', 50, '退款'],
        ['A002', '华南', 200, '销售'],
        ['A005', '华北', '', '销售'],
    ]
    with (folder / '销售原始.csv').open('w', encoding='utf-8-sig', newline='') as stream:
        csv.writer(stream).writerows(rows)
    names = ['原始数据', '有效交易', '异常', '区域汇总', '图表']
    headers = [rows, [rows[0]], [['订单号', '原因']], [['区域', '净收入']], [['区域净收入柱状图']]]
    spreadsheet = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
    document = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
    relationships = 'http://schemas.openxmlformats.org/package/2006/relationships'
    content_types = 'http://schemas.openxmlformats.org/package/2006/content-types'
    with zipfile.ZipFile(folder / '销售模板.xlsx', 'w', zipfile.ZIP_DEFLATED) as archive:
        sheets = ''.join(
            f'<sheet name="{name}" sheetId="{index}" r:id="rId{index}"/>'
            for index, name in enumerate(names, 1)
        )
        archive.writestr('xl/workbook.xml', f'<workbook xmlns="{spreadsheet}" xmlns:r="{document}"><sheets>{sheets}</sheets></workbook>')
        archive.writestr('_rels/.rels', f'<Relationships xmlns="{relationships}"><Relationship Id="rId1" Type="{document}/officeDocument" Target="xl/workbook.xml"/></Relationships>')
        links = ''.join(f'<Relationship Id="rId{i}" Type="{document}/worksheet" Target="worksheets/sheet{i}.xml"/>' for i in range(1, 6))
        archive.writestr('xl/_rels/workbook.xml.rels', f'<Relationships xmlns="{relationships}">{links}</Relationships>')
        overrides = ''.join(f'<Override PartName="/xl/worksheets/sheet{i}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' for i in range(1, 6))
        archive.writestr('[Content_Types].xml', f'<Types xmlns="{content_types}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>{overrides}</Types>')
        for index, data in enumerate(headers, 1):
            xml_rows = []
            for row_number, row in enumerate(data, 1):
                cells = []
                for column, value in enumerate(row):
                    reference = chr(65 + column) + str(row_number)
                    if isinstance(value, str):
                        cells.append(f'<c r="{reference}" t="inlineStr"><is><t>{html.escape(value)}</t></is></c>')
                    else:
                        cells.append(f'<c r="{reference}"><v>{value}</v></c>')
                xml_rows.append(f'<row r="{row_number}">{"".join(cells)}</row>')
            archive.writestr(f'xl/worksheets/sheet{index}.xml', f'<worksheet xmlns="{spreadsheet}"><sheetData>{"".join(xml_rows)}</sheetData></worksheet>')
    baseline = {'expected_total': 400, 'expected_regions': {'华东': 250, '华南': 150}, 'input_sha256': hashlib.sha256((folder / '销售原始.csv').read_bytes()).hexdigest()}
    (folder.parent / 'baseline.json').write_text(json.dumps(baseline, ensure_ascii=False, indent=2), encoding='utf-8')
    print(f'F09 inputs ready at {folder}')


def prepare_mixed_orders(root):
    from PIL import Image, ImageDraw, ImageFont

    folder = root / 'F14' / 'main' / 'input'
    folder.mkdir(parents=True, exist_ok=True)
    (folder / 'orders.csv').write_text('订单号,客户,日期,金额\nM001,测试甲,2026-11-05,120.00\nM002,测试乙,2026-11-05,80.00\n', encoding='utf-8-sig')
    (folder / 'order.txt').write_text('订单号 M003\n客户 测试丙\n日期 2026-11-05\n金额 50.00元\n', encoding='utf-8')
    (folder / 'duplicate.csv').write_text('订单号,客户,日期,金额\nM002,测试乙,2026-11-05,80.00\n', encoding='utf-8-sig')
    font = ImageFont.truetype('C:/Windows/Fonts/msyh.ttc', 46)
    for filename, content in [
        ('scan-order.pdf', '合成扫描订单\n订单号 M004\n客户 测试丁\n日期 2026-11-05\n金额 30.00元'),
        ('unclear-order.pdf', '合成异常订单\n订单号 M005\n日期 2026-11-05\n金额 [不可辨认]'),
    ]:
        image = Image.new('RGB', (1240, 1754), 'white')
        ImageDraw.Draw(image).multiline_text((110, 160), content, font=font, fill='black', spacing=35)
        if filename == 'scan-order.pdf':
            cover = Image.new('RGB', (1240, 1754), 'white')
            ImageDraw.Draw(cover).multiline_text((110, 160), '合成扫描订单封面\n完整订单明细见第2页', font=font, fill='black', spacing=35)
            cover.save(folder / filename, 'PDF', save_all=True, append_images=[image], resolution=150)
        else:
            image.save(folder / filename, 'PDF', resolution=150)
    baseline = {
        'valid_orders': {'M001': 120, 'M002': 80, 'M003': 50, 'M004': 30},
        'total': 280,
        'duplicate': 'M002',
        'unclear': 'M005',
        'expected_day': '2026-11-05',
        'scan_order_page': 2,
        'sha256': {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in folder.iterdir()},
    }
    (folder.parent.parent / 'baseline.json').write_text(json.dumps(baseline, ensure_ascii=False, indent=2), encoding='utf-8')
    print(f'F14 inputs ready at {folder}')


def prepare_archive(root):
    from PIL import Image, ImageDraw

    folder = root / 'F08' / 'main' / 'inbox'
    first, second = folder / '来源甲', folder / '来源乙'
    first.mkdir(parents=True, exist_ok=True)
    second.mkdir(parents=True, exist_ok=True)
    (first / '空目录').mkdir(exist_ok=True)
    for group, directory in enumerate([first, second], 1):
        for number, name in enumerate(['发票.pdf', f'票据{group}.pdf'], 1):
            image = Image.new('RGB', (400, 300), 'white')
            ImageDraw.Draw(image).text((25, 30), f'SYNTHETIC INVOICE {group}-{number}', fill='black')
            image.save(directory / name, 'PDF')
        for number, name in enumerate(['照片🌤️.jpg', f'风景{group}.jpg'], 1):
            image = Image.new('RGB', (160, 120), (40 * group, 60 * number, 100))
            ImageDraw.Draw(image).text((10, 10), f'PHOTO {group}-{number}', fill='white')
            image.save(directory / name, 'JPEG')
        for name in ['说明.txt', f'记录{group}.txt']:
            (directory / name).write_text(f'合成测试文件\n来源{group}\n{name}\n', encoding='utf-8')
    baseline = {
        'files': {str(p.relative_to(folder)): hashlib.sha256(p.read_bytes()).hexdigest()
                  for p in sorted(folder.rglob('*')) if p.is_file()},
        'empty_directories': ['来源甲/空目录'],
    }
    assert len(baseline['files']) == 12
    (folder.parent.parent / 'baseline.json').write_text(json.dumps(baseline, ensure_ascii=False, indent=2), encoding='utf-8')
    print('F08 inputs ready')


if __name__ == '__main__':
    import sys
    root = Path(sys.argv[1]).resolve()
    prepare_sales(root)
    prepare_mixed_orders(root)
    prepare_archive(root)
