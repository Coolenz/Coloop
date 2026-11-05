import type { ForegroundMetadata, ForegroundObservation } from './foreground-observation'
import type { ProactiveObservation } from '../services/proactive-agent'
import { CuaDriverError } from './cua-driver'

type Row = Record<string, unknown>
interface Client {
  call(name: string, args: Row, signal?: AbortSignal): Promise<unknown>
}
const row = (value: unknown): Row =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : {}
function payload(reply: unknown): Row {
  const result = row(reply)
  if (result.isError) throw new Error('CUA_TOOL_REJECTED')
  if (result.structuredContent) return row(result.structuredContent)
  for (const item of Array.isArray(result.content) ? result.content : []) {
    const block = row(item)
    if (block.type !== 'text' || typeof block.text !== 'string') continue
    try {
      return row(JSON.parse(block.text))
    } catch {
      /* Human text is not an input receipt. */
    }
  }
  throw new Error('CUA_INVALID_RESULT')
}
const reject = (code: string): never => {
  throw Object.assign(new Error(code), { rejectedBeforeInput: true })
}
function sameWindow(a: ForegroundMetadata, b: ForegroundMetadata) {
  return (
    a.window_id === b.window_id &&
    a.process_id === b.process_id &&
    a.window_rect.join() === b.window_rect.join()
  )
}
function exactWindow(view: ForegroundMetadata) {
  const id = Number(view.window_id)
  if (
    !Number.isSafeInteger(id) ||
    id <= 0 ||
    !Number.isInteger(view.process_id) ||
    view.process_id <= 0
  )
    reject('CUA_INVALID_WINDOW')
  return { pid: view.process_id, window_id: id }
}

// Never reflect exception messages, RPC data or tree text into observations.
const terminalDriverErrors = new Set([
  'CUA_DRIVER_ABORTED',
  'CUA_DRIVER_START_FAILED',
  'CUA_DRIVER_PIPE_FAILED',
  'CUA_DRIVER_CLOSED',
  'CUA_DRIVER_RESPONSE_TOO_LARGE',
  'CUA_DRIVER_INVALID_JSON',
  'CUA_DRIVER_INVALID_RPC',
  'CUA_DRIVER_UNEXPECTED_RESPONSE',
  'CUA_DRIVER_PROTOCOL_MISMATCH',
  'CUA_DRIVER_INVALID_TOOL_LIST',
  'CUA_DRIVER_TIMEOUT',
  'CUA_DRIVER_DISPOSED',
])
const observationErrors = new Set([
  'CUA_INVALID_WINDOW',
  'CUA_WINDOW_CHANGED',
  'CUA_TOOL_REJECTED',
  'CUA_INVALID_RESULT',
])
const transientDriverErrors = new Set([
  'CUA_DRIVER_BUSY',
  'CUA_DRIVER_REQUEST_TOO_LARGE',
  'CUA_DRIVER_TOOL_DENIED',
  'CUA_DRIVER_ARGUMENTS_INVALID',
  'CUA_DRIVER_TOOL_UNAVAILABLE',
  'CUA_DRIVER_INVALID_RESULT',
  'CUA_DRIVER_RPC_ERROR',
])
function observationFailure(error: unknown) {
  // A separately bundled client can have a different CuaDriverError class.
  // Only exact allowlisted codes qualify; arbitrary error properties stay local.
  const code = error instanceof Error ? row(error).code : undefined
  if (typeof code === 'string') {
    if (terminalDriverErrors.has(code)) return { code, terminal: true }
    if (transientDriverErrors.has(code)) return { code, terminal: false }
  }
  return {
    code:
      error instanceof Error && observationErrors.has(error.message)
        ? error.message
        : 'CUA_OBSERVATION_UNAVAILABLE',
    terminal: false,
  }
}

function compatibleRole(native: unknown, cua: unknown) {
  const normalize = (role: unknown) =>
    String(role ?? '')
      .replace(/^ControlType\.|^AX/i, '')
      .replace(/[^a-z]/gi, '')
      .toLowerCase()
  const a = normalize(native),
    b = normalize(cua)
  const editors = new Set(['edit', 'document', 'textbox', 'textfield', 'textarea', 'editabletext'])
  return !!a && !!b && (a === b || (editors.has(a) && editors.has(b)))
}

