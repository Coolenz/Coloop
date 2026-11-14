export interface LocalModelCapacity {
  contextWindow: number
  defaultOutputTokens: number
  maximumOutputTokens: number
  source: 'health' | 'verified-profile' | 'legacy'
  fingerprint?: string
}

export interface LocalInferenceResult {
  text: string
  finishReason: 'stop' | 'length'
  requestedOutputTokens: number
  promptTokens?: number
  completionTokens?: number
}

export const legacyLocalCapacity: LocalModelCapacity = {
  contextWindow: 16384,
  defaultOutputTokens: 1024,
  maximumOutputTokens: 1024,
  source: 'legacy',
}

export const localCapacitySourceLabels = {
  health: '服务声明',
  'verified-profile': '已核对板端配置',
  legacy: '兼容配置',
}

export function localOutputBudget(
  capacity: LocalModelCapacity,
  explicit?: number,
  configured?: number,
  extraLimit?: number,
) {
  const requested = explicit ?? configured ?? capacity.defaultOutputTokens
  if (!Number.isSafeInteger(requested) || requested < 1 || requested > capacity.maximumOutputTokens)
    throw new Error(
      `LOCAL_MODEL_OUTPUT_LIMIT: 输出须为 1..${capacity.maximumOutputTokens} 的整数，请调整配置`,
    )
  return {
    tokens: Math.min(requested, extraLimit ?? requested),
    source:
      extraLimit !== undefined && extraLimit < requested
        ? 'custom-limit'
        : explicit !== undefined
          ? 'request'
          : configured !== undefined
            ? 'settings'
            : capacity.source,
  }
}

export function localOutputReserve(tokens: number) {
  return Math.max(1024, tokens + 128)
}

export function localPromptBytes(system: string, messages: readonly { content: string }[]) {
  return new TextEncoder().encode(system + messages.map((message) => message.content).join('\n'))
    .length
}
