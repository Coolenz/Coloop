export interface CloudModelCapacityInput {
  baseUrl: string
  model: string
  contextWindow?: number
  maxOutputTokens?: number
}

/** Official /models and chat-completion documentation, verified 2026-11-07.
 * https://api-docs.deepseek.com/api/list-models/
 * https://api-docs.deepseek.com/api/create-chat-completion/ */
export function cloudModelCapacity(provider: CloudModelCapacityInput) {
  const officialDeepSeek =
    URL.canParse(provider.baseUrl) &&
    new URL(provider.baseUrl).origin === 'https://api.deepseek.com' &&
    [
      'deepseek-flash',
      'deepseek-v4-flash',
      'deepseek-v4-flash-vision-exp',
      'deepseek-v4-pro',
    ].includes(provider.model)
  const contextWindow = provider.contextWindow ?? (officialDeepSeek ? 1048576 : 65536)
  const maximumOutputTokens = Math.min(contextWindow, officialDeepSeek ? 393216 : 1048576)
  return {
    contextWindow,
    maxOutputTokens: Math.min(
      provider.maxOutputTokens ?? (officialDeepSeek ? 65536 : 8192),
      maximumOutputTokens,
    ),
    maximumOutputTokens,
    source:
      provider.contextWindow || provider.maxOutputTokens
        ? '手动容量配置'
        : officialDeepSeek
          ? 'DeepSeek 官方配置'
          : '兼容配置，可按服务商规格调整',
    officialDeepSeek,
  }
}