function nativeCaptureSize(reply: unknown, capture: Row, width: number, height: number) {
  // Prove native pixels against the actual PNG header as well as metadata.
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    capture.screenshot_width !== width ||
    capture.screenshot_height !== height
  )
    return false
  const content = row(reply).content
  for (const entry of Array.isArray(content) ? content : []) {
    const block = row(entry)
    if (block.type !== 'image' || block.mimeType !== 'image/png' || typeof block.data !== 'string')
      continue
    const png = Buffer.from(block.data, 'base64')
    if (
      png.length >= 33 &&
      png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
      png.readUInt32BE(8) === 13 &&
      png.toString('ascii', 12, 16) === 'IHDR' &&
      png.readUInt32BE(16) === width &&
      png.readUInt32BE(20) === height
    )
      return true
  }
  return false
}

function nativeCaptureFrame(reply: unknown, capture: Row, view: ForegroundMetadata) {
  const bounds = row(capture.window_bounds)
  const values = [bounds.x, bounds.y, bounds.width, bounds.height]
  if (!values.every((value) => typeof value === 'number' && Number.isSafeInteger(value)))
    return undefined
  const [x, y, width, height] = values as number[]
  const right = x + width,
    bottom = y + height
  if (
    width <= 0 ||
    height <= 0 ||
    !Number.isSafeInteger(right) ||
    !Number.isSafeInteger(bottom) ||
    x < view.window_rect[0] ||
    y < view.window_rect[1] ||
    right > view.window_rect[2] ||
    bottom > view.window_rect[3]
  )
    return undefined
  // Pinned 0.38.0: DWM bounds omit invisible resize margins; capture crops
  // another 1px per side. bitmap_to_screen adds (DWM.left+1, DWM.top+1).
  // https://github.com/trycua/cua/blob/cua-driver-rs-v0.38.0/libs/cua-driver/rust/crates/platform-windows/src/tools/impl_.rs#L228-L280
  // https://github.com/trycua/cua/blob/cua-driver-rs-v0.38.0/libs/cua-driver/rust/crates/platform-windows/src/capture.rs#L61-L79
  if (nativeCaptureSize(reply, capture, width - 2, height - 2))
    return { x: x + 1, y: y + 1, width: width - 2, height: height - 2 }
  // The same source explicitly falls back to the full GetWindowRect bitmap
  // and origin when DWM bounds are unavailable. No other size/scale is inferred.
  if (
    [x, y, right, bottom].join() === view.window_rect.join() &&
    nativeCaptureSize(reply, capture, width, height)
  )
    return { x, y, width, height }
  return undefined
}

/** Cua 0.38 Windows contract. Raw trees/images/values stay local; no model SDK is involved. */
export class CuaDesktop {
  private binding?: { id: string; snapshot: string; tokens: Map<number, string> }
  private ids = new Map<string, number>()
  private nextId = 2_000_000_000
  private failures = new Map<string, { retryAfter: number; code: string }>()
  private terminalError?: string
  constructor(
    private options: {
      client: Client
      metadata(): Promise<ForegroundMetadata>
      assertAllowed(): void
      guard(view: ForegroundObservation, action: Row): Promise<{ allowed: boolean }>
      now?: () => number
    },
  ) {}

