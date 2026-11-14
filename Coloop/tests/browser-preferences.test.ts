import { expect, it, vi } from 'vitest'
import {
  BrowserPreferences,
  browserSettingsSchema,
  requestedBrowser,
} from '../src/main/services/browser-preferences'

function memory(initial: Record<string, unknown>[] = []) {
  const records = [...initial]
  return {
    records,
    catalog: vi.fn(async () => ({
      ok: true,
      result: { memories: records.map(({ id }) => ({ id })) },
    })),
    get: vi.fn(async () => ({ ok: true, result: { memories: records } })),
    remember: vi.fn(async (input: Record<string, unknown>) => {
      const existing = records.findIndex((item) => item.key === input.key)
      const value = { id: 'saved', kind: 'preference', ...input }
      if (existing < 0) records.push(value)
      else records[existing] = value
      return { ok: true }
    }),
  }
}
it.each([
  ['edge浏览器打开qq邮箱', 'edge'],
  ['在edge浏览器打开qq邮箱。以后的浏览器操作也用edge来', 'edge'],
  ['使用 Chrome 打开邮箱', 'chrome'],
  ['不要用 Chrome，用 Edge 打开邮箱', 'edge'],
  ['打开 https://example.com/edge', undefined],
  ['不要用edge', undefined],
])('recognizes direct browser selection in %s', (goal, browser) => {
  expect(requestedBrowser(goal)).toBe(browser)
})
it('reads existing text preferences and gives current instructions priority', async () => {
  const store = memory([
    { id: 'old', kind: 'preference', key: 'preference:coloop:web', value: '以后用 Chrome 浏览器' },
  ])
  const service = new BrowserPreferences(store)
  expect((await service.resolve('打开邮箱')).settings.browser).toBe('chrome')
  expect((await service.resolve('在 Edge 打开邮箱')).settings.browser).toBe('edge')
  expect(store.remember).not.toHaveBeenCalled()
})
it('persists explicit future preference, reads it back and applies it after service restart', async () => {
  const store = memory()
  const result = await new BrowserPreferences(store).resolve('以后用 Chrome 浏览器', 'task-1')
  expect(result.remembered).toBe(true)
  expect(store.remember).toHaveBeenCalledWith(expect.objectContaining({ source_task_id: 'task-1' }))
  expect((await new BrowserPreferences(store).resolve('打开邮箱')).settings.browser).toBe('chrome')
})
it('does not infer a future browser preference from an unrelated remember instruction', async () => {
  const store = memory()
  await new BrowserPreferences(store).resolve('记住我喜欢中文。用 Edge 打开邮箱')
  expect(store.remember).not.toHaveBeenCalled()
})
it('inspect is read-only and configuration rejects conflicting or invented instructions', async () => {
  const store = memory()
  const service = new BrowserPreferences(store)
  await service.configure({ operation: 'inspect' }, '以后用 Edge', 'task')
  expect(store.remember).not.toHaveBeenCalled()
  await expect(
    service.configure(
      { operation: 'configure', settings: { browser: 'chrome' }, source_quote: '用 Edge' },
      '用 Edge',
      'task',
    ),
  ).rejects.toThrow('BROWSER_TASK_SELECTION_CONFLICT')
  await expect(
    service.configure(
      { operation: 'configure', settings: { browser: 'chrome' }, source_quote: '用 Chrome' },
      '打开邮箱',
      'task',
    ),
  ).rejects.toThrow('BROWSER_CONFIG_REQUIRES_USER_QUOTE')
  const result = await service.configure(
    {
      operation: 'configure',
      settings: { browser: 'edge', locale: 'en-US', viewport: { width: 1280, height: 720 } },
      source_quote: '以后用 Edge',
      remember: true,
    },
    '以后用 Edge',
    'task',
  )
  expect(result.remembered).toBe(true)
  expect((await service.resolve('打开邮箱')).settings.viewport.width).toBe(1280)
})
it('reports unavailable memory and rejects unconfirmed persistence', async () => {
  const store = memory()
  store.catalog.mockRejectedValueOnce(new Error('offline'))
  expect(await new BrowserPreferences(store).resolve('用 Edge')).toMatchObject({
    memoryError: 'offline',
    settings: { browser: 'edge' },
  })
  store.remember.mockImplementation(async () => ({ ok: true }))
  await expect(new BrowserPreferences(store).resolve('以后用 Chrome')).rejects.toThrow(
    'BROWSER_PREFERENCE_READBACK_FAILED',
  )
})
it('rejects unknown launch flags and executable paths in remembered configuration', () => {
  expect(() =>
    browserSettingsSchema.parse({ browser: 'edge', args: ['--disable-web-security'] }),
  ).toThrow()
})

it('keeps a one-time selection separate from an explicitly requested future default', async () => {
  const store = memory()
  const service = new BrowserPreferences(store)
  expect((await service.resolve('这次用 Edge，以后用 Chrome')).settings.browser).toBe('edge')
  expect((await service.resolve('打开邮箱')).settings.browser).toBe('chrome')
})

it('does not treat an unrelated JSON preference as browser configuration', async () => {
  const store = memory([
    { id: 'unrelated', kind: 'preference', key: 'preference:coloop:format', value: '{}' },
    {
      id: 'browser',
      kind: 'preference',
      key: 'preference:coloop:web',
      value: '以后用 Chrome 浏览器',
    },
  ])
  expect((await new BrowserPreferences(store).resolve('打开邮箱')).settings.browser).toBe('chrome')
})
