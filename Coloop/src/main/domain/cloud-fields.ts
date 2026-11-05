import { cloudFieldSchema, type CloudField } from '../../shared/contracts'
import { PrivacyVault } from './privacy-vault'

export const cloudConsultQuestions = {
  order_workflow: '根据已批准的订单字段，给出登记业务台账、准备回复和核验结果的通用步骤。',
  document_workflow: '根据已批准的字段，给出整理文档、核对内容和交付文件的通用步骤。',
  data_cleanup: '根据已批准的字段，给出数据去重、异常记录、统计和核验的通用步骤。',
  general_workflow: '给出跨应用任务中确认来源、保留已有结果、恢复错误和核验交付的通用步骤。',
} as const
export type CloudConsultKind = keyof typeof cloudConsultQuestions
export type ApprovedFact = { field: string; value: string | number }

/** The local planner selects a fixed question. Host-verified source fields are the only variable egress. */
export class CloudFields {
  private values = new Map<string, (string | number)[]>()
  private readonly approved: readonly Readonly<CloudField>[]
  private cachedFacts?: ApprovedFact[]
  constructor(approved: CloudField[]) {
    // IPC types alone do not protect internal callers or caller-owned mutable arrays.
    const parsed = cloudFieldSchema.array().max(16).parse(approved)
    if (new Set(parsed.map((field) => field.name)).size !== parsed.length)
      throw new Error('DUPLICATE_APPROVED_FIELDS')
    if (
      parsed.some((field) =>
        /password|secret|token|cookie|authorization|密码|口令|密钥|令牌/i.test(
          field.name.normalize('NFKC'),
        ),
      )
    )
      throw new Error('SECRET_FIELD_CANNOT_BE_APPROVED')
    this.approved = Object.freeze(parsed.map((field) => Object.freeze(field)))
  }
  names() {
    return this.approved.map((field) => field.name)
  }
  definitions() {
    return this.approved.map((field) => ({ ...field }))
  }
  clear() {
    this.values.clear()
    this.cachedFacts = undefined
  }
  private value(field: CloudField, source: string): string | number | undefined {
    if (field.type === 'identifier')
      return /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(source) ? source : undefined
    const number = source.replace(/^[¥￥]\s*/, '').replace(/\s*元$/, '')
    if (!/^[+-]?\d+(?:\.\d+)?$/.test(number)) return
    const value = Number(number)
    return Number.isFinite(value) ? value : undefined
  }
  capture(text: string) {
    this.cachedFacts = undefined
    for (const field of this.approved) {
      const sources = text.split(/\r?\n/).flatMap((line) => {
        const colon = line.search(/[:：]/)
        return colon >= 0 && line.slice(0, colon).trim() === field.name
          ? [line.slice(colon + 1).trim()]
          : []
      })
      if (!sources.length) continue
      const values = sources.map((source) => this.value(field, source))
      if (values.some((value) => value === undefined) || new Set(values).size !== 1)
        this.values.delete(field.name)
      else this.values.set(field.name, [values[0]!])
    }
  }
  captureCsv(columns: string[], records: { cells: string[] }[]) {
    this.cachedFacts = undefined
    for (const field of this.approved) {
      const index = columns.indexOf(field.name)
      if (index < 0) continue
      if (columns.lastIndexOf(field.name) !== index) {
        this.values.delete(field.name)
        continue
      }
      const values = records.map((record) => this.value(field, record.cells[index]?.trim() ?? ''))
      if (!values.length || values.some((value) => value === undefined))
        this.values.delete(field.name)
      else this.values.set(field.name, [...new Set(values)] as (string | number)[])
    }
  }
  facts(): ApprovedFact[] {
    // This is a task-local projection cache, never a reusable permission to send data.
    if (this.cachedFacts) return this.cachedFacts.map((fact) => ({ ...fact }))
    const facts: ApprovedFact[] = []
    for (const field of this.approved) {
      const values = this.values.get(field.name)
      if (!values) throw new Error('APPROVED_FIELD_SOURCE_REQUIRED')
      for (const value of values) facts.push({ field: field.name, value })
    }
    const vault = new PrivacyVault('approved fields', '')
    try {
      vault.assertSafe(facts)
    } finally {
      vault.dispose()
    }
    if (Buffer.byteLength(JSON.stringify(facts)) > 2000)
      throw new Error('APPROVED_FIELDS_EXCEED_BUDGET')
    this.cachedFacts = facts
    return facts.map((fact) => ({ ...fact }))
  }
}