  async enrich(view: ForegroundObservation, signal?: AbortSignal): Promise<ForegroundObservation> {
    this.binding = undefined
    this.options.assertAllowed()
    signal?.throwIfAborted()
    const now = this.options.now?.() ?? Date.now()
    // Moving/resizing a window must not bypass its cooldown. Keep failures for
    // other windows too, so switching A/B cannot turn a failure into a loop.
    const key = `${view.process_id}:${view.window_id}`
    for (const [id, failure] of this.failures)
      if (now >= failure.retryAfter) this.failures.delete(id)
    const cachedError = this.terminalError ?? this.failures.get(key)?.code
    if (cachedError) return { ...view, cua: { status: 'unavailable', error: cachedError } }
    try {
      signal?.throwIfAborted()
      const result = payload(
        await this.options.client.call(
          'get_window_state',
          {
            ...exactWindow(view),
            include_screenshot: false,
            tree_format: 'elements',
            max_elements: 200,
            max_depth: 12,
            timeout_ms: 1000,
          },
          signal,
        ),
      )
      this.options.assertAllowed()
      signal?.throwIfAborted()
      const live = await this.options.metadata()
      this.options.assertAllowed()
      signal?.throwIfAborted()
      if (
        !sameWindow(view, live) ||
        result.pid !== view.process_id ||
        String(result.window_id) !== view.window_id ||
        typeof result.snapshot_id !== 'string'
      )
        throw new Error('CUA_WINDOW_CHANGED')
      const tokens = new Map<number, string>()
      const nextIds = new Map<string, number>()
      const targets: Row[] = []
      const labels: string[] = []
      const existing = view.targets.map((item) => ({ ...row(item) }))
      for (const item of (Array.isArray(result.elements) ? result.elements : []).slice(0, 200)) {
        const element = row(item),
          frame = row(element.frame)
        // Never forward ValuePattern contents or password fields to a planner.
        if (
          element.enabled === false ||
          /password|protected/i.test(String(element.role)) ||
          element.is_password === true
        )
          continue
        const name = typeof element.label === 'string' ? element.label.slice(0, 160).trim() : ''
        const token = element.element_token
        if (
          !name ||
          typeof token !== 'string' ||
          !/^s[0-9a-f]{8}:\d+$/.test(token) ||
          !token.startsWith(result.snapshot_id + ':')
        )
          continue
        const { x, y, w, h } = frame
        if (![x, y, w, h].every((v) => typeof v === 'number' && Number.isFinite(v))) continue
        const rect = [
          x as number,
          y as number,
          (x as number) + (w as number),
          (y as number) + (h as number),
        ]
        if (
          (w as number) <= 0 ||
          (h as number) <= 0 ||
          rect[0] < view.window_rect[0] ||
          rect[1] < view.window_rect[1] ||
          rect[2] > view.window_rect[2] ||
          rect[3] > view.window_rect[3]
        )
          continue
        labels.push(name)
        const match = existing.find(
          (t) =>
            Array.isArray(t.rect) &&
            t.rect.join() === rect.join() &&
            (t.name === name ||
              (Array.isArray(t.runtime_id) &&
                t.runtime_id.length > 0 &&
                compatibleRole(t.type, element.role))),
        )
        const key = `${view.process_id}:${view.window_id}:${element.element_index}:${name}:${rect.join()}`
        const id = typeof match?.id === 'number' ? match.id : (this.ids.get(key) ?? this.nextId++)
        nextIds.set(key, id)
        tokens.set(id, token)
        if (match) {
          // Keep the native identity used by paste/focus verification while
          // replacing generic labels such as "Focused text editor".
          match.name = name
          match.text = name
        } else
          targets.push({
            id,
            name,
            text: name,
            type: String(element.role).slice(0, 60),
            source: 'cua',
            pointer_only: true,
            rect,
            center: [(rect[0] + rect[2]) / 2, (rect[1] + rect[3]) / 2],
          })
      }
      this.ids = nextIds
      this.failures.delete(key)
      this.binding = { id: view.observation_id, snapshot: result.snapshot_id, tokens }
      return {
        ...view,
        targets: [...existing, ...targets],
        cua: {
          status: 'ready',
          elements: tokens.size,
          truncated: result.truncated === true,
          text: [...new Set(labels)].join('\n').slice(0, 6000),
        },
      } as ForegroundObservation
    } catch (error) {
      const failure = observationFailure(error)
      // The transport is terminal after timeout/abort/protocol failure. A new
      // foreground window is not permission to reconnect or replay input.
      if (failure.terminal) this.terminalError = failure.code
      this.options.assertAllowed()
      signal?.throwIfAborted()
      if (failure.code === 'CUA_DRIVER_ABORTED') throw new CuaDriverError('CUA_DRIVER_ABORTED')
      if (!failure.terminal) {
        if (this.failures.size >= 64) this.failures.delete(this.failures.keys().next().value!)
        this.failures.set(key, {
          retryAfter: (this.options.now?.() ?? Date.now()) + 30_000,
          code: failure.code,
        })
      }
      return {
        ...view,
        cua: { status: 'unavailable', error: failure.code },
      } as ForegroundObservation
    }
  }

  async execute(observation: ProactiveObservation, action: Row, signal: AbortSignal) {
    let dispatched = false
    try {
      return await this.executeInner(observation, action, signal, () => {
        dispatched = true
      })
    } catch (error) {
      // Preflight failures have no physical effect. The transport can also
      // prove it refused a call before writing to its private input pipe.
      if (!dispatched || row(error).dispatched === false) {
        const failure = error instanceof Error ? error : new Error('CUA_PREFLIGHT_FAILED')
        throw Object.assign(failure, { rejectedBeforeInput: true })
      }
      throw error
    }
  }

