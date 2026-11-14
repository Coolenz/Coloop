import { expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ModelDebugService } from '../src/main/services/model-debug'
it('tests the selected model, cancels waiting work and exports metadata without prompt contents', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'coloop-debug-test-'))
  let busy = true
  const complete = vi.fn(async (_request, _signal, onText) => {
    onText('连接正常')
    return '连接正常'
  })
  const service = new ModelDebugService(directory, {
    model: () => 'fixture',
    localBusy: () => busy,
    complete,
    route: async () => ({ route: 'cloud', source: 'model', elapsedMs: 1 }),
    changed: () => {},
  })
  try {
    const waiting = service.start({ target: 'local', prompt: 'secret-canary' })
    expect(service.get(waiting).state).toBe('waiting')
    service.cancel(waiting)
    await vi.waitFor(() => expect(service.get(waiting).state).toBe('cancelled'))
    expect(complete).not.toHaveBeenCalled()
    busy = false
    const run = service.start({ target: 'cloud', prompt: 'secret-canary' })
    await vi.waitFor(() => expect(service.get(run).state).toBe('completed'))
    expect(service.get(run).text).toBe('连接正常')
    await vi.waitFor(async () => expect((await service.diagnostics()).length).toBe(2))
    expect(JSON.stringify(await service.diagnostics())).not.toContain('secret-canary')
  } finally {
    service.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})
