import { beforeEach, expect, it, vi, type Mock } from 'vitest'
import { CuaDesktop } from '../src/main/infrastructure/cua-desktop'
import { CuaDriverError } from '../src/main/infrastructure/cua-driver'
import type { ForegroundObservation } from '../src/main/infrastructure/foreground-observation'
import type { ProactiveObservation } from '../src/main/services/proactive-agent'

type Row = Record<string, unknown>
const signal = () => new AbortController().signal
const observation = (): ForegroundObservation => ({
  observation_id: 'obs-1',
  captured_at: Date.now(),
  content_hash: 'hash',
  window_id: '42',
  process_id: 12,
  window_rect: [-500, 100, 500, 800],
  point_owner: '42',
  editable_focus: false,
  screen: { x: -1000, y: 0, width: 2000, height: 1000 },
  ocr_text: 'Save',
  ocr_items: [],
  targets: [
    { id: 1, name: 'Save', text: 'Save', rect: [-450, 120, -350, 160], center: [-400, 140] },
  ],
})
const png = (width = 1000, height = 700) => {
  const bytes = Buffer.alloc(33)
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes)
  bytes.writeUInt32BE(13, 8)
  bytes.write('IHDR', 12)
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  return { type: 'image', mimeType: 'image/png', data: bytes.toString('base64') }
}
const reply = (structuredContent: Row, content: unknown[] = []) => ({ structuredContent, content })
const element = (fields: Row = {}): Row => ({
  label: 'Save',
  role: 'Button',
  enabled: true,
  element_index: 1,
  element_token: 's00000001:1',
  frame: { x: -450, y: 120, w: 100, h: 40 },
  ...fields,
})
const tree = (elements: Row[] = [element()]): Row => ({
  pid: 12,
  window_id: 42,
  snapshot_id: 's00000001',
  elements,
  truncated: false,
})
const capture = (overrides: Row = {}): Row => ({
  pid: 12,
  window_id: 42,
  capture_id: 'capture-1',
  screenshot_width: 1000,
  screenshot_height: 700,
  window_bounds: { x: -500, y: 100, width: 1000, height: 700 },
  ...overrides,
})
const inputReceipt = (overrides: Row = {}) =>
  reply({ effect: 'unverifiable', route: 'foreground_input', ...overrides })

let view: ForegroundObservation
let call: Mock<(name: string, args: Row, signal?: AbortSignal) => Promise<unknown>>
let metadata: Mock<() => Promise<ForegroundObservation>>
let guard: Mock<(view: ForegroundObservation, action: Row) => Promise<{ allowed: boolean }>>
let assertAllowed: Mock<() => void>
let desktop: CuaDesktop
beforeEach(() => {
  view = observation()
  call = vi.fn().mockResolvedValue(inputReceipt())
  metadata = vi.fn(async () => view)
  guard = vi.fn(async () => ({ allowed: true }))
  assertAllowed = vi.fn()
  desktop = new CuaDesktop({ client: { call }, metadata, guard, assertAllowed, now: () => 1000 })
})
const act = (action: Row = { action: 'click', target_id: 1 }, inputView = view) =>
  desktop.execute(inputView as unknown as ProactiveObservation, action, signal())
const cua = (value: ForegroundObservation) => (value as unknown as { cua: Row }).cua

it('uses global UIA frames unchanged, deduplicates targets, and keeps raw values/tokens local', async () => {
  call.mockResolvedValue(
    reply(
      tree([
        element({ value: 'private value' }),
        element({
          element_index: 2,
          element_token: 's00000001:2',
          label: 'Open',
          frame: { x: -300, y: 200, w: 80, h: 30 },
        }),
      ]),
    ),
  )
  const enriched = await desktop.enrich(view)
  expect(enriched.targets).toHaveLength(2)
  expect(enriched.targets[1]).toMatchObject({
    source: 'cua',
    name: 'Open',
    rect: [-300, 200, -220, 230],
    center: [-260, 215],
  })
  expect(cua(enriched)).toMatchObject({ status: 'ready', elements: 2, text: 'Save\nOpen' })
  expect(JSON.stringify(enriched)).not.toContain('private value')
  expect(JSON.stringify(enriched)).not.toContain('s00000001')
  expect(call).toHaveBeenCalledWith(
    'get_window_state',
    expect.objectContaining({
      pid: 12,
      window_id: 42,
      include_screenshot: false,
      tree_format: 'elements',
    }),
    undefined,
  )
})

