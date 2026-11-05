import { proactiveErrorLabels } from '../../shared/proactive'

type Row = Record<string, unknown>
const row = (value: unknown): Row =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : {}

const eventTypes = new Set([
  'agent_run_start',
  'agent_run_end',
  'agent_error',
  'tool_call',
  'tool_result',
  'assistant_message',
  'user_message',
  'harness_session_event',
  'coloop_consult_retry',
  'coloop_local_protocol_retry',
  'coloop_progress_diagnostic',
])
const harnessTypes = new Set([
  'turn/start',
  'turn/end',
  'tool/call',
  'tool/result',
  'user/message',
  'assistant/message',
])
const finishReasons = new Set(['stop', 'error', 'abort', 'max_iterations', 'completed', 'aborted'])
const errorCodes = new Set([
  ...Object.keys(proactiveErrorLabels),
  'MEMORY_REQUIRES_LOCAL_ROUTE',
  'RK_MEMORY_OFFLINE',
  'HARNESS_BRIDGE_DENIED',
  'HARNESS_TOOL_DENIED',
  'HARNESS_CALL_ID_COLLISION',
  'HARNESS_TOOL_BUSY',
  'HARNESS_RK_TOOL_ENVELOPE_INVALID',
])
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i

/** A diagnostic projection only. Never serialize provider text, tool arguments,
 * results, paths, arbitrary IDs or errors here. Replay state has separate storage.
 * allowedTools must come from the host's static capability registry, not an event.
 */
export function runtimeAuditRecord(
  sessionId: string,
  value: unknown,
  allowedTools: ReadonlySet<string>,
  recordedAt = Date.now(),
): { schema: string; recordedAt: number; sessionId?: string; event: Row } | undefined {
  const input = row(value)
  if (typeof input.type === 'string' && input.type.includes('streaming')) return
  const event: Row = {
    type: typeof input.type === 'string' && eventTypes.has(input.type) ? input.type : 'other',
  }
  let fields = input
  if (input.type === 'harness_session_event') {
    const nested = row(input.event)
    event.harnessType =
      typeof nested.type === 'string' && harnessTypes.has(nested.type) ? nested.type : 'other'
    fields = row(nested.data)
  }
  if (typeof fields.name === 'string' && allowedTools.has(fields.name)) event.name = fields.name
  if (typeof fields.finishReason === 'string' && finishReasons.has(fields.finishReason))
    event.finishReason = fields.finishReason
  const reason = row(fields.reason)
  if (typeof reason.kind === 'string' && finishReasons.has(reason.kind))
    event.finishReason = reason.kind
  const error = fields.error ?? reason.error
  if (error !== undefined && error !== null) {
    event.hasError = true
    const code = typeof error === 'string' ? error : row(error).message
    if (typeof code === 'string' && errorCodes.has(code)) event.errorCode = code
  }
  if (row(fields.message).isError === true) event.hasError = true
  if (input.type === 'coloop_consult_retry') {
    if (
      [429, 500, 502, 503, 504].includes(Number(input.status)) &&
      typeof input.status === 'number'
    )
      event.status = input.status
    if (
      Number.isInteger(input.attempt) &&
      Number(input.attempt) >= 0 &&
      Number(input.attempt) <= 10
    )
      event.attempt = input.attempt
  }
  if (input.type === 'coloop_local_protocol_retry' && input.attempt === 1) event.attempt = 1
  if (input.type === 'coloop_progress_diagnostic') {
    if (typeof input.stalled === 'boolean') event.stalled = input.stalled
    if (Number.isInteger(input.units) && Number(input.units) >= 0 && Number(input.units) <= 2000)
      event.units = input.units
    if (input.diagnostic === 'NO_MEANINGFUL_PROGRESS_15_MINUTES')
      event.diagnostic = input.diagnostic
  }
  return {
    schema: 'coloop-runtime-audit-v1',
    recordedAt,
    ...(uuid.test(sessionId) ? { sessionId: sessionId.toLowerCase() } : {}),
    event,
  }
}
