import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }))
import { ClipboardLeaseService } from '../src/main/infrastructure/clipboard-lease'

afterEach(() => vi.clearAllMocks())
function worker(options: { error?: string; startupExit?: boolean } = {}) {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stdin: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  })
  const requests: { op: string; value: Record<string, unknown> }[] = []
  let counter = 0
  child.stdin.on('data', (chunk) => {
    for (const line of String(chunk).trim().split('\n')) {
      const request = JSON.parse(line)
      requests.push(request)
      const value =
        request.op === 'clipboard.prepare'
          ? { lease_id: 'lease-' + ++counter }
          : request.op === 'clipboard.guard'
            ? { allowed: true }
            : { status: 'restored' }
      queueMicrotask(() =>
        child.stdout.write(
          JSON.stringify({
            type: 'reply',
            id: request.id,
            ...(options.error ? { error: options.error } : { value }),
          }) + '\n',
        ),
      )
    }
  })
  child.stdin.on('finish', () => queueMicrotask(() => child.emit('exit', 0)))
  mocks.spawn.mockImplementationOnce(() => {
    queueMicrotask(() =>
      options.startupExit
        ? child.emit('exit', 1)
        : child.stdout.write('{"type":"ready","value":{}}\n'),
    )
    return child
  })
  return { child, requests }
}
describe('native clipboard lease lifecycle', () => {
  it('reuses one hidden helper and releases only leases belonging to the task', async () => {
    const { requests } = worker()
    const service = new ClipboardLeaseService('test-helper.ps1')
    await service.call('clipboard.prepare', { task_id: 'task-a', text: 'not logged' })
    await service.releaseTask('other-task')
    expect(requests.filter((row) => row.op === 'clipboard.finish')).toHaveLength(0)
    await service.releaseTask('task-a')
    expect(requests.filter((row) => row.op === 'clipboard.finish')).toHaveLength(1)
    expect(mocks.spawn).toHaveBeenCalledTimes(1)
    expect(mocks.spawn.mock.calls[0][2]).toMatchObject({ windowsHide: true })
    await service.dispose()
  })
  it('preserves fixed native guard errors rather than misreporting a window change', async () => {
    worker({ error: 'CLIPBOARD_USER_CHANGED' })
    const service = new ClipboardLeaseService('test-helper.ps1')
    await expect(
      service.call('clipboard.guard', { task_id: 't', lease_id: 'l' }),
    ).rejects.toMatchObject({ code: 'CLIPBOARD_USER_CHANGED' })
    await service.dispose()
  })
  it('cleans active leases before closing helper stdin', async () => {
    const { child, requests } = worker()
    const service = new ClipboardLeaseService('test-helper.ps1')
    await service.call('clipboard.prepare', { task_id: 't', text: 'not logged' })
    await service.dispose()
    expect(requests.at(-1)?.op).toBe('clipboard.finish')
    expect(child.stdin.writableEnded).toBe(true)
  })
  it('rejects startup exit and can establish a fresh helper for a later request', async () => {
    worker({ startupExit: true })
    worker()
    const service = new ClipboardLeaseService('test-helper.ps1')
    await expect(service.call('clipboard.guard', { task_id: 't', lease_id: 'l' })).rejects.toThrow()
    expect(await service.call('clipboard.guard', { task_id: 't', lease_id: 'l' })).toMatchObject({
      allowed: true,
    })
    await service.dispose()
  })
  it('rejects unsupported operations before creating a child', async () => {
    const service = new ClipboardLeaseService('test-helper.ps1')
    await expect(service.call('clipboard.read', {})).rejects.toThrow(
      'CLIPBOARD_OPERATION_UNSUPPORTED',
    )
    expect(mocks.spawn).not.toHaveBeenCalled()
  })
})
