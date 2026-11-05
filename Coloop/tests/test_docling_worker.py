"""Adapter boundary tests; real Docling conversion runs with --real."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('docling_worker',
    Path(__file__).resolve().parents[1] / 'resources/docling-worker.py')
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class DoclingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.source = self.root / 'source.pdf'
        self.source.write_bytes(b'%PDF-test')
        self.request = {'path': str(self.source), 'cache_directory': str(self.root / 'cache'),
                        'model_directory': str(self.root / 'models')}

    def tearDown(self):
        self.temp.cleanup()

    def block(self, text='real source'):
        return {'id': 'block:0', 'source_id': '#/texts/0', 'kind': 'text', 'text': text,
                'text_offset': 0, 'pages': [1], 'provenance': [{'page': 1}]}

    def test_cache_key_binds_source_and_parser_version(self):
        with patch.object(worker, 'parser_version', return_value='v1') as version, \
                patch.object(worker, 'convert', return_value=[self.block()]) as convert:
            first = worker.handle(self.request)
            self.assertFalse(first['cache_hit'])
            second = worker.handle(self.request)
            self.assertTrue(second['cache_hit'])
            self.assertEqual(convert.call_count, 1)
            version.return_value = 'v2'
            self.assertFalse(worker.handle(self.request)['cache_hit'])
            self.source.write_bytes(b'%PDF-changed')
            self.assertFalse(worker.handle(self.request)['cache_hit'])
            self.assertEqual(convert.call_count, 3)

    def test_source_changed_during_conversion_not_cached(self):
        def convert(*_):
            self.source.write_bytes(b'%PDF-other')
            return [self.block()]
        with patch.object(worker, 'parser_version', return_value='v1'), patch.object(worker, 'convert', side_effect=convert):
            with self.assertRaisesRegex(worker.AdapterError, 'SOURCE_CHANGED'):
                worker.handle(self.request)
        self.assertEqual(list((self.root / 'cache').glob('*.json')), [])

    def test_ranges_are_bounded_and_progress(self):
        with patch.object(worker, 'parser_version', return_value='v1'), \
                patch.object(worker, 'convert', return_value=[self.block('中' * 2000), {**self.block('后续'), 'id': 'block:1'}]):
            first = worker.handle({**self.request, 'max_characters': 2000})
            self.assertEqual(first['next_block'], 1)
            self.assertTrue(first['truncated'])
            second = worker.handle({**self.request, 'start_block': 1})
            self.assertEqual(second['blocks'][0]['text'], '后续')
            self.assertFalse(second['truncated'])

    def test_reject_urls_relative_paths_and_excess_ranges(self):
        for value in ('https://example.com/a.pdf', 'file.pdf'):
            with self.assertRaises(worker.AdapterError):
                worker.handle({**self.request, 'path': value})
        for value in (0, 41, True):
            with self.assertRaises(worker.AdapterError):
                worker.handle({**self.request, 'max_blocks': value})

    def test_corrupt_cache_rebuilds(self):
        with patch.object(worker, 'parser_version', return_value='v1'), \
                patch.object(worker, 'convert', return_value=[self.block()]) as convert:
            worker.handle(self.request)
            next((self.root / 'cache').glob('*.json')).write_text('broken')
            self.assertFalse(worker.handle(self.request)['cache_hit'])
            self.assertEqual(convert.call_count, 2)


@unittest.skipUnless(os.environ.get('COLOOP_DOCLING_REAL') == '1', 'Set COLOOP_DOCLING_REAL=1 for installed model checks')
class RealDoclingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.repo = Path(__file__).resolve().parents[1]
        evidence = cls.repo / '.cache/docling/verification'
        evidence.mkdir(parents=True, exist_ok=True)
        cls.root = Path(tempfile.mkdtemp(prefix='real-', dir=evidence))

    def invoke(self, path, **options):
        request = {'path': str(path), 'cache_directory': str(self.root / 'cache'),
                   'model_directory': str(self.repo / '.cache/docling/models'), **options}
        process = subprocess.run([sys.executable, '-I', '-X', 'utf8', '-u', str(self.repo / 'resources/docling-worker.py')],
                                 input=json.dumps(request), text=True, encoding='utf-8',
                                 capture_output=True, timeout=180)
        (self.root / (path.name + '.stderr.txt')).write_text(process.stderr, encoding='utf-8')
        self.assertEqual(process.returncode, 0, process.stderr[-1000:])
        result = json.loads(process.stdout)
        (self.root / (path.name + '.result.json')).write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
        self.assertTrue(result.get('ok'), result)
        self.assertEqual(result['source_sha256'], worker.digest(path))
        return result

    def test_real_docx_table_unicode_pagination_and_cache(self):
        from docx import Document
        path = self.root / 'orders.docx'
        document = Document()
        document.add_heading('订单资料核验', 0)
        document.add_paragraph('来源保持在本地。订单编号 ORDER-123。')
        table = document.add_table(rows=3, cols=2)
        for row, values in zip(table.rows, [('商品', '金额'), ('支架', '120.50'), ('线缆', '80.00')]):
            for cell, value in zip(row.cells, values):
                cell.text = value
        document.save(path)
        first = self.invoke(path, max_blocks=2)
        self.assertFalse(first['cache_hit'])
        self.assertTrue(first['truncated'])
        rest = self.invoke(path, start_block=first['next_block'])
        self.assertTrue(rest['cache_hit'])
        blocks = first['blocks'] + rest['blocks']
        self.assertIn('ORDER-123', ''.join(block['text'] for block in blocks))
        cells = [block for block in blocks if block['kind'] == 'table_cell']
        self.assertEqual(len(cells), 6)
        self.assertTrue(any(cell['text'] == '支架' and cell['table']['row'] == 1 for cell in cells))
        self.assertTrue(all(cell['pages'] == [] for cell in cells), 'DOCX has no fabricated page numbers')

    def test_real_two_page_scanned_pdf_ocr_and_page_provenance(self):
        from PIL import Image, ImageDraw, ImageFont
        path = self.root / 'scanned-orders.pdf'
        font = ImageFont.truetype('C:/Windows/Fonts/arial.ttf', 32)
        images = []
        for page in (1, 2):
            image = Image.new('RGB', (1000, 1200), 'white')
            draw = ImageDraw.Draw(image)
            draw.text((80, 80), f'Coloop orders page {page}', font=font, fill='black')
            for y, values in zip((220, 310, 400), [('Order', 'Amount'), (f'ORDER-{page}01', '120.50'), (f'ORDER-{page}02', '80.00')]):
                draw.text((100, y), values[0], font=font, fill='black')
                draw.text((600, y), values[1], font=font, fill='black')
            for y in (200, 290, 380, 470):
                draw.line((80, y, 900, y), fill='black', width=2)
            for x in (80, 550, 900):
                draw.line((x, 200, x, 470), fill='black', width=2)
            images.append(image)
        images[0].save(path, 'PDF', save_all=True, append_images=images[1:], resolution=100)
        result = self.invoke(path, max_blocks=40, max_characters=16000)
        self.assertFalse(result['cache_hit'])
        self.assertEqual({page for block in result['blocks'] for page in block['pages']}, {1, 2})
        text = ''.join(block['text'] for block in result['blocks'])
        self.assertIn('120.50', text)
        self.assertIn('80.00', text)
        self.assertTrue(any(block['kind'] == 'table_cell' for block in result['blocks']))
        self.assertTrue(self.invoke(path)['cache_hit'])


if __name__ == '__main__':
    unittest.main()
