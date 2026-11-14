/** Only non-sensitive binding facts may cross the host/RK failure boundary. */
export const editorBindingChecks = [
  'assistantAllowed',
  'window',
  'process',
  'windowRect',
  'focused',
  'targetFound',
  'targetType',
  'targetRuntimePresent',
  'targetRuntime',
  'snapshotRuntime',
  'editorRectPresent',
  'editorRect',
  'textReadable',
  'textWithinLimit',
] as const

export type EditorBindingChecks = Record<(typeof editorBindingChecks)[number], boolean>

export const inputTargetChecks = [
  'same',
  'inside',
  'elementValid',
  'focusValid',
  'observedPointMatches',
  'observedFocusMatches',
  'identityMatches',
  'assistantAllowed',
] as const
export type InputTargetChecks = Record<(typeof inputTargetChecks)[number], boolean>

export function inputTargetFailure(checks: InputTargetChecks) {
  return Object.assign(new Error('INPUT_TARGET_CHANGED'), {
    diagnostics: { category: 'input_target' as const, checks },
  })
}

export function editorBindingFailure(checks: EditorBindingChecks) {
  return Object.assign(new Error('EDITOR_BINDING_CHANGED'), {
    diagnostics: { category: 'editor_binding' as const, checks },
  })
}

export function safeInputDiagnostics(error: unknown, stage?: string) {
  if (!(error instanceof Error)) return undefined
  const diagnostics = (error as Error & { diagnostics?: unknown }).diagnostics
  if (!diagnostics || typeof diagnostics !== 'object') return undefined
  const row = diagnostics as Record<string, unknown>
  const keys =
    error.message === 'EDITOR_BINDING_CHANGED' && row.category === 'editor_binding'
      ? editorBindingChecks
      : error.message === 'INPUT_TARGET_CHANGED' && row.category === 'input_target'
        ? inputTargetChecks
        : undefined
  const actualStage = stage ?? row.stage
  if (
    !keys ||
    !row.checks ||
    typeof row.checks !== 'object' ||
    (actualStage !== undefined &&
      (typeof actualStage !== 'string' ||
        !['input.validate', 'input.guard', 'clipboard.verify'].includes(actualStage)))
  )
    return undefined
  const input = row.checks as Record<string, unknown>
  const checks: Record<string, boolean> = {}
  for (const key of keys) {
    if (Object.hasOwn(input, key) && typeof input[key] === 'boolean') checks[key] = input[key]
  }
  if (!Object.keys(checks).length) return undefined
  return {
    category: row.category,
    ...(actualStage === undefined ? {} : { stage: actualStage }),
    checks,
  }
}
