import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** Match WebReader's msedge channel for the Stagehand launch path on Windows. */
export function stagehandExecutablePath(
  override?: string,
  browser: 'edge' | 'chrome' = 'edge',
): string | undefined {
  if (override) return override
  if (process.platform !== 'win32') return undefined
  const roots = [
    process.env['PROGRAMFILES(X86)'],
    process.env.PROGRAMFILES,
    process.env.LOCALAPPDATA,
  ]
  for (const root of roots) {
    if (!root) continue
    const executable =
      browser === 'edge'
        ? join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
        : join(root, 'Google', 'Chrome', 'Application', 'chrome.exe')
    if (existsSync(executable)) return executable
  }
  throw new Error(
    browser === 'edge'
      ? 'EDGE_BROWSER_NOT_FOUND：未找到 Microsoft Edge，请安装 Edge 后重试。'
      : 'CHROME_BROWSER_NOT_FOUND：未找到 Google Chrome，请安装 Chrome 后重试。',
  )
}
