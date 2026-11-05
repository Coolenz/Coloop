import { expect, it } from 'vitest'
import { parseCsv } from '../src/main/domain/csv'

it('retains physical line numbers for CSV records and escaped quoted fields', () => {
  expect(
    parseCsv('订单号,说明\r\nM001,"含,逗号"\r\nM002,"跨\r\n行"\r\nM003,"双""引号"', ','),
  ).toEqual([
    { cells: ['订单号', '说明'], start_line: 1, end_line: 1 },
    { cells: ['M001', '含,逗号'], start_line: 2, end_line: 2 },
    { cells: ['M002', '跨\r\n行'], start_line: 3, end_line: 4 },
    { cells: ['M003', '双"引号'], start_line: 5, end_line: 5 },
  ])
})
it('preserves empty values, blank records and delimiter choices', () => {
  expect(parseCsv('A;B\n1;\n\n2;3\n', ';').map((row) => row.cells)).toEqual([
    ['A', 'B'],
    ['1', ''],
    [''],
    ['2', '3'],
  ])
  expect(parseCsv('', ',')).toEqual([])
})
it('rejects malformed quoted fields instead of silently changing values', () => {
  expect(() => parseCsv('"unclosed', ',')).toThrow('CSV_QUOTE_NOT_CLOSED')
  expect(() => parseCsv('"closed"trailing', ',')).toThrow('CSV_QUOTE_SYNTAX_INVALID')
})
