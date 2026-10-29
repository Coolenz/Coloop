import type { DesktopApi, Result } from '../../shared/contracts'
export const api = window.coloop as DesktopApi
export async function unwrap<T>(promise: Promise<Result<T>>): Promise<T> {
  const result = await promise
  if (!result.ok) throw new Error(result.error)
  return result.value
}
