import type { HarnessRuntimeOptions } from './harness-runtime'

const reads = new Set([
  'help',
  'list',
  'read_text',
  'read_csv',
  'read_document',
  'read_structured',
  'read_workbook',
  'read_pdf',
  'read_image',
  'wait_file',
  'verify_pdf',
])

/** Only these exact interrupted operations may be freshly requested. No old
 * action is replayed and no previous observation or completion proof survives. */
export const reconcileReadOnly: NonNullable<HarnessRuntimeOptions['reconcileUnknown']> = (
  intent,
) => {
  if (
    [
      'coloop_observe',
      'coloop_read_editor',
      'coloop_verify',
      'coloop_verify_artifact',
      'coloop_memory_catalog',
      'coloop_memory_get',
      'coloop_memory_search',
      'coloop_ask_user',
      'coloop_file_help',
      'coloop_enable_tools',
    ].includes(intent.name)
  )
    return { kind: 'retry_read_only' }
  if (reads.has(intent.name.replace(/^coloop_/, '')) && intent.name.startsWith('coloop_'))
    return { kind: 'retry_read_only' }
  const args = intent.arguments as { operation?: unknown } | null
  if (
    intent.name === 'coloop_workspace' &&
    typeof args?.operation === 'string' &&
    reads.has(args.operation)
  )
    return { kind: 'retry_read_only' }
  if (
    intent.name === 'coloop_web' &&
    ['observe', 'discover', 'extract', 'verify'].includes(String(args?.operation))
  )
    return { kind: 'retry_read_only' }
  return undefined
}
