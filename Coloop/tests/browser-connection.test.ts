import { expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  discoverBrowserEndpoint,
  localBrowserEndpointSchema,
} from '../src/main/infrastructure/browser-connection'

it('accepts only local CDP endpoints', () => {
  expect(localBrowserEndpointSchema.parse('ws://127.0.0.1:9222/devtools/browser/abc')).toContain(
    '9222',
  )
  for (const url of [
    'https://example.com',
    'http://example.com:9222',
    'http://user:secret@localhost:9222',
  ])
    expect(() => localBrowserEndpointSchema.parse(url)).toThrow()
})
it('discovers native Edge endpoint without copying profile data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'coloop-edge-discovery-'))
  try {
    await expect(discoverBrowserEndpoint('edge', root)).rejects.toThrow(
      'BROWSER_CONNECTION_REQUIRED',
    )
    const directory = join(root, 'Microsoft', 'Edge', 'User Data')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'DevToolsActivePort'), '9222\n/devtools/browser/test-id\n')
    expect(await discoverBrowserEndpoint('edge', root)).toBe(
      'ws://127.0.0.1:9222/devtools/browser/test-id',
    )
    await writeFile(join(directory, 'DevToolsActivePort'), '70000\n/invalid\n')
    await expect(discoverBrowserEndpoint('edge', root)).rejects.toThrow('BROWSER_DISCOVERY_INVALID')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
