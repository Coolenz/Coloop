import { spawn } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserWindow } from 'electron'
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
  it('keeps the same recommendation when only OCR icon noise changes', async () => {
    vi.useFakeTimers()
    let noise = '||'
    const onObservation = vi.fn()
    const onInvalidated = vi.fn()
    const service = new ForegroundObservationService({
      capture: async () => frame,
      recognize: async () => ({
        ...snapshot,
        content_hash: noise,
        ocr_text: `Title\n${noise}`,
        ocr_items: [
          ...snapshot.ocr_items,
          { id: 2, text: noise, rect: [10, 80, 90, 100], center: [50, 90], confidence: 0.9 },
        ],
      }),
      isOcrBusy: () => false,
      canObserve: () => true,
      onObservation,
      onInvalidated,
      intervalMs: 100,
      stableMs: 0,
    })
    service.start()
    await vi.advanceTimersByTimeAsync(1000)
    onInvalidated.mockClear()
    noise = '••'
    await vi.advanceTimersByTimeAsync(6000)
    expect(onObservation).toHaveBeenCalledOnce()
    expect(onInvalidated).not.toHaveBeenCalled()
    service.dispose()
  })
  it('skips blank pages without starting recommendation inference', async () => {
    vi.useFakeTimers()
    const onObservation = vi.fn()
    const service = new ForegroundObservationService({
      capture: async () => frame,
      recognize: async () => ({ ...snapshot, ocr_text: '  \n ' }),
      isOcrBusy: () => false,
      canObserve: () => true,
      onObservation,
      intervalMs: 100,
      stableMs: 0,
    })
    service.start()
    await vi.advanceTimersByTimeAsync(10000)
    expect(onObservation).not.toHaveBeenCalled()
    service.dispose()
  })
  it('waits for editing to stop even when small changes share the same visual fingerprint', async () => {
    vi.useFakeTimers()
    let currentFrame = { ...frame, editable_text: 'Title' }
    const onObservation = vi.fn()
    const service = new ForegroundObservationService({
      capture: async () => currentFrame,
      recognize: async () => snapshot,
      isOcrBusy: () => false,
      canObserve: () => true,
      onObservation,
      intervalMs: 100,
      stableMs: 800,
    })
    service.start()
    await vi.advanceTimersByTimeAsync(100)
    for (let index = 0; index < 5; index++) {
      currentFrame = { ...currentFrame, editable_text: `Typing ${index}` }
      await vi.advanceTimersByTimeAsync(500)
    }
    expect(onObservation).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1600)
    expect(onObservation).toHaveBeenCalledOnce()
    service.dispose()
  })
  it('deduplicates page text across hash jitter, window moves, switches and pauses', async () => {
    vi.useFakeTimers()
    let currentFrame = frame
    let currentSnapshot = snapshot
    const onObservation = vi.fn()
    const service = new ForegroundObservationService({
      capture: async () => currentFrame,
      recognize: async () => currentSnapshot,
      isOcrBusy: () => false,
      canObserve: () => true,
      onObservation,
      intervalMs: 100,
      stableMs: 0,
    })
    service.start()
    await vi.advanceTimersByTimeAsync(1000)
    currentSnapshot = { ...snapshot, content_hash: 'uia-focus-changed' }
    await vi.advanceTimersByTimeAsync(6000)
    currentFrame = { ...frame, window_rect: [20, 20, 820, 620] }
    await vi.advanceTimersByTimeAsync(6000)
    currentFrame = { ...frame, window_id: 'another-window' }
    await vi.advanceTimersByTimeAsync(1000)
    currentFrame = frame
    service.pause()
    service.resume()
    await vi.advanceTimersByTimeAsync(60000)
    expect(onObservation).toHaveBeenCalledOnce()
    service.dispose()
  })
  it('recommends unchanged content again after a task interrupts passive observation', async () => {
    vi.useFakeTimers()
    const onObservation = vi.fn()
    const service = new ForegroundObservationService({
      capture: async () => frame,
      recognize: async () => snapshot,
      isOcrBusy: () => false,
      canObserve: () => true,
      onObservation,
      intervalMs: 100,
      stableMs: 0,
      minRecommendationIntervalMs: 5000,
    })
    service.start()
    await vi.advanceTimersByTimeAsync(1000)
    expect(onObservation).toHaveBeenCalledOnce()
    service.pause('task')
    await vi.advanceTimersByTimeAsync(6000)
    service.resume('task')
    await vi.advanceTimersByTimeAsync(6000)
    expect(onObservation).toHaveBeenCalledTimes(2)
    service.dispose()
  })
  it('rate limits changing content and eventually submits the latest page', async () => {
    vi.useFakeTimers()
    let currentSnapshot = snapshot
    const onObservation = vi.fn()
    const service = new ForegroundObservationService({
      capture: async () => frame,
      recognize: async () => currentSnapshot,
      isOcrBusy: () => false,
      canObserve: () => true,
      onObservation,
      intervalMs: 100,
      stableMs: 0,
    })
    service.start()
    await vi.advanceTimersByTimeAsync(1000)
    for (let index = 0; index < 5; index++) {
      currentSnapshot = { ...snapshot, content_hash: `hash-${index}`, ocr_text: `Page ${index}` }
      await vi.advanceTimersByTimeAsync(5000)
    }
    expect(onObservation).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(10000)
    expect(onObservation).toHaveBeenCalledTimes(2)
    expect(onObservation).toHaveBeenLastCalledWith(currentSnapshot)
    service.dispose()
  })
  it('preserves retry limits through repeated invalidation and duplicate retry callbacks', async () => {
    vi.useFakeTimers()
    let sequence = 0
    const onObservation = vi.fn((view: ForegroundObservation) => {
      service.retryObservation(view.observation_id)
      service.retryObservation(view.observation_id)
    })
    const service = new ForegroundObservationService({
      capture: async () => frame,
      recognize: async () => ({ ...snapshot, observation_id: `retry-${++sequence}` }),
      isOcrBusy: () => false,
      canObserve: () => true,
      onObservation,
      intervalMs: 100,
      stableMs: 0,
    })
    service.start()
    await vi.advanceTimersByTimeAsync(1000)
    for (let index = 0; index < 50; index++) {
      service.invalidate()
      await vi.advanceTimersByTimeAsync(5000)
    }
    expect(onObservation).toHaveBeenCalledTimes(4)
    service.dispose()
  })
  it('tolerates a blinking caret but detects substantive image changes', () => {
    const before = Buffer.alloc(320 * 240 * 4, 255)
    const caret = Buffer.from(before)
    for (let i = 0; i < 16; i++) caret.fill(0, i * 4, i * 4 + 3)
    expect(hasMeaningfulVisualChange(before, caret)).toBe(false)
    const changed = Buffer.from(before)
    changed.fill(0, 0, 400 * 4)
    expect(hasMeaningfulVisualChange(before, changed)).toBe(true)
  })
  it('retries deferred understanding with backoff and stops after three retries', async () => {
    vi.useFakeTimers()
    let sequence = 0
    const onObservation = vi.fn(async (view: ForegroundObservation) => {
      service.retryObservation(view.observation_id)
    })
    const service = new ForegroundObservationService({
      capture: async () => frame,
      recognize: async () => ({ ...snapshot, observation_id: `retry-${++sequence}` }),
      isOcrBusy: () => false,
      canObserve: () => true,
      onObservation,
      intervalMs: 100,
      stableMs: 0,
    })
    service.start()
    await vi.advanceTimersByTimeAsync(200)
    expect(onObservation).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(4900)
    expect(onObservation).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(240000)
    expect(onObservation).toHaveBeenCalledTimes(4)
    service.dispose()
  })
  it('invalidates a suggestion immediately when the foreground changes', async () => {
    vi.useFakeTimers()
    const onInvalidated = vi.fn()
    let currentFrame = frame
    const service = new ForegroundObservationService({
      capture: async () => currentFrame,
      recognize: async () => snapshot,
      isOcrBusy: () => false,
      canObserve: () => true,
      onObservation: vi.fn(),
      onInvalidated,
      intervalMs: 100,
      stableMs: 800,
    })
    service.start()
    await vi.advanceTimersByTimeAsync(1000)
    onInvalidated.mockClear()
    currentFrame = { ...frame, window_id: '99', fingerprint: 'another-window' }
    await vi.advanceTimersByTimeAsync(100)
    expect(onInvalidated).toHaveBeenCalledOnce()
    service.dispose()
  })
  it('keeps a recommendation through same-window visual changes until content changes', async () => {
    vi.useFakeTimers()
    const onInvalidated = vi.fn()
    const onObservation = vi.fn()
    let currentFrame = frame
    let currentSnapshot = snapshot
    const service = new ForegroundObservationService({
      capture: async () => currentFrame,
      recognize: async () => currentSnapshot,
      isOcrBusy: () => false,
      canObserve: () => true,
      onObservation,
      onInvalidated,
      intervalMs: 100,
      stableMs: 200,
      minOcrIntervalMs: 0,
      minRecommendationIntervalMs: 0,
    })
    service.start()
    await vi.advanceTimersByTimeAsync(500)
    onInvalidated.mockClear()
    currentFrame = { ...frame, fingerprint: 'overlay-expanded' }
    await vi.advanceTimersByTimeAsync(500)
    expect(onInvalidated).not.toHaveBeenCalled()
    expect(onObservation).toHaveBeenCalledTimes(1)
    currentFrame = { ...frame, fingerprint: 'document-edited' }
    currentSnapshot = {
      ...snapshot,
      observation_id: 'new-content',
      content_hash: 'changed',
      ocr_text: 'New page',
    }
    await vi.advanceTimersByTimeAsync(100)
    expect(onInvalidated).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(400)
    expect(onInvalidated).toHaveBeenCalledOnce()
    expect(onObservation).toHaveBeenLastCalledWith(currentSnapshot)
    service.dispose()
  })
  it('keeps page understanding stable during island interaction but invalidates switched targets', async () => {
    vi.useFakeTimers()
    let interacting = false
    let currentFrame = frame
    const onInvalidated = vi.fn()
    const recognize = vi.fn(async () => snapshot)
    const service = new ForegroundObservationService({
      capture: async () => currentFrame,
      recognize,
      isOcrBusy: () => false,
      canObserve: () => true,
      isInteracting: () => interacting,
      onObservation: vi.fn(),
      onInvalidated,
      intervalMs: 100,
      stableMs: 200,
      minOcrIntervalMs: 0,
    })
    service.start()
    await vi.advanceTimersByTimeAsync(400)
    onInvalidated.mockClear()
    interacting = true
    currentFrame = { ...frame, fingerprint: 'expanded-island' }
    await vi.advanceTimersByTimeAsync(6000)
    expect(recognize).toHaveBeenCalledOnce()
    expect(onInvalidated).not.toHaveBeenCalled()
    currentFrame = { ...currentFrame, window_id: 'another-target' }
    await vi.advanceTimersByTimeAsync(100)
    expect(onInvalidated).toHaveBeenCalledOnce()
    interacting = false
    await vi.advanceTimersByTimeAsync(300)
    expect(recognize).toHaveBeenCalledTimes(2)
    service.dispose()
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
  it('keeps pending understanding while its model is busy and observes changes afterward', async () => {
    vi.useFakeTimers()
    let modelBusy = false
    let currentFrame = frame
    const onInvalidated = vi.fn()
    const capture = vi.fn(async () => currentFrame)
    const onObservation = vi.fn(() => {
      modelBusy = true
    })
    const service = new ForegroundObservationService({
      capture,
      recognize: async () => snapshot,
      isOcrBusy: () => false,
      canObserve: () => !modelBusy,
      onObservation,
      onInvalidated,
      intervalMs: 100,
      stableMs: 0,
    })
    service.start()
    await vi.advanceTimersByTimeAsync(200)
    expect(onObservation).toHaveBeenCalledOnce()
    const captures = capture.mock.calls.length
    onInvalidated.mockClear()
    await vi.advanceTimersByTimeAsync(30000)
    expect(capture).toHaveBeenCalledTimes(captures)
    expect(onInvalidated).not.toHaveBeenCalled()
    currentFrame = { ...frame, window_id: 'new-window', fingerprint: 'changed' }
    modelBusy = false
    await vi.advanceTimersByTimeAsync(100)
    expect(onInvalidated).toHaveBeenCalledOnce()
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
  it('keeps native IDs stable across OCR noise and control reordering without sharing OCR IDs', async () => {
    let noise = false
    const item = {
      text: '标签',
      confidence: 99,
      rect: [10, 100, 30, 120],
      center: [20, 110],
      box: [
        [10, 100],
        [30, 100],
        [30, 120],
        [10, 120],
      ],
    }
    const capture = new WindowsObservationCapture({
      recognize: async () => ({
        text: '标签',
        confidence: 99,
        durationMs: 1,
        language: 'zh',
        coordinateSpace: 'image_pixels',
        engine: 'RapidOCR',
        items: noise ? [item, item] : [item],
      }),
    })
    const recipient = {
      type: 'Edit',
      name: '收件人',
      source: 'win32' as const,
      runtime_id: [42, 21],
      rect: [20, 20, 300, 60],
    }
    const body = { ...recipient, name: '正文', runtime_id: [42, 22], rect: [20, 80, 300, 180] }
    const read = vi.spyOn(capture, 'metadata').mockResolvedValue({
      ...meta,
      editable_focus: false,
      editor_targets: [recipient, body],
    })
    const first = await capture.recognize({ ...frame, editable_focus: false })
    const firstTargets = first.targets as { id: number }[]
    noise = true
    read.mockResolvedValue({ ...meta, editable_focus: false, editor_targets: [body, recipient] })
    const second = await capture.recognize({ ...frame, editable_focus: false })
    const secondTargets = second.targets as { id: number }[]
    expect(secondTargets.map((target) => target.id)).toEqual([
      firstTargets[1].id,
      firstTargets[0].id,
    ])
    expect(
      secondTargets.every((target) => !second.ocr_items.some((ocr) => ocr.id === target.id)),
    ).toBe(true)
    read.mockResolvedValue({
      ...meta,
      window_id: '99',
      editable_focus: false,
      editor_targets: [body],
    })
    const other = await capture.recognize({ ...frame, window_id: '99', editable_focus: false })
    expect((other.targets[0] as { id: number }).id).not.toBe(firstTargets[1].id)
  })
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
  it('exports observed toggle and selection states and detects changes with unchanged OCR', async () => {
    const capture = new WindowsObservationCapture({
      recognize: async () => ({
        text: 'Enable sync\nFirst item',
        confidence: 99,
        durationMs: 1,
        language: 'en',
        items: [],
        coordinateSpace: 'image_pixels',
        engine: 'RapidOCR',
      }),
    })
    const checkbox = {
      name: 'Enable sync',
      type: 'CheckBox',
      source: 'uia' as const,
      runtime_id: [42, 21],
      rect: [20, 40, 160, 70],
      checked: false,
    }
    const item = {
      name: 'First item',
      type: 'ListItem',
      source: 'win32' as const,
      runtime_id: [42, 22, 0],
      rect: [20, 80, 160, 100],
      selected: false,
    }
    const read = vi.spyOn(capture, 'metadata').mockResolvedValue({
      ...meta,
      editable_focus: false,
      control_targets: [checkbox, item],
    })
    const before = await capture.recognize({ ...frame, editable_focus: false })
    expect(before.targets).toEqual([
      expect.objectContaining({ ...checkbox, id: 1_000_000, center: [90, 55] }),
      expect.objectContaining({ ...item, id: 1_000_001, center: [90, 90] }),
    ])
    read.mockResolvedValue({
      ...meta,
      editable_focus: false,
      control_targets: [{ ...checkbox, checked: true }, item],
    })
    const toggled = await capture.recognize({ ...frame, editable_focus: false })
    expect(toggled.ocr_text).toBe(before.ocr_text)
    expect(toggled.content_hash).not.toBe(before.content_hash)
    read.mockResolvedValue({
      ...meta,
      editable_focus: false,
      control_targets: [
        { ...checkbox, checked: true },
        { ...item, selected: true },
      ],
    })
    const selected = await capture.recognize({ ...frame, editable_focus: false })
    expect(selected.content_hash).not.toBe(toggled.content_hash)
    expect(selected.targets[1]).toMatchObject({ selected: true, runtime_id: item.runtime_id })
  })
  const create = () => new WindowsObservationCapture({ recognize: vi.fn() })
  it('detects page changes outside a focused address bar whose text is unchanged', async () => {
    let text = 'First page content'
    const capture = new WindowsObservationCapture({
      recognize: async () => ({
        text,
        confidence: 99,
        durationMs: 1,
        language: 'en',
        coordinateSpace: 'image_pixels',
        engine: 'RapidOCR',
        items: [
          {
            text,
            confidence: 99,
            rect: [10, 200, 300, 230],
            center: [155, 215],
            box: [
              [10, 200],
              [300, 200],
              [300, 230],
              [10, 230],
            ],
          },
        ],
      }),
    })
    vi.spyOn(capture, 'metadata').mockResolvedValue({
      ...meta,
      editable_rect: [0, 0, 800, 50],
      editable_text: 'example.test',
    })
    const first = await capture.recognize(frame)
    text = 'Changed page content'
    const second = await capture.recognize(frame)
    expect(second.content_hash).not.toBe(first.content_hash)
    expect(second).not.toHaveProperty('editable_text')
  })
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
  it.each([
    [{ window_id: '99' }, 'same'],
    [{ point_owner: '99' }, 'inside'],
    [{ point_target: { ...meta.point_target!, enabled: false } }, 'elementValid'],
    [{ point_target: { ...meta.point_target!, runtime_id: [42, 99] } }, 'observedPointMatches'],
  ] as [Partial<ForegroundMetadata>, string][])(
    'explains denied editor focus clicks without exposing target contents: %j',
    async (changed, failed) => {
      const capture = create()
      vi.spyOn(capture, 'metadata').mockResolvedValue({ ...meta, ...changed })
      const result = await capture.validate(snapshot, { action: 'click', target_id: 1 })
      expect(result.allowed).toBe(false)
      expect(result.checks).toHaveProperty(failed, false)
      expect(Object.values(result.checks).every((value) => typeof value === 'boolean')).toBe(true)
      expect(Object.keys(result.checks)).toEqual([
        'same',
        'inside',
        'elementValid',
        'focusValid',
        'observedPointMatches',
        'observedFocusMatches',
        'identityMatches',
        'assistantAllowed',
      ])
      expect(JSON.stringify(result.checks)).not.toContain('Title')
    },
  )
  it('separates missing focus from missing guard identity in denied input checks', async () => {
    const capture = create()
    const read = vi.spyOn(capture, 'metadata').mockResolvedValue({ ...meta, editable_focus: false })
    expect(await capture.validate(snapshot, { action: 'paste', target_id: 1 })).toMatchObject({
      allowed: false,
      checks: { focusValid: false, observedFocusMatches: true, identityMatches: true },
    })
    read.mockResolvedValue(meta)
    expect(await capture.guard(snapshot, { action: 'paste', target_id: 1 })).toMatchObject({
      allowed: false,
      checks: { focusValid: true, observedFocusMatches: true, identityMatches: false },
    })
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
  it('binds application hotkeys to the observed window without requiring a text editor', async () => {
    const capture = create()
    const read = vi.spyOn(capture, 'metadata').mockResolvedValue({
      ...meta,
      editable_focus: false,
      editable_runtime_id: undefined,
    })
    const action = { action: 'hotkey', target_id: 0, keys: 'CTRL+O' }
    expect((await capture.guard(snapshot, action)).allowed).toBe(false)
    expect((await capture.validate(snapshot, action)).allowed).toBe(true)
    expect((await capture.guard(snapshot, action)).allowed).toBe(true)
    expect((await capture.validate(snapshot, { action: 'paste', target_id: 0 })).allowed).toBe(
      false,
    )
    read.mockResolvedValue({ ...meta, window_id: 'other' })
    expect((await capture.guard(snapshot, action)).allowed).toBe(false)
    read.mockResolvedValue({ ...meta, process_id: 99 })
    expect((await capture.guard(snapshot, action)).allowed).toBe(false)
    read.mockResolvedValue({ ...meta, point_owner: 'covered' })
    expect((await capture.guard(snapshot, action)).allowed).toBe(false)
  })
  it('retains the original insertion baseline while focus and text settle', async () => {
    const capture = create()
    const read = vi.spyOn(capture, 'metadata').mockResolvedValue({
      ...meta,
      editable_text: 'before',
      selection_start: 6,
      selection_end: 6,
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
    expect((await capture.verifyCurrentText(snapshot, '正文')).verified).toBe(false)
    const fresh = { ...snapshot, editable_runtime_id: [42, 99] }
    expect((await capture.verifyCurrentText(fresh, '正文')).verified).toBe(true)
    read.mockResolvedValue({ ...meta, editable_text: '被删除' })
    expect((await capture.verifyCurrentText(snapshot, '正文')).verified).toBe(false)
  })
})
describe('whole draft reads without selection offsets', () => {
  const placeholder: NonNullable<ForegroundMetadata['editable_placeholder']> = {
    kind: 'prosemirror',
    patterns_match: true,
    text_matches_name: true,
    document_child_count: 0,
    raw_children_complete: true,
    subtree_matches_placeholder: true,
    stable: true,
    child: {
      type: 'ControlType.Group',
      class_name: 'placeholder',
      name_empty: true,
      content: false,
      control: false,
      focusable: false,
      focused: false,
      has_children: true,
      has_value: false,
      has_text: false,
    },
  }
  it('reads an exact multiline draft while readEditor still rejects unavailable selection', async () => {
    const capture = new WindowsObservationCapture({ recognize: vi.fn() })
    const text = '[Coloop Auto Agent Work:123]\n中文\nCODE \n'
    vi.spyOn(capture, 'metadata').mockResolvedValue({ ...meta, editable_text: text })
    await expect(capture.readDraft(snapshot, 1)).resolves.toEqual({ text })
    await expect(capture.readEditor(snapshot, 1)).rejects.toThrow('EDITOR_BINDING_CHANGED')
  })
  it.each([
    [{ editable_runtime_id: [42, 99] }, ['targetRuntime', 'snapshotRuntime']],
    [{ editable_rect: [20, 20, 700, 501] }, ['editorRect']],
    [{ editable_focus: false }, ['focused']],
  ] as [Partial<ForegroundMetadata>, string[]][])(
    'reports only boolean binding facts when the editor changes after successful draft reads: %j',
    async (changed, failed) => {
      const capture = new WindowsObservationCapture({ recognize: vi.fn() })
      const text = '[Coloop Auto Agent Work:123] private draft text'
      const read = vi.spyOn(capture, 'metadata').mockResolvedValue({ ...meta, editable_text: text })
      await expect(capture.readDraft(snapshot, 1)).resolves.toEqual({ text })
      await expect(capture.readDraft(snapshot, 1)).resolves.toEqual({ text })
      read.mockResolvedValue({ ...meta, editable_text: text, ...changed })
      const error = await capture.readDraft(snapshot, 1).catch((error: unknown) => error)
      expect(error).toMatchObject({
        message: 'EDITOR_BINDING_CHANGED',
        diagnostics: { category: 'editor_binding' },
      })
      const diagnostics = (error as { diagnostics: { checks: Record<string, unknown> } })
        .diagnostics
      expect(Object.values(diagnostics.checks).every((value) => typeof value === 'boolean')).toBe(
        true,
      )
      expect(Object.keys(diagnostics.checks).filter((key) => !diagnostics.checks[key])).toEqual(
        failed,
      )
      expect(JSON.stringify(diagnostics)).not.toContain(text)
      expect(JSON.stringify(diagnostics)).not.toContain('Title')
      expect(diagnostics.checks).toMatchObject({
        window: true,
        process: true,
        windowRect: true,
        textReadable: true,
      })
    },
  )
  it('allows only anchored editor height changes for scoped exact paste verification', async () => {
    vi.useFakeTimers()
    const capture = new WindowsObservationCapture({ recognize: vi.fn() })
    const text = '[Coloop Auto Agent Work:123]\n中文\nCODE'
    const verify = async () => {
      const pending = capture.verifyCurrentText(snapshot, text, true, 'editor-height')
      await vi.runAllTimersAsync()
      return pending
    }
    const read = vi
      .spyOn(capture, 'metadata')
      .mockResolvedValue({ ...meta, editable_text: text, editable_rect: [20, 0, 700, 500] })
    expect((await verify()).verified).toBe(true)
    // Strict draft reads still require their newly captured editor rectangle.
    await expect(capture.readDraft(snapshot, 1)).rejects.toThrow('EDITOR_BINDING_CHANGED')
    read.mockResolvedValue({ ...meta, editable_text: text, editable_rect: [20, 20, 700, 550] })
    expect((await verify()).verified).toBe(true)
    for (const changed of [
      { editable_rect: [20, 10, 700, 510] },
      { editable_rect: [21, 20, 701, 500] },
      { editable_rect: [20, -1, 700, 500] },
      { window_rect: [1, 0, 801, 600] },
      { window_id: 'other' },
      { process_id: 99 },
      { editable_runtime_id: [42, 99] },
      { editable_focus: false },
      { editable_text: text + '\nuser edit' },
      { editable_text: text + '\n' },
    ]) {
      read.mockResolvedValue({ ...meta, editable_text: text, ...changed })
      expect((await verify()).verified).toBe(false)
    }
  })
  it('settles stale and unreadable UIA text to the exact draft using only reads', async () => {
    vi.useFakeTimers()
    const capture = new WindowsObservationCapture({ recognize: vi.fn() })
    const text = '[Coloop Auto Agent Work:123]\n中文\nCODE '
    const read = vi
      .spyOn(capture, 'metadata')
      .mockResolvedValueOnce({ ...meta, editable_text: 'stale placeholder' })
      .mockResolvedValueOnce({ ...meta, editable_text: undefined })
      .mockResolvedValue({
        ...meta,
        editable_text: text.replace(/\n/g, '\r\n'),
        editable_rect: [20, 0, 700, 500],
      })
    const pending = capture.verifyCurrentText(snapshot, text, true, 'editor-height')
    await vi.runAllTimersAsync()
    expect(await pending).toMatchObject({
      verified: true,
      attempts: 3,
      elapsed_ms: 150,
      checks: {
        window: true,
        process: true,
        runtime: true,
        editor_geometry: true,
        text_exact: true,
      },
    })
    expect(read).toHaveBeenCalledTimes(3)
    expect(read.mock.calls.every((args) => args.length === 0)).toBe(true)
  })
  it.each([
    { window_id: 'other' },
    { process_id: 99 },
    { editable_runtime_id: [42, 99] },
    { editable_focus: false },
    { window_rect: [0, 0, 900, 600] },
    { editable_rect: [20, 10, 700, 510] },
  ])(
    'ends settling immediately on identity change without accepting later text: %j',
    async (change) => {
      vi.useFakeTimers()
      const capture = new WindowsObservationCapture({ recognize: vi.fn() })
      const read = vi
        .spyOn(capture, 'metadata')
        .mockResolvedValueOnce({ ...meta, editable_text: 'partial' })
        .mockResolvedValueOnce({ ...meta, editable_text: 'partial', ...change })
        .mockResolvedValue({ ...meta, editable_text: 'complete' })
      const pending = capture.verifyCurrentText(snapshot, 'complete', true, 'editor-height')
      await vi.runAllTimersAsync()
      expect(await pending).toMatchObject({
        verified: false,
        failure: 'binding_changed',
        attempts: 2,
      })
      expect(read).toHaveBeenCalledTimes(2)
    },
  )
  it('bounds the total wait and returns diagnostics without draft text', async () => {
    vi.useFakeTimers()
    const capture = new WindowsObservationCapture({ recognize: vi.fn() })
    const read = vi
      .spyOn(capture, 'metadata')
      .mockResolvedValue({ ...meta, editable_text: 'private draft' })
    const pending = capture.verifyCurrentText(snapshot, 'private expected', true, 'editor-height')
    await vi.runAllTimersAsync()
    const result = await pending
    expect(result).toMatchObject({
      verified: false,
      failure: 'text_not_settled',
      elapsed_ms: 1000,
      checks: { text_readable: true, text_exact: false, focus: true },
    })
    expect(read.mock.calls.length).toBeLessThanOrEqual(15)
    expect(JSON.stringify(result)).not.toContain('private')
  })
  it('includes a stalled native read in the same deadline and ignores its late result', async () => {
    vi.useFakeTimers()
    const capture = new WindowsObservationCapture({ recognize: vi.fn() })
    let resolveRead!: (value: ForegroundMetadata) => void
    const read = vi.spyOn(capture, 'metadata').mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRead = resolve
        }),
    )
    const pending = capture.verifyCurrentText(snapshot, 'complete', true, 'editor-height')
    await vi.advanceTimersByTimeAsync(1000)
    const result = await pending
    expect(result).toMatchObject({
      verified: false,
      failure: 'metadata_timeout',
      attempts: 1,
      elapsed_ms: 1000,
    })
    resolveRead({ ...meta, editable_text: 'complete' })
    await vi.runAllTimersAsync()
    expect(result.verified).toBe(false)
    expect(read).toHaveBeenCalledTimes(1)
  })
  it('keeps ordinary exact verification single-read with no settling diagnostics', async () => {
    const capture = new WindowsObservationCapture({ recognize: vi.fn() })
    const read = vi
      .spyOn(capture, 'metadata')
      .mockResolvedValueOnce({ ...meta, editable_text: 'partial' })
      .mockResolvedValue({ ...meta, editable_text: 'complete' })
    expect(await capture.verifyCurrentText(snapshot, 'complete', true)).toEqual({
      verified: false,
      source: 'uia',
    })
    expect(read).toHaveBeenCalledTimes(1)
  })
  it.each([
    { window_id: 'other' },
    { process_id: 99 },
    { window_rect: [0, 0, 900, 700] },
    { editable_focus: false },
    { editable_runtime_id: [42, 99] },
    { editable_rect: [30, 20, 700, 500] },
    { editable_text: undefined },
  ])('rejects changed identity or unreadable text: %j', async (change) => {
    const capture = new WindowsObservationCapture({ recognize: vi.fn() })
    vi.spyOn(capture, 'metadata').mockResolvedValue({ ...meta, editable_text: 'draft', ...change })
    await expect(capture.readDraft(snapshot, 1)).rejects.toThrow('EDITOR_BINDING_CHANGED')
  })
  it('accepts only complete stable placeholder-only structure inside the leased assistant window', async () => {
    const capture = new WindowsObservationCapture({ recognize: vi.fn() })
    const live = {
      ...meta,
      process_name: 'ChatGPT',
      editable_source: 'uia' as const,
      editable_text: '和 Codex 一起工作\n',
      editable_placeholder: placeholder,
    }
    const read = vi.spyOn(capture, 'metadata').mockResolvedValue(live)
    const view = { ...snapshot, process_name: 'ChatGPT' }
    await expect(capture.readDraft(view, 1)).rejects.toThrow('EDITOR_BINDING_CHANGED')
    await capture.withAgentWindow(async () => {
      await expect(capture.readDraft(view, 1)).resolves.toEqual({ text: '' })
      // A human can type the exact placeholder text: its Group is not a placeholder.
      read.mockResolvedValue({
        ...live,
        editable_text: '和 Codex 一起工作',
        editable_placeholder: { ...placeholder, child: { ...placeholder.child, class_name: '' } },
      })
      await expect(capture.readDraft(view, 1)).resolves.toEqual({ text: '和 Codex 一起工作' })
      for (const proof of [
        undefined,
        { ...placeholder, raw_children_complete: false },
        { ...placeholder, stable: false },
        { ...placeholder, patterns_match: false },
        { ...placeholder, text_matches_name: false },
        { ...placeholder, document_child_count: 1 },
        { ...placeholder, subtree_matches_placeholder: false },
        { ...placeholder, child: { ...placeholder.child, has_children: false } },
      ]) {
        read.mockResolvedValue({ ...live, editable_placeholder: proof })
        await expect(capture.readDraft(view, 1)).resolves.toEqual({ text: live.editable_text })
      }
      read.mockResolvedValue({ ...live, editable_text: ' \n', editable_placeholder: undefined })
      await expect(capture.readDraft(view, 1)).resolves.toEqual({ text: ' \n' })
    })
  })
})
describe('target window restoration', () => {
  it('restores the observed application before input when the assistant window took focus', async () => {
    const capture = new WindowsObservationCapture({ recognize: vi.fn() })
    const read = vi
      .spyOn(capture, 'metadata')
      .mockResolvedValueOnce({ ...meta, process_name: 'ChatGPT', window_id: '99' })
      .mockResolvedValueOnce(meta)
      .mockResolvedValue({
        ...meta,
        editable_text: '',
        selection_start: undefined,
        selection_end: undefined,
      })
    expect(await capture.readEditor(snapshot, 1)).toEqual({
      text: '',
      selection_start: 0,
      selection_end: 0,
    })
    expect(read).toHaveBeenCalledWith(undefined, '12', false, 14)
  })
  it('reads only the bound focused editor and can verify its entire text exactly', async () => {
    const capture = new WindowsObservationCapture({ recognize: vi.fn() })
    const read = vi.spyOn(capture, 'metadata').mockResolvedValue({
      ...meta,
      editable_text: '项目\r\n计划\r\n备注',
      selection_start: 0,
      selection_end: 10,
    })
    expect(await capture.readEditor(snapshot, 1)).toMatchObject({ text: '项目\r\n计划\r\n备注' })
    expect((await capture.verifyCurrentText(snapshot, '计划')).verified).toBe(true)
    expect((await capture.verifyCurrentText(snapshot, '计划', true)).verified).toBe(false)
    expect((await capture.verifyCurrentText(snapshot, '项目\n计划\n备注', true)).verified).toBe(
      true,
    )
    read.mockResolvedValue({
      ...meta,
      editable_runtime_id: [42, 99],
      editable_text: '其他正文',
      selection_start: 0,
      selection_end: 0,
    })
    await expect(capture.readEditor(snapshot, 1)).rejects.toThrow('EDITOR_BINDING_CHANGED')
  })
  it('skips assistant windows without replacing the remembered application', async () => {
    const capture = new WindowsObservationCapture({ recognize: vi.fn() })
    const read = vi.spyOn(capture, 'metadata').mockResolvedValue(meta)
    await capture.rememberTarget()
    read.mockResolvedValue({ ...meta, window_id: '99', process_name: 'ChatGPT' })
    await capture.rememberTarget()
    await expect(capture.captureFrame()).resolves.toBeNull()
    read.mockResolvedValue(meta)
    await expect(capture.restoreTarget()).resolves.toBe(true)
    expect(read).toHaveBeenLastCalledWith(undefined, '12', false, 14)
  })
  it('attempts external target restoration when an explicit observation meets the Coloop window', async () => {
    const handle = Buffer.alloc(8)
    handle.writeBigUInt64LE(99n)
    vi.spyOn(BrowserWindow, 'getAllWindows').mockReturnValue([
      { getNativeWindowHandle: () => handle } as unknown as BrowserWindow,
    ])
    const capture = new WindowsObservationCapture({ recognize: vi.fn() })
    vi.spyOn(capture, 'metadata').mockResolvedValue({ ...meta, window_id: '99' })
    const restore = vi.spyOn(capture, 'restoreTarget').mockResolvedValue(false)
    await expect(capture.captureFrame(undefined, true)).rejects.toThrow(
      'OBSERVATION_TARGET_UNAVAILABLE',
    )
    expect(restore).toHaveBeenCalledOnce()
  })
  it('leaves passive observation on the Coloop window without restoring or capturing it', async () => {
    const handle = Buffer.alloc(8)
    handle.writeBigUInt64LE(99n)
    vi.spyOn(BrowserWindow, 'getAllWindows').mockReturnValue([
      { getNativeWindowHandle: () => handle } as unknown as BrowserWindow,
    ])
    const capture = new WindowsObservationCapture({ recognize: vi.fn() })
    vi.spyOn(capture, 'metadata').mockResolvedValue({ ...meta, window_id: '99' })
    const restore = vi.spyOn(capture, 'restoreTarget')
    await expect(capture.captureFrame()).resolves.toBeNull()
    expect(restore).not.toHaveBeenCalled()
  })
  it('rejects assistant-window input even when native identities match', async () => {
    const capture = new WindowsObservationCapture({ recognize: vi.fn() })
    vi.spyOn(capture, 'metadata').mockResolvedValue({ ...meta, process_name: 'ChatGPT' })
    expect(
      (
        await capture.validate(
          { ...snapshot, process_name: 'ChatGPT' },
          {
            action: 'hotkey',
            target_id: 1,
          },
        )
      ).allowed,
    ).toBe(false)
  })
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
    it('observes real checkbox and list selection states in an isolated native form', async () => {
      const script = `
        [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)
        Add-Type -AssemblyName System.Windows.Forms
        $form=[System.Windows.Forms.Form]::new()
        $form.Text='Coloop control-state observation test'
        $form.Size=[System.Drawing.Size]::new(560,400)
        $form.ShowInTaskbar=$false
        foreach($item in @(@('Unchecked',20,$false),@('Checked',50,$true),@('Indeterminate',80,$false),@('Disabled',260,$false),@('Hidden',290,$false),@('Offscreen',500,$false))) {
          $check=[System.Windows.Forms.CheckBox]::new()
          $check.FlatStyle=[System.Windows.Forms.FlatStyle]::System
          $check.Text=$item[0]
          $check.Location=[System.Drawing.Point]::new(20,$item[1])
          $check.Size=[System.Drawing.Size]::new(180,24)
          $check.Checked=$item[2]
          if($item[0]-eq 'Indeterminate'){$check.ThreeState=$true;$check.CheckState=[System.Windows.Forms.CheckState]::Indeterminate}
          if($item[0]-eq 'Disabled'){$check.Enabled=$false}
          if($item[0]-eq 'Hidden'){$check.Visible=$false}
          [void]$form.Controls.Add($check)
        }
        $list=[System.Windows.Forms.ListBox]::new()
        $list.Location=[System.Drawing.Point]::new(20,120)
        $list.Size=[System.Drawing.Size]::new(200,100)
        [void]$list.Items.Add('First item')
        [void]$list.Items.Add('Selected item')
        $list.SelectedIndex=1
        [void]$form.Controls.Add($list)
        $form.Add_Shown({[Console]::WriteLine((@{window_id=$form.Handle.ToInt64().ToString();process_id=$PID}|ConvertTo-Json -Compress))})
        [System.Windows.Forms.Application]::Run($form)
      `
      const fixture = spawn(
        'powershell.exe',
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-EncodedCommand',
          Buffer.from(script, 'utf16le').toString('base64'),
        ],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
      )
      const capture = new WindowsObservationCapture({ recognize: vi.fn() })
      try {
        const identity = await new Promise<{ window_id: string; process_id: number }>(
          (resolve, reject) => {
            const timer = setTimeout(
              () => reject(new Error('Native control fixture startup timed out')),
              10000,
            )
            let output = ''
            fixture.stdout.on('data', (chunk) => {
              output += chunk.toString()
              if (!output.includes('\n')) return
              clearTimeout(timer)
              try {
                resolve(JSON.parse(output.trim()))
              } catch (error) {
                reject(error)
              }
            })
            fixture.once('error', (error) => {
              clearTimeout(timer)
              reject(error)
            })
            fixture.once('exit', () => {
              clearTimeout(timer)
              reject(new Error('Native control fixture exited before observation'))
            })
          },
        )
        const observed = await capture.metadata(
          undefined,
          identity.window_id,
          true,
          identity.process_id,
        )
        expect(observed.window_id).toBe(identity.window_id)
        const controls = observed.control_targets ?? []
        expect(controls.length).toBeLessThanOrEqual(32)
        expect(controls).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ name: 'Unchecked', checked: false }),
            expect.objectContaining({ name: 'Checked', checked: true }),
            expect.objectContaining({ name: 'First item', selected: false }),
            expect.objectContaining({ name: 'Selected item', selected: true }),
          ]),
        )
        expect(
          controls.some((target) => ['Disabled', 'Hidden', 'Offscreen'].includes(target.name)),
        ).toBe(false)
        for (const target of controls.filter((target) => target.name === 'Indeterminate'))
          expect(target).not.toHaveProperty('checked')
        for (const expected of [
          { name: 'Checked', property: 'checked', value: true },
          { name: 'First item', property: 'selected', value: false },
          { name: 'Selected item', property: 'selected', value: true },
        ]) {
          const target = controls.find((target) => target.name === expected.name)!
          const center = [
            (target.rect[0] + target.rect[2]) / 2,
            (target.rect[1] + target.rect[3]) / 2,
          ]
          expect(
            await capture.verifyControlState(
              { ...snapshot, ...observed },
              {
                center,
                runtime_id: target.runtime_id,
                property: expected.property,
                value: expected.value,
              },
            ),
          ).toMatchObject({ verified: true, observable: true })
        }
      } finally {
        capture.dispose()
        const exited = new Promise((resolve) => fixture.once('exit', resolve))
        if (fixture.kill() && fixture.exitCode === null) await exited
      }
    }, 25000)
  })

