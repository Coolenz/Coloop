import { expect, it } from 'vitest'
import { BrowserPreferences } from '../src/main/services/browser-preferences'
import { WebReader } from '../src/main/infrastructure/web-reader'

it.runIf(process.platform === 'win32')(
  'applies memory and current-task selection to real Stagehand and Playwright browsers',
  async () => {
    let saved: Record<string, unknown> | undefined
    const memory = {
      catalog: async () => ({ ok: true, result: { memories: saved ? [{ id: 'browser' }] : [] } }),
      get: async () => ({ ok: true, result: { memories: saved ? [saved] : [] } }),
      remember: async (input: Record<string, unknown>) => {
        saved = { id: 'browser', kind: 'preference', ...input }
        return { ok: true }
      },
    }
    const reader = new WebReader(true, new BrowserPreferences(memory))
    const controller = new AbortController()
    const complete = async () => {
      throw new Error('NO_MODEL_REQUEST_EXPECTED')
    }
    try {
      const chrome = await reader.session(
        '以后用 Chrome 浏览器',
        controller.signal,
        complete,
        'remember-task',
      )
      expect(chrome.browserInfo).toMatchObject({
        remembered: true,
        verified: true,
        actual: { browser: 'chrome' },
      })
      expect(
        String((chrome.browserInfo?.actual as Record<string, unknown>).userAgent),
      ).not.toContain('Edg/')
      await chrome.dispose()
      const edge = await reader.session(
        '这次用 Edge 打开邮箱',
        controller.signal,
        complete,
        'edge-task',
      )
      expect(edge.browserInfo).toMatchObject({
        source: 'task',
        settings: { browser: 'edge' },
        actual: { browser: 'edge' },
      })
      expect(String((edge.browserInfo?.actual as Record<string, unknown>).userAgent)).toContain(
        'Edg/',
      )
      await edge.dispose()
      const restarted = new WebReader(true, new BrowserPreferences(memory))
      try {
        const recalled = await restarted.session('打开邮箱', controller.signal)
        expect(recalled.browserInfo).toMatchObject({
          source: 'memory',
          settings: { browser: 'chrome' },
          actual: { browser: 'chrome' },
        })
        await recalled.dispose()
      } finally {
        await restarted.dispose()
      }
    } finally {
      await reader.dispose()
    }
  },
  45000,
)
