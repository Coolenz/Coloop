import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'

export const localBrowserEndpointSchema = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value)
    return (
      ['http:', 'ws:'].includes(url.protocol) &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) &&
      !url.username &&
      !url.password
    )
  }, 'Browser connection must use a local loopback endpoint')

export async function discoverBrowserEndpoint(
  browser: 'edge' | 'chrome',
  localAppData = process.env.LOCALAPPDATA,
) {
  if (!localAppData) throw new Error('BROWSER_USER_DATA_LOCATION_UNAVAILABLE')
  const directory =
    browser === 'edge'
      ? join(localAppData, 'Microsoft', 'Edge', 'User Data')
      : join(localAppData, 'Google', 'Chrome', 'User Data')
  let discovery: string
  try {
    discovery = await readFile(join(directory, 'DevToolsActivePort'), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    throw new Error(
      'BROWSER_CONNECTION_REQUIRED：请在现有浏览器的 inspect 页面允许远程调试，再重试连接。',
    )
  }
  const [portText, path] = discovery.trim().split(/\r?\n/)
  const port = Number(portText)
  if (
    !/^\d+$/.test(portText) ||
    port < 1 ||
    port > 65535 ||
    !/^\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(path)
  )
    throw new Error('BROWSER_DISCOVERY_INVALID')
  return localBrowserEndpointSchema.parse(`ws://127.0.0.1:${port}${path}`)
}
