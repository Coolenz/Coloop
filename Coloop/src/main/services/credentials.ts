import { z } from 'zod'
import {
  credentialCreateSchema,
  credentialRecordSchema,
  credentialFieldSchema,
} from '../../shared/credentials'
import { credentialOrigin } from '../domain/credential-policy'
import type { BoardGateway } from '../infrastructure/board'
import { PrivateLoginWindow } from '../infrastructure/private-login'

export class CredentialService {
  private entry = false
  private privateEntry = false
  private login?: PrivateLoginWindow
  private opening = false
  constructor(
    private board: BoardGateway,
    private canProtect: () => boolean,
    private onChange: () => void,
    private clearCaptures: () => void,
  ) {}
  snapshot() {
    return {
      protected: this.entry || this.privateEntry || !!this.login || this.opening,
      loginOpen: !!this.login,
      editorOpen: this.privateEntry,
    }
  }
  assertObservationAllowed() {
    if (this.snapshot().protected)
      throw new Error(
        '私密凭据操作期间暂停截图、OCR、模型任务和会话控制，请先离开凭据页并关闭登录窗口',
      )
  }
  protect(value: boolean) {
    if (value && !this.entry && !this.canProtect())
      throw new Error('请先结束当前任务、OCR、审批或电脑控制，再打开私密凭据')
    this.entry = value
    if (value) this.clearCaptures()
    this.onChange()
  }
  ensureMemoryEntry() {
    if (!this.entry)
      throw new Error('请先进入私密管理模式，可打开记忆页面或调用 credentials:protect')
  }
  protectPrivateEntry(value: boolean) {
    if (value) {
      this.ensureMemoryEntry()
      if (!this.canProtect() || this.login || this.opening)
        throw new Error('请先结束其他任务并关闭私密登录窗口')
      this.clearCaptures()
    }
    this.privateEntry = value
    this.onChange()
  }
  async list() {
    const data = z
      .object({ version: z.literal(1), records: z.array(credentialRecordSchema).max(100) })
      .strict()
      .parse(await this.board.credentials({ op: 'list' }))
    return data.records
  }
  async create(input: unknown) {
    this.ensureMemoryEntry()
    // Discard Zod issues: they may contain user-provided data in future versions.
    const parsed = credentialCreateSchema.safeParse(input)
    if (!parsed.success) throw new Error('网站格式无效，或账号密码不是 1–64 个英文、数字与键盘符号')
    const data = parsed.data
    credentialOrigin(data.origin)
    return credentialRecordSchema.parse(await this.board.credentials({ op: 'create', ...data }))
  }
  async remove(id: unknown) {
    this.ensureMemoryEntry()
    const result = await this.board.credentials({ op: 'delete', id: z.uuid().parse(id) })
    z.object({ deleted: z.literal(true) })
      .strict()
      .parse(result)
  }
  async open(id: unknown, developmentUrl?: string) {
    this.ensureMemoryEntry()
    if (!this.canProtect()) throw new Error('请先结束其他任务')
    if (this.login || this.opening || this.privateEntry) throw new Error('请先关闭当前私密窗口')
    this.opening = true
    this.clearCaptures()
    this.onChange()
    try {
      const record = (await this.list()).find((item) => item.id === z.uuid().parse(id))
      if (!record) throw new Error('凭据记录已不存在，请刷新列表')
      credentialOrigin(record.origin)
      const login = new PrivateLoginWindow(record, this.board, () => {
        if (this.login === login) this.login = undefined
        this.onChange()
      })
      this.login = login
      await login.open(developmentUrl)
    } catch (error) {
      this.login?.close()
      throw error
    } finally {
      this.opening = false
      this.onChange()
    }
  }
  close() {
    this.login?.close()
  }
  async fill(input: unknown) {
    this.ensureMemoryEntry()
    if (!this.login) throw new Error('请先打开私密登录窗口')
    const { field, index } = z
      .object({
        field: credentialFieldSchema,
        index: z.number().int().min(0).default(0),
      })
      .strict()
      .parse(input)
    return this.login.fill(field, index)
  }
}