it('rejects password, disabled, foreign-token and out-of-window elements', async () => {
  call.mockResolvedValue(
    reply(
      tree([
        element({ label: 'password secret', is_password: true }),
        element({ enabled: false }),
        element({ role: 'ProtectedEdit' }),
        element({ element_token: 's00000002:1' }),
        element({ frame: { x: 0, y: 0, w: 100, h: 40 } }),
        element({ frame: { x: -450, y: 120, w: -1, h: 40 } }),
        element({ frame: { x: '-450', y: 120, w: 100, h: 40 } }),
      ]),
    ),
  )
  const enriched = await desktop.enrich(view)
  expect(enriched.targets).toEqual(view.targets)
  expect(cua(enriched)).toMatchObject({ elements: 0, text: '' })
})

it('keeps synthetic target ids stable across fresh snapshots of the same controls', async () => {
  const item = element({ label: 'Open' })
  call
    .mockResolvedValueOnce(reply(tree([item])))
    .mockResolvedValueOnce(
      reply({ ...tree([{ ...item, element_token: 's00000002:1' }]), snapshot_id: 's00000002' }),
    )
  const first = await desktop.enrich(view)
  const second = await desktop.enrich({ ...view, observation_id: 'obs-2' })
  expect((first.targets[1] as Row).id).toBe((second.targets[1] as Row).id)
})

it.each([{ pid: 13 }, { window_id: 43 }, { snapshot_id: undefined }])(
  'drops Cua enrichment when reply window identity is incompatible: %j',
  async (fields) => {
    call.mockResolvedValue(reply({ ...tree(), ...fields }))
    const enriched = await desktop.enrich(view)
    expect(enriched.targets).toEqual(view.targets)
    expect(cua(enriched)).toEqual({ status: 'unavailable', error: 'CUA_WINDOW_CHANGED' })
  },
)

it('drops Cua enrichment if the live window moves and backs off failed reads', async () => {
  call.mockResolvedValue(reply(tree()))
  metadata.mockResolvedValue({ ...view, window_rect: [0, 0, 1000, 700] })
  expect(cua(await desktop.enrich(view)).status).toBe('unavailable')
  expect(cua(await desktop.enrich(view)).status).toBe('unavailable')
  expect(call).toHaveBeenCalledTimes(1)
})

it('allows a new window immediately while preserving A/B cooldowns and ignoring resize/title changes', async () => {
  const a = view
  const b = { ...view, window_id: '43', process_id: 13 }
  metadata.mockResolvedValue(b)
  call
    .mockResolvedValueOnce(reply(tree()))
    .mockResolvedValueOnce(reply({ ...tree(), pid: 13, window_id: 43 }))
  expect(cua(await desktop.enrich(a)).error).toBe('CUA_WINDOW_CHANGED')
  expect(cua(await desktop.enrich(b)).status).toBe('ready')
  expect(cua(await desktop.enrich(a)).error).toBe('CUA_WINDOW_CHANGED')
  expect(cua(await desktop.enrich({ ...a, window_rect: [0, 0, 1000, 700] })).error).toBe(
    'CUA_WINDOW_CHANGED',
  )
  expect(call).toHaveBeenCalledTimes(2)
})

it('retries a failed window only after 30 seconds from completion', async () => {
  let now = 1000
  desktop = new CuaDesktop({ client: { call }, metadata, guard, assertAllowed, now: () => now })
  call
    .mockImplementationOnce(async () => {
      now = 6000
      throw Error('private diagnostics')
    })
    .mockResolvedValue(reply(tree()))
  expect(cua(await desktop.enrich(view)).error).toBe('CUA_OBSERVATION_UNAVAILABLE')
  now = 35_999
  expect(cua(await desktop.enrich(view)).status).toBe('unavailable')
  expect(call).toHaveBeenCalledTimes(1)
  now = 36_000
  expect(cua(await desktop.enrich(view)).status).toBe('ready')
  expect(cua(await desktop.enrich(view)).status).toBe('ready')
  expect(call).toHaveBeenCalledTimes(3)
})