describe('independent control state completion', () => {
  const condition = { center: [50, 20], runtime_id: [42, 14], property: 'checked', value: true }
  it('reads UIA state and rejects changed identity, missing state and indeterminate state', async () => {
    const capture = new WindowsObservationCapture({ recognize: vi.fn() })
    const read = vi.spyOn(capture, 'metadata').mockResolvedValue({
      ...meta,
      point_target: { ...meta.point_target!, checked: true },
    })
    expect(await capture.verifyControlState(snapshot, condition)).toMatchObject({
      verified: true,
      observable: true,
    })
    expect(read).toHaveBeenLastCalledWith([50, 20])
    read.mockResolvedValue({ ...meta, point_target: { ...meta.point_target!, checked: false } })
    expect(await capture.verifyControlState(snapshot, condition)).toMatchObject({
      verified: false,
      observable: true,
    })
    for (const changed of [
      { ...meta, process_id: 99 },
      { ...meta, window_id: '99' },
      { ...meta, point_owner: '99' },
      { ...meta, point_target: { ...meta.point_target!, runtime_id: [42, 99], checked: true } },
      { ...meta, point_target: { ...meta.point_target!, checked: undefined } },
    ]) {
      read.mockResolvedValue(changed)
      expect(await capture.verifyControlState(snapshot, condition)).toMatchObject({
        verified: false,
        observable: false,
      })
    }
  })
  it('rejects malformed conditions before reading Windows state', async () => {
    const capture = new WindowsObservationCapture({ recognize: vi.fn() })
    const read = vi.spyOn(capture, 'metadata')
    for (const raw of [
      null,
      {},
      { ...condition, value: 'true' },
      { ...condition, center: [NaN, 0] },
      { ...condition, property: 'enabled' },
      { ...condition, runtime_id: [] },
      { ...condition, extra: true },
    ]) {
      expect((await capture.verifyControlState(snapshot, raw)).verified).toBe(false)
    }
    expect(read).not.toHaveBeenCalled()
  })
})
