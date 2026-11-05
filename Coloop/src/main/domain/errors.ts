import { ZodError } from 'zod'
import { proactiveErrorLabels } from '../../shared/proactive'

export function errorMessage(error: unknown): string {
  if (error instanceof ZodError)
    return error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('；')
  if (error instanceof Error) {
    if (error.message.startsWith('MODEL_') && proactiveErrorLabels[error.message])
      return proactiveErrorLabels[error.message]
    if (error.name === 'AbortError') return '操作已取消'
    if (error.name === 'TimeoutError') return '请求超时，请检查连接后重试'
    return error.message.slice(0, 1000)
  }
  return '操作失败，请重试'
}