it('bounds remembered failures without discarding the recent window cooldown', async () => {
  call.mockRejectedValue(Error('local read failed'))
  for (let id = 1; id <= 65; id++) await desktop.enrich({ ...view, window_id: String(id) })
  expect(call).toHaveBeenCalledTimes(65)
  await desktop.enrich({ ...view, window_id: '65' })
  expect(call).toHaveBeenCalledTimes(65)
  await desktop.enrich({ ...view, window_id: '1' })
  expect(call).toHaveBeenCalledTimes(66)
})

it.each([
  Error('private email, API token and raw accessibility tree'),
  Object.assign(Error('private message'), {
    code: 'CUA_DRIVER_TIMEOUT private token',
    tree: 'private tree',
  }),
  new CuaDriverError('private driver code'),
  { message: 'private plain object', code: 'private code' },
])('sanitizes unknown observation failures into a fixed code %#', async (failure) => {
  call.mockRejectedValue(failure)
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await desktop.enrich(view)
    expect(result).toEqual({
      ...view,
      cua: { status: 'unavailable', error: 'CUA_OBSERVATION_UNAVAILABLE' },
    })
    expect(JSON.stringify(result)).not.toContain('private')
  }
  expect(call).toHaveBeenCalledTimes(1)
})

it.each([
  [new CuaDriverError('CUA_DRIVER_TIMEOUT'), 'CUA_DRIVER_TIMEOUT'],
  [
    Object.assign(Error('private text'), { code: 'CUA_DRIVER_PIPE_FAILED' }),
    'CUA_DRIVER_PIPE_FAILED',
  ],
])(
  'keeps terminal transport errors diagnostic without retrying on window change or time expiry %#',
  async (failure, code) => {
    let now = 1000
    desktop = new CuaDesktop({ client: { call }, metadata, guard, assertAllowed, now: () => now })
    call.mockRejectedValue(failure)
    expect(cua(await desktop.enrich(view))).toEqual({ status: 'unavailable', error: code })
    now += 120_000
    expect(cua(await desktop.enrich({ ...view, window_id: '43' }))).toEqual({
      status: 'unavailable',
      error: code,
    })
    expect(cua(await desktop.enrich(view))).toEqual({ status: 'unavailable', error: code })
    expect(call).toHaveBeenCalledTimes(1)
  },
)

it('exposes only a fixed tool-rejection code, never the returned private text/tree', async () => {
  call.mockResolvedValue({
    isError: true,
    content: [{ type: 'text', text: 'private API key' }],
    structuredContent: { error: 'private tree' },
  })
  expect(await desktop.enrich(view)).toEqual({
    ...view,
    cua: { status: 'unavailable', error: 'CUA_TOOL_REJECTED' },
  })
})

