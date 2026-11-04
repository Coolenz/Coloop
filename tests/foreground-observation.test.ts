import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  desktopCapturer: {},
  screen: {},
  nativeImage: {},
}))
import {
  ForegroundObservationService,
  WindowsObservationCapture,
  hasMeaningfulVisualChange,
  type ForegroundFrame,
  type ForegroundObservation,
  type ForegroundMetadata,
} from '../src/main/infrastructure/foreground-observation'
import {
  controlIndicatorSnapshotSchema,
  isActiveControlMode,
  islandAnswerSchema,
} from '../src/shared/control-indicator'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})
const meta: ForegroundMetadata = {
  window_id: '12',
  process_id: 14,
  window_rect: [0, 0, 800, 600],
  point_owner: '12',
  editable_focus: true,
  editable_runtime_id: [42, 14],
  point_target: {
    name: 'Title',
    type: 'Edit',
    rect: [20, 10, 700, 500],
    runtime_id: [42, 14],
    enabled: true,
    process_id: 14,
  },
  editable_rect: [20, 20, 700, 500],
  screen: { x: 0, y: 0, width: 1920, height: 1080 },
}
const snapshot: ForegroundObservation = {
  ...meta,
  observation_id: 'obs',
  captured_at: 1000,
  content_hash: 'hash',
  ocr_text: 'Title',
  ocr_items: [{ id: 0, text: 'Title', rect: [10, 10, 90, 30], center: [50, 20], confidence: 99 }],
  targets: [
    { id: 1, center: [50, 20], runtime_id: [42, 14], type: 'Edit', rect: [20, 10, 700, 500] },
  ],
}
const frame = {
  ...meta,
  png: Buffer.from('test'),
  fingerprint: 'frame',
  display_id: '1',
  image_origin: [0, 0],
  scale: [1, 1],
} satisfies ForegroundFrame
describe('passive foreground observation', () => {
  it('tolerates a blinking caret but detects substantive image changes', () => {
    const before = Buffer.alloc(320 * 240 * 4, 255)
    const caret = Buffer.from(before)
    for (let i = 0; i < 16; i++) caret.fill(0, i * 4, i * 4 + 3)
    expect(hasMeaningfulVisualChange(before, caret)).toBe(false)
    const changed = Buffer.from(before)
    changed.fill(0, 0, 400 * 4)
    expect(hasMeaningfulVisualChange(before, changed)).toBe(true)
  })
  it('periodically refreshes OCR for small edits tolerated by visual comparison', async () => {
    vi.useFakeTimers()
    const recognize = vi.fn(async () => snapshot)
    const onObservation = vi.fn()
    const service = new ForegroundObservationService({
      capture: async () => frame,
      recognize,
      isOcrBusy: () => false,
      canObserve: () => true,
      onObservation,
      intervalMs: 100,
      stableMs: 0,
    })
    service.start()
    await vi.advanceTimersByTimeAsync(5400)
    expect(recognize).toHaveBeenCalledTimes(2)
    expect(onObservation).toHaveBeenCalledTimes(1)
    service.dispose()
  })
  it('debounces, recognizes stable content once, and deduplicates unchanged frames', async () => {
    vi.useFakeTimers()
    const onObservation = vi.fn()
    const recognize = vi.fn(async () => snapshot)
    const service = new ForegroundObservationService({
      capture: async () => frame,
      recognize,
      isOcrBusy: () => false,
      canObserve: () => true,
      onObservation,
      intervalMs: 100,
      stableMs: 200,
    })
    service.start()
    await vi.advanceTimersByTimeAsync(200)
    expect(recognize).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(800)
    expect(recognize).toHaveBeenCalledTimes(1)
    expect(onObservation).toHaveBeenCalledTimes(1)
    service.dispose()
  })
  it('does not observe while paused or OCR is occupied, explicit request bypasses debounce', async () => {
    vi.useFakeTimers()
    let occupied = true
    const capture = vi.fn(async () => frame)
    const service = new ForegroundObservationService({
      capture,
      recognize: async () => snapshot,
      isOcrBusy: () => occupied,
      canObserve: () => true,
      onObservation: vi.fn(),
      intervalMs: 100,
    })
    service.start()
    await vi.advanceTimersByTimeAsync(200)
    expect(capture).not.toHaveBeenCalled()
    occupied = false
    service.pause()
    await vi.advanceTimersByTimeAsync(200)
    expect(capture).not.toHaveBeenCalled()
    service.resume()
    expect(await service.observeNow()).toEqual(snapshot)
    service.dispose()
  })
  it('does not emit a snapshot after pause aborts an in-flight OCR', async () => {
    vi.useFakeTimers()
    let finish!: (value: ForegroundObservation) => void
    const onObservation = vi.fn()
    const service = new ForegroundObservationService({
      capture: async () => frame,
      recognize: () =>
        new Promise((resolve) => {
          finish = resolve
        }),
      isOcrBusy: () => false,
      canObserve: () => true,
      onObservation,
      intervalMs: 100,
      stableMs: 0,
    })
    service.start()
    await vi.advanceTimersByTimeAsync(200)
    service.pause()
    finish(snapshot)
    await Promise.resolve()
    await Promise.resolve()
    expect(onObservation).not.toHaveBeenCalled()
    service.dispose()
  })
})
describe('Windows target validation and text verification', () => {
  it('keeps editor dedup stable across caret OCR noise without exporting UIA text', async () => {
    let text = '产品发布计划'
    const capture = new WindowsObservationCapture({
      recognize: async () => ({
        text,
        confidence: 99,
        durationMs: 1,
        language: 'zh',
        items: [],
        coordinateSpace: 'image_pixels',
        engine: 'RapidOCR',
      }),
    })
    vi.spyOn(capture, 'metadata').mockResolvedValue({ ...meta, editable_text: '产品发布计划' })
    const first = await capture.recognize({ ...frame, editable_text: '产品发布计划' })
    text = '产品发布计划I'
    const second = await capture.recognize({ ...frame, editable_text: '产品发布计划' })
    expect(first.content_hash).toBe(second.content_hash)
    expect(second.ocr_text).toBe('产品发布计划I')
    expect(second).not.toHaveProperty('editable_text')
  })
  const create = () => new WindowsObservationCapture({ recognize: vi.fn() })
  it('rejects changed windows and covered points, returns HID screen coordinates', async () => {
    const capture = create()
    const read = vi.spyOn(capture, 'metadata').mockResolvedValue(meta)
    expect(await capture.validate(snapshot, { action: 'click', target_id: 0 })).toMatchObject({
      allowed: true,
      center: [50, 20],
      screen: [0, 0, 1920, 1080],
    })
    read.mockResolvedValue({ ...meta, point_owner: '99' })
    expect((await capture.guard(snapshot, { action: 'click', target_id: 0 })).allowed).toBe(false)
    read.mockResolvedValue({ ...meta, window_id: '99' })
    expect((await capture.guard(snapshot, { action: 'click', target_id: 0 })).allowed).toBe(false)
  })
  it('requires editable focus and checks full insertion against pre-paste UIA text and selection', async () => {
    const capture = create()
    const read = vi.spyOn(capture, 'metadata').mockResolvedValue({
      ...meta,
      editable_text: '标题\r\n',
      selection_start: 4,
      selection_end: 4,
    })
    expect((await capture.validate(snapshot, { action: 'paste_text', target_id: 1 })).allowed).toBe(
      true,
    )
    read.mockResolvedValue({ ...meta, editable_text: '标题\r\n完整正文' })
    expect((await capture.verifyText(snapshot, '完整正文')).verified).toBe(true)
    read.mockResolvedValue({ ...meta, editable_focus: false })
    expect((await capture.validate(snapshot, { action: 'paste_text', target_id: 1 })).allowed).toBe(
      false,
    )
  })
  it('retains the original insertion baseline while focus and text settle', async () => {
    const capture = create()
    const read = vi.spyOn(capture, 'metadata').mockResolvedValue({
      ...meta, editable_text: 'before', selection_start: 6, selection_end: 6,
    })
    await capture.validate(snapshot, { action: 'paste_text', target_id: 1 })
    read.mockResolvedValue({ ...meta, window_id: '99', editable_focus: false })
    expect((await capture.verifyText(snapshot, ' after')).verified).toBe(false)
    read.mockResolvedValue({ ...meta, editable_text: 'before' })
    expect((await capture.verifyText(snapshot, ' after')).verified).toBe(false)
    read.mockResolvedValue({ ...meta, editable_text: 'before after' })
    expect((await capture.verifyText(snapshot, ' after')).verified).toBe(true)
    // A resolved baseline is single use, preventing later text from authorizing an old paste.
    expect((await capture.verifyText(snapshot, ' after')).verified).toBe(false)
  })
  it('rejects a truncated text result even if the OCR title matches', async () => {
    const capture = create()
    const read = vi
      .spyOn(capture, 'metadata')
      .mockResolvedValue({ ...meta, editable_text: '', selection_start: 0, selection_end: 0 })
    await capture.validate(snapshot, { action: 'paste_text', target_id: 1 })
    read.mockResolvedValue({ ...meta, editable_text: '完整' })
    expect((await capture.verifyText(snapshot, '完整正文')).verified).toBe(false)
  })
  it('rejects an element replacement or movement within the same window', async () => {
    const capture = create(),
      read = vi.spyOn(capture, 'metadata').mockResolvedValue(meta)
    expect((await capture.validate(snapshot, { action: 'click', target_id: 0 })).allowed).toBe(true)
    expect((await capture.guard(snapshot, { action: 'click', target_id: 0 })).allowed).toBe(true)
    read.mockResolvedValue({
      ...meta,
      point_target: { ...meta.point_target!, runtime_id: [42, 99] },
    })
    expect((await capture.guard(snapshot, { action: 'click', target_id: 0 })).allowed).toBe(false)
    read.mockResolvedValue({
      ...meta,
      point_target: { ...meta.point_target!, rect: [21, 10, 700, 500] },
    })
    expect((await capture.guard(snapshot, { action: 'click', target_id: 0 })).allowed).toBe(false)
    read.mockResolvedValue({ ...meta, point_target: undefined })
    expect((await capture.validate(snapshot, { action: 'click', target_id: 0 })).allowed).toBe(
      false,
    )
  })
  it('rejects a new button under old OCR coordinates during first validation', async () => {
    const capture = create(),
      read = vi.spyOn(capture, 'metadata').mockResolvedValue({
        ...meta,
        point_target: { ...meta.point_target!, type: 'Button', name: 'Different button' },
      })
    expect((await capture.validate(snapshot, { action: 'click', target_id: 0 })).allowed).toBe(
      false,
    )
    read.mockResolvedValue({
      ...meta,
      point_target: { ...meta.point_target!, type: 'Button', name: 'Title' },
    })
    expect((await capture.validate(snapshot, { action: 'click', target_id: 0 })).allowed).toBe(true)
    read.mockResolvedValue({ ...meta, editable_runtime_id: [42, 99] })
    expect((await capture.validate(snapshot, { action: 'paste', target_id: 1 })).allowed).toBe(
      false,
    )
  })
  it('binds paste to the focused edit runtime ID and independently rechecks completion text', async () => {
    const capture = create(),
      read = vi.spyOn(capture, 'metadata').mockResolvedValue({ ...meta, editable_text: '正文' })
    expect((await capture.validate(snapshot, { action: 'paste', target_id: 1 })).allowed).toBe(true)
    read.mockResolvedValue({ ...meta, editable_runtime_id: [42, 99], editable_text: '正文' })
    expect((await capture.guard(snapshot, { action: 'paste', target_id: 1 })).allowed).toBe(false)
    expect((await capture.verifyCurrentText(snapshot, '正文')).verified).toBe(true)
    read.mockResolvedValue({ ...meta, editable_text: '被删除' })
    expect((await capture.verifyCurrentText(snapshot, '正文')).verified).toBe(false)
  })
})
describe('target window restoration', () => {
  it('does not block submission when no target exists or activation fails', async () => {
    const capture = new WindowsObservationCapture({ recognize: vi.fn() })
    await expect(capture.restoreTarget()).resolves.toBe(false)
    const read = vi.spyOn(capture, 'metadata').mockResolvedValue(meta)
    await capture.rememberTarget()
    read.mockRejectedValue(new Error('observer stopped'))
    await expect(capture.restoreTarget()).resolves.toBe(false)
  })
  it('restores the remembered window with its process identity', async () => {
    const capture = new WindowsObservationCapture({ recognize: vi.fn() })
    const read = vi.spyOn(capture, 'metadata').mockResolvedValue(meta)
    await capture.rememberTarget()
    await capture.restoreTarget()
    expect(read).toHaveBeenLastCalledWith(undefined, '12', false, 14)
  })
  it('rejects a reused handle belonging to another process', async () => {
    const capture = new WindowsObservationCapture({ recognize: vi.fn() })
    const read = vi.spyOn(capture, 'metadata').mockResolvedValue(meta)
    await capture.rememberTarget()
    read.mockResolvedValue({ ...meta, process_id: 99 })
    await expect(capture.restoreTarget()).resolves.toBe(false)
    read.mockResolvedValue({ ...meta, window_id: '99' })
    await expect(capture.restoreTarget()).resolves.toBe(false)
  })
  it('keeps the restoration identity stable during concurrent observation', async () => {
    const capture = new WindowsObservationCapture({ recognize: vi.fn() })
    const read = vi.spyOn(capture, 'metadata').mockResolvedValue(meta)
    await capture.rememberTarget()
    let finish!: (value: ForegroundMetadata) => void
    read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const restoring = capture.restoreTarget()
    read.mockResolvedValue({ ...meta, window_id: '99', process_id: 99 })
    await capture.rememberTarget()
    finish(meta)
    await expect(restoring).resolves.toBe(true)
  })
})

