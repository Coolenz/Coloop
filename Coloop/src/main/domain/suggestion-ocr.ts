import { z } from 'zod'

const rectSchema = z
  .tuple([z.number(), z.number(), z.number(), z.number()])
  .refine(([left, top, right, bottom]) => right > left && bottom > top)
const itemSchema = z.object({
  text: z.string(),
  confidence: z.number().min(0).max(100).optional(),
  rect: rectSchema,
})
type Item = z.infer<typeof itemSchema>
export interface SuggestionOcrSource {
  ocr_text: string
  ocr_items?: unknown
  window_rect?: unknown
  editable_rect?: unknown
}

const menuLabels = new Set(
  '文件 编辑 查看 插入 格式 工具 窗口 帮助 开始 布局 审阅 引用 视图 File Edit View Insert Format Tools Window Help Home Layout Review References'
    .toLowerCase()
    .split(' '),
)

function cleanLine(text: string) {
  return text
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B\uFEFF]/g, '')
    .replace(/[^\S\r\n]+/g, ' ')
    .trim()
}

function isFragment(text: string) {
  return !text || /^[|¦_~`^•●○·…─━│┊┆\uFFFD]+$/u.test(text)
}

function overlaps(a: Item['rect'], b: Item['rect']) {
  const width = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]))
  const height = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]))
  const smallerArea = Math.min((a[2] - a[0]) * (a[3] - a[1]), (b[2] - b[0]) * (b[3] - b[1]))
  return (width * height) / smallerArea >= 0.8
}

/** Suggestion-only cleanup. Coordinates and recognition text remain available
 * in the original observation for execution, guards and independent readback.
 * Score filtering follows RapidOCR's filter_by_text_score convention (0..1).
 * Whitespace cleanup follows the conservative part of Unstructured's cleaners.
 */
export function cleanSuggestionOcr(view: SuggestionOcrSource): string {
  const parsed = z.array(itemSchema).safeParse(view.ocr_items)
  // Older/manual observations may contain partial or stale item metadata.
  // Only use boxes to filter text when they describe the complete source.
  if (
    !parsed.success ||
    !parsed.data.length ||
    cleanLine(parsed.data.map((item) => item.text).join(' ')).replace(/\s+/g, ' ') !==
      cleanLine(view.ocr_text).replace(/\s+/g, ' ')
  )
    return view.ocr_text
      .split(/\r?\n/)
      .map(cleanLine)
      .filter((line) => !isFragment(line))
      .join('\n')

  const kept: Item[] = []
  const byText = new Map<string, Item[]>()
  for (const item of parsed.data) {
    const text = cleanLine(item.text)
    const confidence =
      item.confidence === undefined || item.confidence <= 1
        ? item.confidence
        : item.confidence / 100
    if (isFragment(text) || (confidence !== undefined && confidence < 0.5)) continue
    const previous = byText.get(text) ?? []
    if (previous.some((other) => overlaps(item.rect, other.rect))) continue
    const cleaned = { ...item, text }
    previous.push(cleaned)
    byText.set(text, previous)
    kept.push(cleaned)
  }

  const window = rectSchema.safeParse(view.window_rect)
  const editor = rectSchema.safeParse(view.editable_rect)
  const menuCandidates = kept.filter((item) => {
    if (!window.success) return false
    const [left, top, right, bottom] = item.rect
    const centerX = (left + right) / 2
    const centerY = (top + bottom) / 2
    if (
      editor.success &&
      centerX >= editor.data[0] &&
      centerX <= editor.data[2] &&
      centerY >= editor.data[1] &&
      centerY <= editor.data[3]
    )
      return false
    return (
      top >= window.data[1] &&
      bottom <= window.data[1] + Math.min(160, (window.data[3] - window.data[1]) * 0.25) &&
      left >= window.data[0] &&
      right <= window.data[2] &&
      item.text
        .toLowerCase()
        .split(/\s+/)
        .every((word) => menuLabels.has(word))
    )
  })
  const menus = new Set(
    menuCandidates.filter((item) => {
      const centerY = (item.rect[1] + item.rect[3]) / 2
      const row = menuCandidates.filter(
        (other) =>
          Math.abs((other.rect[1] + other.rect[3]) / 2 - centerY) <=
          Math.max(3, Math.min(item.rect[3] - item.rect[1], other.rect[3] - other.rect[1]) / 2),
      )
      return new Set(row.flatMap((other) => other.text.toLowerCase().split(/\s+/))).size >= 3
    }),
  )
  return kept
    .filter((item) => !menus.has(item))
    .map((item) => item.text)
    .join('\n')
}
