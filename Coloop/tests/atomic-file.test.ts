import { expect, it, vi } from 'vitest'
import { renameSync } from 'node:fs'
import { replaceFileSync } from '../src/main/infrastructure/atomic-file'

vi.mock('node:fs', () => ({ renameSync: vi.fn() }))

it('retries a transient Windows sharing lock without removing the destination', () => {
  const rename = vi.mocked(renameSync)
  rename.mockReset()
  if (process.platform === 'win32')
    rename.mockImplementationOnce(() => {
      throw Object.assign(new Error('sharing lock'), { code: 'EPERM' })
    })
  replaceFileSync('temporary', 'destination')
  expect(rename).toHaveBeenLastCalledWith('temporary', 'destination')
  expect(rename).toHaveBeenCalledTimes(process.platform === 'win32' ? 2 : 1)
})

it('propagates persistent permission failures and other filesystem errors', () => {
  const rename = vi.mocked(renameSync)
  rename.mockReset().mockImplementation(() => {
    throw Object.assign(new Error('denied'), { code: 'EACCES' })
  })
  expect(() => replaceFileSync('temporary', 'destination')).toThrow('denied')
  expect(rename).toHaveBeenCalledTimes(process.platform === 'win32' ? 5 : 1)
  rename.mockReset().mockImplementation(() => {
    throw Object.assign(new Error('missing'), { code: 'ENOENT' })
  })
  expect(() => replaceFileSync('temporary', 'destination')).toThrow('missing')
  expect(rename).toHaveBeenCalledTimes(1)
})