it.each([Error('local failure'), new CuaDriverError('CUA_DRIVER_TIMEOUT')])(
  'does not bypass privacy or cancellation while returning cached failures %#',
  async (failure) => {
    call.mockRejectedValue(failure)
    await desktop.enrich(view)
    assertAllowed.mockImplementation(() => {
      throw Error('PRIVATE_MODE')
    })
    await expect(desktop.enrich(view)).rejects.toThrow('PRIVATE_MODE')
    assertAllowed.mockReset()
    const abort = new AbortController()
    abort.abort()
    await expect(desktop.enrich(view, abort.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(call).toHaveBeenCalledTimes(1)
  },
)

it('propagates cancellation reported by the driver and keeps its transport terminal', async () => {
  call.mockRejectedValue(new CuaDriverError('CUA_DRIVER_ABORTED'))
  await expect(desktop.enrich(view)).rejects.toMatchObject({
    name: 'AbortError',
    message: 'CUA_DRIVER_ABORTED',
  })
  expect(cua(await desktop.enrich({ ...view, window_id: '43' })).error).toBe('CUA_DRIVER_ABORTED')
  expect(call).toHaveBeenCalledTimes(1)
})

it.each(['privacy', 'cancel'])(
  'propagates %s changes during the final metadata check',
  async (mode) => {
    const abort = new AbortController()
    call.mockResolvedValue(reply(tree()))
    metadata.mockImplementation(async () => {
      if (mode === 'privacy')
        assertAllowed.mockImplementation(() => {
          throw Error('PRIVATE_MODE')
        })
      else abort.abort()
      return view
    })
    await expect(desktop.enrich(view, abort.signal)).rejects.toMatchObject(
      mode === 'privacy' ? { message: 'PRIVATE_MODE' } : { name: 'AbortError' },
    )
  },
)

it('propagates privacy revocation and cancellation instead of returning an observation', async () => {
  assertAllowed.mockImplementation(() => {
    throw Error('PRIVATE_MODE')
  })
  await expect(desktop.enrich(view)).rejects.toThrow('PRIVATE_MODE')
  expect(call).not.toHaveBeenCalled()
  assertAllowed.mockReset()
  const abort = new AbortController()
  abort.abort()
  await expect(desktop.enrich(view, abort.signal)).rejects.toMatchObject({ name: 'AbortError' })
})

it('executes an exact-window element token without a pixel capture', async () => {
  call
    .mockResolvedValueOnce(reply(tree()))
    .mockResolvedValueOnce(inputReceipt({ effect: 'confirmed', route: 'accessibility' }))
  const enriched = await desktop.enrich(view)
  expect(await act(undefined, enriched)).toEqual({ release_confirmed: true })
  expect(call.mock.calls[1]).toEqual([
    'click',
    { pid: 12, window_id: 42, element_token: 's00000001:1', delivery_mode: 'background' },
    expect.any(AbortSignal),
  ])
  expect(guard).toHaveBeenCalledWith(enriched, { action: 'click', target_id: 1 })
})

it('converts negative global screen coordinates to native screenshot coordinates with capture binding', async () => {
  call.mockResolvedValueOnce(reply(capture(), [png()])).mockResolvedValueOnce(inputReceipt())
  expect(await act()).toEqual({ release_confirmed: true })
  expect(call.mock.calls[0][1]).toMatchObject({
    include_accessibility_tree: false,
    include_screenshot: true,
    max_image_dimension: 0,
  })
  expect(call.mock.calls[1]).toEqual([
    'click',
    { pid: 12, window_id: 42, x: 100, y: 40, capture_id: 'capture-1', delivery_mode: 'foreground' },
    expect.any(AbortSignal),
  ])
})

it.each(['click', 'double_click', 'scroll'])(
  'maps the real DWM-inset capture to its exact native origin for %s',
  async (kind) => {
    view.window_rect = [743, 284, 1818, 1097]
    view.targets = [{ id: 1, center: [1081.5, 491.5] }]
    call
      .mockResolvedValueOnce(
        reply(
          capture({
            window_bounds: { x: 752, y: 284, width: 1057, height: 804 },
            screenshot_width: 1055,
            screenshot_height: 802,
          }),
          [png(1055, 802)],
        ),
      )
      .mockResolvedValueOnce(inputReceipt())
    await act({ action: kind, target_id: 1, ...(kind === 'scroll' ? { steps: -3 } : {}) })
    expect(call.mock.calls[1][0]).toBe(kind)
    expect(call.mock.calls[1][1]).toMatchObject({ x: 328.5, y: 206.5, window_id: 42, pid: 12 })
    if (kind === 'click') expect(call.mock.calls[1][1]).toHaveProperty('capture_id', 'capture-1')
    if (kind === 'scroll')
      expect(call.mock.calls[1][1]).toMatchObject({ direction: 'down', amount: 3 })
    expect(metadata).toHaveBeenCalledTimes(1)
    expect(guard).toHaveBeenCalledTimes(1)
  },
)

it('handles a DWM capture on a negative-coordinate monitor without DPI scaling', async () => {
  call
    .mockResolvedValueOnce(
      reply(
        capture({
          window_bounds: { x: -490, y: 100, width: 980, height: 690 },
          screenshot_width: 978,
          screenshot_height: 688,
        }),
        [png(978, 688)],
      ),
    )
    .mockResolvedValueOnce(inputReceipt())
  await act()
  expect(call.mock.calls[1][1]).toMatchObject({ x: 89, y: 39, capture_id: 'capture-1' })
})

it.each([
  { bounds: { x: -490, y: 100, width: 980, height: 690 }, width: 980, height: 690 },
  { bounds: { x: -490, y: 100, width: 980, height: 690 }, width: 979, height: 689 },
  { bounds: { x: -490, y: 100, width: 980, height: 690 }, width: 489, height: 344 },
  { bounds: { x: -501, y: 100, width: 980, height: 690 }, width: 978, height: 688 },
  { bounds: { x: -490, y: 100, width: 1000, height: 690 }, width: 998, height: 688 },
  { bounds: { x: '-490', y: 100, width: 980, height: 690 }, width: 978, height: 688 },
  { bounds: { x: -490.5, y: 100, width: 980, height: 690 }, width: 978, height: 688 },
])(
  'rejects unproven crop/scale or invalid physical bounds %#',
  async ({ bounds, width, height }) => {
    call.mockResolvedValue(
      reply(
        capture({ window_bounds: bounds, screenshot_width: width, screenshot_height: height }),
        [png(width, height)],
      ),
    )
    await expect(act()).rejects.toMatchObject({
      message: 'CUA_CAPTURE_GEOMETRY_UNCONFIRMED',
      rejectedBeforeInput: true,
    })
    expect(call).toHaveBeenCalledTimes(1)
  },
)

it.each([
  [-490, 140],
  [489, 140],
  [-400, 100],
  [-400, 789],
])(
  'rejects a point in the original window but outside the actual cropped bitmap: %j',
  async (x, y) => {
    view.targets = [{ id: 1, center: [x, y] }]
    call.mockResolvedValue(
      reply(
        capture({
          window_bounds: { x: -490, y: 100, width: 980, height: 690 },
          screenshot_width: 978,
          screenshot_height: 688,
        }),
        [png(978, 688)],
      ),
    )
    await expect(act()).rejects.toMatchObject({
      message: 'CUA_TARGET_OUTSIDE_CAPTURE',
      rejectedBeforeInput: true,
    })
    expect(call).toHaveBeenCalledTimes(1)
  },
)

it('requires matching actual PNG dimensions even for an otherwise valid DWM crop', async () => {
  call.mockResolvedValue(
    reply(
      capture({
        window_bounds: { x: -490, y: 100, width: 980, height: 690 },
        screenshot_width: 978,
        screenshot_height: 688,
      }),
      [png(980, 690)],
    ),
  )
  await expect(act()).rejects.toMatchObject({
    message: 'CUA_CAPTURE_GEOMETRY_UNCONFIRMED',
    rejectedBeforeInput: true,
  })
  expect(call).toHaveBeenCalledTimes(1)
})

it.each([
  { screenshot_width: 500 },
  { screenshot_height: 350 },
  { capture_id: undefined },
  { capture_id: '' },
  { pid: 13 },
  { window_id: 43 },
  { screenshot_frame_valid: false },
  { window_bounds: { x: -499, y: 100, width: 1000, height: 700 } },
])('rejects ungrounded pixel captures before dispatch: %j', async (fields) => {
  call.mockResolvedValue(reply(capture(fields), [png()]))
  await expect(act()).rejects.toMatchObject({
    message: 'CUA_CAPTURE_GEOMETRY_UNCONFIRMED',
    rejectedBeforeInput: true,
  })
  expect(call).toHaveBeenCalledTimes(1)
})

it.each([
  { content: [] },
  { content: [png(500, 350)] },
  { content: [{ type: 'image', mimeType: 'image/png', data: 'YQ==' }] },
])('requires matching actual PNG dimensions', async ({ content }) => {
  call.mockResolvedValue(reply(capture(), content))
  await expect(act()).rejects.toMatchObject({ rejectedBeforeInput: true })
  expect(call).toHaveBeenCalledTimes(1)
})

it('rechecks the point guard after screenshot acquisition', async () => {
  call.mockResolvedValue(reply(capture(), [png()]))
  guard.mockResolvedValue({ allowed: false })
  await expect(act()).rejects.toMatchObject({
    message: 'CUA_TARGET_CHANGED',
    rejectedBeforeInput: true,
  })
  expect(call).toHaveBeenCalledTimes(1)
})

it('rejects a changed foreground window after capture and before input', async () => {
  call.mockResolvedValue(reply(capture(), [png()]))
  metadata.mockResolvedValue({ ...view, window_id: '43' })
  await expect(act()).rejects.toMatchObject({
    message: 'CUA_WINDOW_CHANGED',
    rejectedBeforeInput: true,
  })
  expect(call).toHaveBeenCalledTimes(1)
})

it('rejects unsupported actions and out-of-bounds target centers before any call', async () => {
  await expect(act({ action: 'hotkey', target_id: 1 })).rejects.toMatchObject({
    rejectedBeforeInput: true,
  })
  view.targets = [{ id: 1, center: [-501, 140] }]
  await expect(act()).rejects.toMatchObject({
    message: 'CUA_TARGET_OUTSIDE_WINDOW',
    rejectedBeforeInput: true,
  })
  expect(call).not.toHaveBeenCalled()
})

it('maps signed scroll lines and enforces the bounded step count', async () => {
  call.mockResolvedValueOnce(reply(capture(), [png()])).mockResolvedValueOnce(inputReceipt())
  await act({ action: 'scroll', target_id: 1, steps: -3 })
  expect(call.mock.calls[1]).toEqual([
    'scroll',
    {
      pid: 12,
      window_id: 42,
      x: 100,
      y: 40,
      direction: 'down',
      amount: 3,
      by: 'line',
      delivery_mode: 'foreground',
    },
    expect.any(AbortSignal),
  ])
  call.mockResolvedValue(reply(capture(), [png()]))
  await expect(act({ action: 'scroll', target_id: 1, steps: 0 })).rejects.toMatchObject({
    rejectedBeforeInput: true,
  })
})

it.each([
  { effect: 'confirmed', route: 'accessibility', ok: false },
  { effect: 'confirmed', route: 'accessibility', success: false },
  { effect: 'confirmed', route: 'accessibility', code: 'permission_denied' },
  { effect: 'confirmed' },
  { route: 'accessibility' },
  { effect: 'unknown', route: 'pixels' },
])('does not interpret ambiguous/false receipts as successful input: %j', async (receipt) => {
  call.mockResolvedValueOnce(reply(capture(), [png()])).mockResolvedValueOnce(reply(receipt))
  await expect(act()).rejects.toThrow('CUA_INPUT_OUTCOME_UNKNOWN')
  expect(call).toHaveBeenCalledTimes(2)
})

it('does not retry or mark post-dispatch tool errors as definitely not sent', async () => {
  call.mockResolvedValueOnce(reply(capture(), [png()])).mockResolvedValueOnce({
    isError: true,
    content: [],
    structuredContent: { code: 'tool_output_invalid', execution_state: 'unknown' },
  })
  try {
    await act()
    throw Error('should reject')
  } catch (error) {
    expect(error).toMatchObject({ message: 'CUA_TOOL_REJECTED' })
    expect((error as Row).rejectedBeforeInput).toBeUndefined()
  }
  expect(call).toHaveBeenCalledTimes(2)
})

it('accepts JSON text payloads but does not turn prose into an input receipt', async () => {
  call
    .mockResolvedValueOnce({ content: [{ type: 'text', text: JSON.stringify(tree()) }] })
    .mockResolvedValueOnce({ content: [{ type: 'text', text: 'clicked successfully' }] })
  const enriched = await desktop.enrich(view)
  expect(cua(enriched).status).toBe('ready')
  await expect(act(undefined, enriched)).rejects.toThrow('CUA_INVALID_RESULT')
})

it('marks a cancelled or privacy-blocked preflight as not sent', async () => {
  const abort = new AbortController()
  abort.abort()
  await expect(
    desktop.execute(
      view as unknown as ProactiveObservation,
      { action: 'click', target_id: 1 },
      abort.signal,
    ),
  ).rejects.toMatchObject({ name: 'AbortError', rejectedBeforeInput: true })
  assertAllowed.mockImplementation(() => {
    throw Error('PRIVATE_MODE')
  })
  await expect(act()).rejects.toMatchObject({ message: 'PRIVATE_MODE', rejectedBeforeInput: true })
  expect(call).not.toHaveBeenCalled()
})

it.each(['metadata', 'guard'])('marks a failed %s preflight as not sent', async (component) => {
  call.mockResolvedValue(reply(capture(), [png()]))
  if (component === 'metadata') metadata.mockRejectedValue(Error('OBSERVER_UNAVAILABLE'))
  else guard.mockRejectedValue(Error('OBSERVER_UNAVAILABLE'))
  await expect(act()).rejects.toMatchObject({
    message: 'OBSERVER_UNAVAILABLE',
    rejectedBeforeInput: true,
  })
  expect(call).toHaveBeenCalledTimes(1)
})

it('preserves proof that a transport rejected before dispatch instead of locking input as unknown', async () => {
  call
    .mockResolvedValueOnce(reply(capture(), [png()]))
    .mockRejectedValueOnce(Object.assign(Error('CUA_DRIVER_BUSY'), { dispatched: false }))
  await expect(act()).rejects.toMatchObject({ dispatched: false, rejectedBeforeInput: true })
})

it('preserves an uncertain dispatched failure without automatic repeat', async () => {
  call
    .mockResolvedValueOnce(reply(capture(), [png()]))
    .mockRejectedValueOnce(Object.assign(Error('CUA_DRIVER_TIMEOUT'), { dispatched: true }))
  try {
    await act()
    throw Error('should fail')
  } catch (error) {
    expect(error).toMatchObject({ message: 'CUA_DRIVER_TIMEOUT', dispatched: true })
    expect((error as Row).rejectedBeforeInput).toBeUndefined()
  }
  expect(call).toHaveBeenCalledTimes(2)
})

it('does not reuse an element token after a dispatched input', async () => {
  call
    .mockResolvedValueOnce(reply(tree()))
    .mockResolvedValueOnce(inputReceipt())
    .mockResolvedValueOnce(reply(capture(), [png()]))
    .mockResolvedValueOnce(inputReceipt())
  const enriched = await desktop.enrich(view)
  await act(undefined, enriched)
  await act(undefined, enriched)
  expect(call.mock.calls.map((c) => c[0])).toEqual([
    'get_window_state',
    'click',
    'get_window_state',
    'click',
  ])
  expect(call.mock.calls[3][1]).toHaveProperty('capture_id', 'capture-1')
  expect(call.mock.calls[3][1]).not.toHaveProperty('element_token')
})

it('does not claim task completion for a suspected no-op', async () => {
  call
    .mockResolvedValueOnce(reply(capture(), [png()]))
    .mockResolvedValueOnce(inputReceipt({ effect: 'suspected_noop' }))
  const result = await act()
  expect(result).toEqual({ release_confirmed: true })
  expect(result).not.toHaveProperty('verified')
})

it('merges a labelled Cua editor into the native focused editor without losing its input identity', async () => {
  view.targets = [
    {
      id: 71,
      name: 'Focused text editor',
      text: 'Focused text editor',
      type: 'Edit',
      source: 'win32',
      runtime_id: [42, 151],
      rect: [-450, 120, -350, 160],
      center: [-400, 140],
    },
  ]
  call.mockResolvedValue(
    reply(tree([element({ label: 'Article body', role: 'ControlType.Document' })])),
  )
  const enriched = await desktop.enrich(view)
  expect(enriched.targets).toEqual([
    {
      id: 71,
      name: 'Article body',
      text: 'Article body',
      type: 'Edit',
      source: 'win32',
      runtime_id: [42, 151],
      rect: [-450, 120, -350, 160],
      center: [-400, 140],
    },
  ])
  expect((view.targets[0] as Row).name).toBe('Focused text editor')
  expect(enriched.targets[0]).not.toHaveProperty('pointer_only')
})

it('keeps incompatible same-bounds controls separate and makes unmatched Cua targets pointer-only', async () => {
  view.targets = [
    {
      id: 71,
      name: 'Focused text editor',
      type: 'Edit',
      runtime_id: [42, 151],
      rect: [-450, 120, -350, 160],
      center: [-400, 140],
    },
  ]
  call.mockResolvedValue(reply(tree([element({ label: 'Expand', role: 'Button' })])))
  const enriched = await desktop.enrich(view)
  expect(enriched.targets).toHaveLength(2)
  expect(enriched.targets[1]).toMatchObject({ pointer_only: true, source: 'cua', name: 'Expand' })
  expect(enriched.targets[1]).not.toHaveProperty('runtime_id')
})
