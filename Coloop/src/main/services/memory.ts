import { z } from 'zod'
import {
  memoryBrowseSchema,
  memoryBrowseResultSchema,
  memorySaveSchema,
  memoryReviseSchema,
  memoryRemoveSchema,
} from '../../shared/memory'
import type { BoardGateway } from '../infrastructure/board'
import type { CredentialService } from './credentials'

type PrivateProvider = Pick<CredentialService, 'ensureMemoryEntry' | 'create' | 'remove' | 'open'>

export class MemoryManagementService {
  constructor(
    private board: Pick<BoardGateway, 'memories'>,
    private credentials: PrivateProvider,
  ) {}
  async browse(input: unknown) {
    this.credentials.ensureMemoryEntry()
    const parsed = memoryBrowseSchema.safeParse(input)
    if (!parsed.success) throw new Error('记忆查询条件无效')
    return memoryBrowseResultSchema.parse(
      await this.board.memories({ op: 'browse', ...parsed.data }),
    )
  }
  async save(input: unknown) {
    this.credentials.ensureMemoryEntry()
    const parsed = memorySaveSchema.safeParse(input)
    if (!parsed.success)
      throw new Error('请检查记忆名称、1–1000 字内容、最多 8 个标签及 160 字以内摘要')
    await this.board.memories({ op: 'set', ...parsed.data })
  }
  async revise(input: unknown) {
    this.credentials.ensureMemoryEntry()
    const parsed = memoryReviseSchema.safeParse(input)
    if (!parsed.success) throw new Error('请检查记忆内容、最多 8 个标签及 160 字以内摘要')
    await this.board.memories({ op: 'revise', ...parsed.data })
  }
  async remove(input: unknown) {
    this.credentials.ensureMemoryEntry()
    const parsed = memoryRemoveSchema.safeParse(input)
    if (!parsed.success) throw new Error('记忆记录已失效，请刷新列表')
    if (parsed.data.category === 'private') {
      await this.credentials.remove(parsed.data.recordId)
      await this.board.memories({ op: 'sync_private' })
    } else await this.board.memories({ op: 'remove_record', id: parsed.data.id })
  }
  async createPrivate(input: unknown) {
    this.credentials.ensureMemoryEntry()
    const record = await this.credentials.create(input)
    try {
      const result = z
        .object({ private_memory: z.object({ available: z.literal(true) }) })
        .safeParse(await this.board.memories({ op: 'sync_private' }))
      return { record, indexed: result.success }
    } catch {
      return { record, indexed: false }
    }
  }
  async openPrivate(id: unknown, developmentUrl?: string) {
    this.credentials.ensureMemoryEntry()
    await this.board.memories({ op: 'sync_private' })
    return this.credentials.open(z.uuid().parse(id), developmentUrl)
  }
}
