import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { afterEach, expect, it, vi } from 'vitest'
import { stagehandExecutablePath } from '../src/main/infrastructure/browser-executable'

vi.mock('node:fs', () => ({ existsSync: vi.fn() }))
afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetAllMocks()
})

it('preserves an explicit runtime executable override', () => {
  expect(stagehandExecutablePath('D:/browser/custom.exe')).toBe('D:/browser/custom.exe')
  expect(existsSync).not.toHaveBeenCalled()
})

it.runIf(process.platform === 'win32')(
  'selects installed Edge even when CHROME_PATH is set',
  () => {
    vi.stubEnv('PROGRAMFILES(X86)', 'D:/apps-x86')
    vi.stubEnv('PROGRAMFILES', 'D:/apps')
    vi.stubEnv('LOCALAPPDATA', 'D:/user')
    vi.stubEnv('CHROME_PATH', 'D:/chrome/chrome.exe')
    const expected = join('D:/apps-x86', 'Microsoft', 'Edge', 'Application', 'msedge.exe')
    vi.mocked(existsSync).mockImplementation((path) => path === expected)
    expect(stagehandExecutablePath()).toBe(expected)
  },
)

it.runIf(process.platform === 'win32').each(['PROGRAMFILES', 'LOCALAPPDATA'])(
  'finds Edge installed under %s',
  (variable) => {
    vi.stubEnv('PROGRAMFILES(X86)', 'D:/apps-x86')
    vi.stubEnv('PROGRAMFILES', 'D:/apps')
    vi.stubEnv('LOCALAPPDATA', 'D:/user')
    const expected = join(process.env[variable]!, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
    vi.mocked(existsSync).mockImplementation((path) => path === expected)
    expect(stagehandExecutablePath()).toBe(expected)
  },
)

it.runIf(process.platform === 'win32')(
  'reports missing Edge instead of SDK browser discovery',
  () => {
    vi.mocked(existsSync).mockReturnValue(false)
    expect(() => stagehandExecutablePath()).toThrow('EDGE_BROWSER_NOT_FOUND')
  },
)