  private async executeInner(
    observation: ProactiveObservation,
    action: Row,
    signal: AbortSignal,
    dispatching: () => void,
  ) {
    const view = observation as unknown as ForegroundObservation
    const kind = action.action
    if (!['click', 'double_click', 'scroll'].includes(String(kind)))
      reject('CUA_ACTION_UNSUPPORTED')
    this.options.assertAllowed()
    signal.throwIfAborted()
    const target = [...view.targets, ...view.ocr_items]
      .map(row)
      .find((t) => t.id === action.target_id)
    if (
      !target ||
      !Array.isArray(target.center) ||
      target.center.length !== 2 ||
      !target.center.every((v) => typeof v === 'number' && Number.isFinite(v))
    )
      reject('CUA_TARGET_MISSING')
    const center = target!.center as number[]
    if (
      center[0] < view.window_rect[0] ||
      center[1] < view.window_rect[1] ||
      center[0] >= view.window_rect[2] ||
      center[1] >= view.window_rect[3]
    )
      reject('CUA_TARGET_OUTSIDE_WINDOW')
    const identity = exactWindow(view)
    let tool = kind === 'double_click' ? 'double_click' : String(kind)
    let args: Row = { ...identity, delivery_mode: 'foreground' }
    const token =
      this.binding?.id === view.observation_id
        ? this.binding.tokens.get(Number(action.target_id))
        : undefined
    if (token && kind !== 'scroll') {
      args = { ...identity, element_token: token, delivery_mode: 'background' }
    } else {
      // Pixel addressing is grounded in a fresh native-resolution Cua capture, never guessed DPI.
      let capture: Row
      let captureReply: unknown
      try {
        captureReply = await this.options.client.call(
          'get_window_state',
          {
            ...identity,
            include_accessibility_tree: false,
            include_screenshot: true,
            max_image_dimension: 0,
          },
          signal,
        )
        capture = payload(captureReply)
      } catch {
        reject('CUA_CAPTURE_UNAVAILABLE')
      }
      const frame = nativeCaptureFrame(captureReply, capture!, view)
      if (
        capture!.pid !== view.process_id ||
        String(capture!.window_id) !== view.window_id ||
        !frame ||
        typeof capture!.capture_id !== 'string' ||
        !capture!.capture_id ||
        capture!.screenshot_frame_valid === false
      )
        reject('CUA_CAPTURE_GEOMETRY_UNCONFIRMED')
      if (
        center[0] < frame!.x ||
        center[1] < frame!.y ||
        center[0] >= frame!.x + frame!.width ||
        center[1] >= frame!.y + frame!.height
      )
        reject('CUA_TARGET_OUTSIDE_CAPTURE')
      args.x = center[0] - frame!.x
      args.y = center[1] - frame!.y
      if (kind === 'click') args.capture_id = capture!.capture_id
      if (kind === 'scroll') {
        const steps = Number(action.steps)
        if (!Number.isInteger(steps) || Math.abs(steps) < 1 || Math.abs(steps) > 32)
          reject('CUA_SCROLL_INVALID')
        args.direction = steps > 0 ? 'up' : 'down'
        args.amount = Math.abs(steps)
        args.by = 'line'
      }
    }
    this.options.assertAllowed()
    signal.throwIfAborted()
    if (!sameWindow(view, await this.options.metadata())) reject('CUA_WINDOW_CHANGED')
    if (!(await this.options.guard(view, action)).allowed) reject('CUA_TARGET_CHANGED')
    this.options.assertAllowed()
    signal.throwIfAborted()
    this.binding = undefined
    // From here on any unrecognised/error response is uncertain, never a fallback click.
    dispatching()
    const response = payload(await this.options.client.call(tool, args, signal))
    if (
      !['confirmed', 'unverifiable', 'suspected_noop'].includes(String(response.effect)) ||
      typeof response.route !== 'string' ||
      !response.route ||
      response.error ||
      response.code ||
      response.ok === false ||
      response.success === false
    )
      throw new Error('CUA_INPUT_OUTCOME_UNKNOWN')
    return { release_confirmed: true }
  }
}
