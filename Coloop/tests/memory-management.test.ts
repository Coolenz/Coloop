import { describe, expect, it, vi } from 'vitest'
import { MemoryManagementService } from '../src/main/services/memory'
import { privateMemorySchema, memorySaveSchema } from '../src/shared/memory'

function setup() {
  const board = {
    memories: vi.fn(async (_input: Record<string, unknown>): Promise<unknown> => ({
      private_memory: { available: true },
    })),
  }
  const credentials = {
    ensureMemoryEntry: vi.fn(),
    create: vi.fn(async () => ({
      id: 'a81326a0-dc28-40b6-876a-65d23473722a',
      origin: 'https://example.com',
      createdAt: 1,
    })),
    remove: vi.fn(async () => {}),
    open: vi.fn(async () => {}),
  }
  return { board, credentials, service: new MemoryManagementService(board, credentials) }
}
describe('unified memory management', () => {
  it('filters tags across pages before applying title order and pagination', async () => {
    const { board, service } = setup()
    const item = (id: string, key: string, tags: string[]) => ({
      id,
      key,
      tags,
      category: 'ordinary',
      text: key,
      kind: 'fact',
      source: 'test',
      verified: true,
      expiresAt: null,
    })
    board.memories.mockImplementation(async (input) => ({
      mode: 'all',
      items: input.offset === 0 ? [item('one', 'Z', ['project'])] : [item('two', 'A', ['project'])],
      total: 2,
      offset: input.offset,
      limit: input.limit,
      private_memory: { enabled: true, available: true, records: 0 },
    }))
    const result = await service.browse({
      category: 'ordinary',
      tag: 'project',
      sort: 'title',
      limit: 1,
    })
    expect(result.total).toBe(2)
    expect(result.items[0].id).toBe('two')
    expect(
      board.memories.mock.calls.every(
        ([request]) => request.tag === undefined && request.sort === undefined,
      ),
    ).toBe(true)
  })
  it('forwards tags and catalog summaries without allowing provenance promotion', async () => {
    const { board, service } = setup()
    await service.save({
      key: 'outline',
      value: '实际内容',
      kind: 'procedure',
      tags: ['app:notepad'],
      summary: '文档提纲',
    })
    expect(board.memories).toHaveBeenLastCalledWith({
      op: 'set',
      key: 'outline',
      value: '实际内容',
      kind: 'procedure',
      tags: ['app:notepad'],
      summary: '文档提纲',
    })
    await service.revise({
      id: 'a81326a0-dc28-40b6-876a-65d23473722a',
      value: '更新',
      tags: [],
      summary: '',
    })
    expect(board.memories).toHaveBeenLastCalledWith({
      op: 'revise',
      id: 'a81326a0-dc28-40b6-876a-65d23473722a',
      value: '更新',
      tags: [],
      summary: '',
    })
    await expect(
      service.save({ key: 'bad', value: '内容', kind: 'fact', tags: Array(9).fill('app:test') }),
    ).rejects.toThrow('标签')
    expect(
      memorySaveSchema.safeParse({ key: 'bad', value: '内容', kind: 'fact', verified: true })
        .success,
    ).toBe(false)
  })
  it('sends private plaintext only to the credential provider and indexes only metadata', async () => {
    const { board, credentials, service } = setup()
    const secret = {
      origin: 'https://example.com',
      username: 'PRIVATE_USER',
      password: 'PRIVATE_PASSWORD',
    }
    expect((await service.createPrivate(secret)).indexed).toBe(true)
    expect(credentials.create).toHaveBeenCalledWith(secret)
    expect(board.memories).toHaveBeenCalledWith({ op: 'sync_private' })
    expect(JSON.stringify(board.memories.mock.calls)).not.toContain('PRIVATE_PASSWORD')
    expect(JSON.stringify(board.memories.mock.calls)).not.toContain('PRIVATE_USER')
  })
  it('preserves a successful save when indexing is unavailable, without retrying the save', async () => {
    const { board, credentials, service } = setup()
    board.memories.mockRejectedValue(new Error('offline'))
    expect((await service.createPrivate({})).indexed).toBe(false)
    expect(credentials.create).toHaveBeenCalledTimes(1)
  })
  it('uses the ordinary API for normal edits and the protected provider for private deletion', async () => {
    const { board, credentials, service } = setup()
    await service.save({ key: 'theme', value: 'dark', kind: 'preference' })
    expect(board.memories).toHaveBeenLastCalledWith({
      op: 'set',
      key: 'theme',
      value: 'dark',
      kind: 'preference',
    })
    const id = 'a81326a0-dc28-40b6-876a-65d23473722a'
    await service.remove({ category: 'private', recordId: id })
    expect(credentials.remove).toHaveBeenCalledWith(id)
    expect(board.memories).toHaveBeenLastCalledWith({ op: 'sync_private' })
    expect(
      memorySaveSchema.safeParse({ key: 'private:credential:' + id, value: 'fake', kind: 'fact' })
        .success,
    ).toBe(false)
    expect(
      privateMemorySchema.safeParse({
        id,
        category: 'private',
        recordId: id,
        origin: 'https://example.com',
        locator: 'rk-vault://' + id,
        resolver: 'coloop_private_login',
        protected: true,
        password: 'leak',
      }).success,
    ).toBe(false)
  })
})