describe('island protocol', () => {
  it('distinguishes suggestions from active control and bounds user answers', () => {
    expect(isActiveControlMode('suggestion')).toBe(false)
    expect(isActiveControlMode('question')).toBe(true)
    expect(
      controlIndicatorSnapshotSchema.parse({
        mode: 'suggestion',
        content: '建议正文',
        suggestionId: 's1',
      }).content,
    ).toBe('建议正文')
    expect(
      islandAnswerSchema.safeParse({ taskId: 't', questionId: 'q', answer: '  ' }).success,
    ).toBe(false)
  })
})

if (process.env.COLOOP_FOREGROUND_NATIVE_SMOKE === '1')
  describe('actual Windows foreground read-only smoke', () => {
    it('reads real foreground identity and screen without injecting input', async () => {
      const capture = new WindowsObservationCapture({ recognize: vi.fn() })
      try {
        const row = await capture.metadata()
        expect(Number(row.window_id)).toBeGreaterThanOrEqual(0)
        expect(row.screen.width).toBeGreaterThan(0)
        expect(row.window_rect).toHaveLength(4)
      } finally {
        capture.dispose()
      }
    }, 15000)
  })


describe('independent control state completion', () => {
  const condition = { center: [50, 20], runtime_id: [42, 14], property: 'checked', value: true }
  it('reads UIA state and rejects changed identity, missing state and indeterminate state', async () => {
    const capture = new WindowsObservationCapture({ recognize: vi.fn() })
    const read = vi.spyOn(capture, 'metadata').mockResolvedValue({
      ...meta, point_target: { ...meta.point_target!, checked: true },
    })
    expect(await capture.verifyControlState(snapshot, condition)).toMatchObject({ verified: true, observable: true })
    expect(read).toHaveBeenLastCalledWith([50, 20])
    read.mockResolvedValue({ ...meta, point_target: { ...meta.point_target!, checked: false } })
    expect(await capture.verifyControlState(snapshot, condition)).toMatchObject({ verified: false, observable: true })
    for (const changed of [
      { ...meta, process_id: 99 },
      { ...meta, window_id: '99' },
      { ...meta, point_owner: '99' },
      { ...meta, point_target: { ...meta.point_target!, runtime_id: [42, 99], checked: true } },
      { ...meta, point_target: { ...meta.point_target!, checked: undefined } },
    ]) {
      read.mockResolvedValue(changed)
      expect(await capture.verifyControlState(snapshot, condition)).toMatchObject({ verified: false, observable: false })
    }
  })
  it('rejects malformed conditions before reading Windows state', async () => {
    const capture = new WindowsObservationCapture({ recognize: vi.fn() })
    const read = vi.spyOn(capture, 'metadata')
    for (const raw of [null, {}, { ...condition, value: 'true' },
      { ...condition, center: [NaN, 0] }, { ...condition, property: 'enabled' },
      { ...condition, runtime_id: [] }, { ...condition, extra: true }]) {
      expect((await capture.verifyControlState(snapshot, raw)).verified).toBe(false)
    }
    expect(read).not.toHaveBeenCalled()
  })
})
