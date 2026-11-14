import type { PermissionMode } from '../../shared/conversations'

const internalTools = new Set([
  'coloop_ask_user',
  'coloop_enable_tools',
  'coloop_file_help',
  'coloop_conversation_history',
])
const readTools = new Set([
  'coloop_observe',
  'coloop_read_editor',
  'coloop_verify',
  'coloop_verify_artifact',
  'coloop_memory_search',
  'coloop_memory_catalog',
  'coloop_memory_get',
  'coloop_read_web',
])
const readOperations = new Set([
  'list',
  'read_text',
  'read_document',
  'read_structured',
  'inspect',
  'stat',
  'search',
])

/** Unknown tools and general-purpose execution always require approval in auto mode. */
export function requiresTaskApproval(
  mode: PermissionMode | undefined,
  name: string,
  args: unknown,
): boolean {
  if (!mode || mode === 'full' || internalTools.has(name)) return false
  if (mode === 'ask') return true
  if (readTools.has(name)) return false
  const operation =
    args && typeof args === 'object' ? (args as Record<string, unknown>).operation : undefined
  if (name === 'coloop_workspace' && typeof operation === 'string')
    return !readOperations.has(operation)
  if (readOperations.has(name.replace(/^coloop_/, ''))) return false
  if (name === 'coloop_web') return !['snapshot', 'verify'].includes(String(operation))
  return ![
    'mcp__playwright__browser_snapshot',
    'mcp__playwright__browser_take_screenshot',
    'mcp__playwright__browser_console_messages',
    'mcp__playwright__browser_network_requests',
  ].includes(name)
}
