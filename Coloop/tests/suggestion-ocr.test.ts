import { describe, expect, it } from 'vitest'
import { cleanSuggestionOcr } from '../src/main/domain/suggestion-ocr'
import { suggestionContent } from '../src/main/domain/proactive-suggestion'

const item = (text: string, left = 100, top = 200, confidence = 0.95) => ({
  text,
  confidence,
  rect: [left, top, left + 100, top + 20],
})
const source = (items: ReturnType<typeof item>[]) => ({
  ocr_text: items.map((row) => row.text).join('\n'),
  ocr_items: items,
  window_rect: [0, 0, 1000, 800],
})

describe('local suggestion OCR cleanup', () => {
  it('removes control characters, zero-width spaces and icon-only lines', () => {
    const text =
      '  项目\u200B交接\u0000  \n||\n • \n请\t确认收到资料\n\n金额 ¥1,200.00\n-\n%\n≤\n👩‍💻'
    expect(cleanSuggestionOcr({ ocr_text: text })).toBe(
      '项目交接\n请 确认收到资料\n金额 ¥1,200.00\n-\n%\n≤\n👩‍💻',
    )
  })
  it('filters low-confidence lines in both probability and percentage formats', () => {
    const view = source([
      item('低置信碎片', 0, 200, 0.2),
      item('另一碎片', 0, 230, 20),
      item('订单编号 A-001', 0, 260, 0.5),
      item('金额 ¥1,200.00', 0, 290, 99),
    ])
    expect(cleanSuggestionOcr(view)).toBe('订单编号 A-001\n金额 ¥1,200.00')
  })
  it('deduplicates overlapping detections and retains repeated table values elsewhere', () => {
    const view = source([
      item('1200.00', 100, 200),
      item('1200.00', 101, 201),
      item('1200.00', 100, 240),
      item('1200.00', 300, 200),
    ])
    expect(cleanSuggestionOcr(view).split('\n')).toEqual(['1200.00', '1200.00', '1200.00'])
    expect(view.ocr_items).toHaveLength(4)
  })
  it('removes a top menu cluster and retains business buttons and body text', () => {
    const view = source([
      item('文件', 10, 20),
      item('编辑', 120, 20),
      item('查看', 230, 20),
      item('发送', 340, 20),
      item('请确认收到项目资料', 100, 200),
      item('文件', 100, 240),
      item('编辑', 100, 280),
    ])
    expect(cleanSuggestionOcr(view)).toBe('发送\n请确认收到项目资料\n文件\n编辑')
  })
  it('keeps menu-like words in an editor or without reliable window coordinates', () => {
    const view = source([item('文件 编辑 查看', 10, 20), item('正文', 100, 200)])
    expect(cleanSuggestionOcr({ ...view, editable_rect: [0, 0, 1000, 800] })).toBe(view.ocr_text)
    expect(cleanSuggestionOcr({ ...view, window_rect: undefined })).toBe(view.ocr_text)
    expect(cleanSuggestionOcr(view)).toBe('正文')
  })
  it('preserves legacy text if item metadata is missing, malformed or partial', () => {
    const text = '文件\n1200\n1200\n正文中的重要事项'
    for (const items of [undefined, [], [{ text: 'missing rect' }], [item('文件')]])
      expect(cleanSuggestionOcr({ ocr_text: text, ocr_items: items })).toBe(text)
  })
  it('cleans before budgeting so body text after menu noise reaches the model', () => {
    const view = source([
      item('文件', 10, 20),
      item('编辑', 120, 20),
      item('查看', 230, 20),
      item('||||'.repeat(1000), 10, 80),
      item('请回复确认收件', 100, 200),
    ])
    const request = JSON.parse(
      suggestionContent({ observation_id: 'test', window_id: '1', ...view }, 3000),
    )
    expect(request.ocr_text).toBe('请回复确认收件')
    expect(request.truncated).toBe(false)
    expect(view.ocr_text).toContain('||||')
  })
  it('clips at complete lines under the escaped JSON byte budget', () => {
    const view = {
      observation_id: 'test',
      window_id: '1',
      ocr_text: '保留完整段落😀\n'.repeat(500),
    }
    const serialized = suggestionContent(view, 3000)
    const request = JSON.parse(serialized)
    expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(3000)
    expect(request.truncated).toBe(true)
    expect(request.ocr_text.endsWith('保留完整段落😀')).toBe(true)
    expect(view.ocr_text.startsWith(request.ocr_text)).toBe(true)
  })
  it('retains a fitting Unicode prefix when the first line exceeds the budget', () => {
    const serialized = suggestionContent(
      { observation_id: 'test', window_id: '1', ocr_text: '😀\\"'.repeat(2000) },
      3000,
    )
    const request = JSON.parse(serialized)
    expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(3000)
    expect(request.ocr_text).not.toMatch(/[\uD800-\uDBFF]$/)
    expect(request.truncated).toBe(true)
  })
})
