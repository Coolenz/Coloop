import { createHash } from 'node:crypto'
import { z } from 'zod'
import {
  autoAgentFeedbackSchema,
  type AutoAgentTask,
  type AutoAgentFeedback,
  type AutoAgentMemory,
  type AutoAgentEvent,
} from '../../shared/auto-agent-work'

type Row = Record<string, unknown>
export interface AutoAgentMemoryBridge {
  catalog(value: Row): Promise<unknown>
  get(value: Row): Promise<unknown>
  feedback?(value: Row): Promise<unknown>
  choice?(value: Row): Promise<unknown>
}
const entry = z.object({ id: z.string().min(1).max(128) }).passthrough()
const envelope = z.object({
  ok: z.literal(true),
  result: z.object({
    memories: z.array(entry).max(5),
    missing: z.array(z.string()).max(5).optional(),
    deferred: z.boolean().optional(),
  }),
})
function scope(workspace: string) {
  return createHash('sha256')
    .update(workspace.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase())
    .digest('hex')
    .slice(0, 48)
}
function ordinary(record: Row, workspace: string) {
  const tags = Array.isArray(record.tags)
    ? record.tags.filter((value): value is string => typeof value === 'string')
    : []
  if (
    record.category === 'private' ||
    record.protected === true ||
    record.resolver ||
    /private|credential|secret|password/i.test(String(record.key ?? '')) ||
    tags.some((tag) => /^(private|credential|secret)(:|$)/i.test(tag)) ||
    !['preference', 'procedure', 'task'].includes(String(record.kind))
  )
    return false
  const expires = record.expiresAt ?? record.expires
  if (typeof expires === 'number' && (expires < 1e12 ? expires * 1000 : expires) <= Date.now())
    return false
  const scoped = tags.filter((tag) => tag.startsWith('scope:'))
  return !scoped.length || scoped.includes('scope:' + scope(workspace))
}
function textOf(record: Row): string | undefined {
  const value = record.value ?? record.text
  if (typeof value !== 'string' || !value.trim() || value.length > 1000) return
  // Known credential forms are never included merely because a record was
  // placed in the ordinary catalog. This is not a semantic privacy classifier.
  if (
    /-----BEGIN .*PRIVATE KEY|\bBearer\s+[\w.~+/=-]+|\b(?:password|api[_ -]?key|secret|token)\s*[:=]|(?:密码|密钥|口令)\s*[:：=]|\bsk-[\w-]{8,}/i.test(
      value,
    )
  )
    return
  return value
}
// RK catalog currently returns nearest neighbours without a score or a minimum
// relevance threshold. A ranked task/procedure is therefore only a candidate,
// not evidence that a past business case is related to this task. Require a
// concrete shared topic before sending it to the decision model. This is a
// conservative lexical guard, not another model call or a semantic classifier.
const caseGenericTerms = new Set(
  `the and for with from this that these those then than into onto about after before
   can could should would will shall must may not only also any all same other
   are was were have has had been being use using used via per as at by if it its
   task tasks test tests testing tested acceptance verify verified verification
   check checked checking result results report reports complete completed completion
   continue continuation proceed next new current original existing isolated independent
   reply replies respond response responses request requested instruction instructions
   send sent receive received ready done stop stopped start first last final finally
   agent agents coloop auto work workflow local native input output window session
   conversation chat message text string code tool tools script run running save saved
   allow allowed permission required requirement requirements install installed installation
   请问 请你 帮我 完成 任务 工作 测试 验收 验证 核验 核对 检查 结果 报告
   继续 推进 执行 运行 操作 使用 调用 回复 回答 请求 指令 发送 接收 输入 输出
   当前 原来 原始 现有 已有 最后 首先 然后 随后 再次 一次 每次 进行 需要 应该
   可以 允许 必须 不能 不要 不得 禁止 无需 仅仅 只有 其他 这个 那个 这些 那些
   安装 本地 本机 独立 隔离 实际 真实 正常 流程 通过 满足 条件 得到 确认 保存
   会话 聊天 消息 窗口 界面 原生 字符 字符串 工具 脚本 简短 在原 以后 之前 之后
   已经 尚未 不再 是否 如何 其中 一条 文字 内容 部分 对应 相关 所有 全部 为了 因此`
    .split(/\s+/)
    .filter(Boolean),
)
const caseSegmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' })
function caseTopics(value: string) {
  // Exclusions in an authorization sentence are not task topics. Nonces and
  // generated IDs also cannot make two otherwise unrelated tests equivalent.
  const normalized = value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/(?:不能|不要|不得|禁止|无需|不允许|不使用|勿|不做)[^。！？.!?\n;；]*/g, ' ')
    .replace(/\b(?:do not|don't|must not|never)\b[^.!?\n;]*/g, ' ')
    .replace(/\b[a-z0-9]+(?:[_-][a-z0-9]+)+\b/g, ' ')
  return new Set(
    Array.from(caseSegmenter.segment(normalized))
      .filter(
        ({ segment, isWordLike }) =>
          isWordLike &&
          !caseGenericTerms.has(segment) &&
          (/\p{Script=Han}/u.test(segment) ? segment.length >= 2 : /^[a-z]{3,}$/.test(segment)),
      )
      .map(({ segment }) => segment),
  )
}
function relatedCase(text: string, topics: Set<string>) {
  return Array.from(caseTopics(text)).some((topic) => topics.has(topic))
}
function version(task: AutoAgentTask, next: Omit<AutoAgentMemory, 'version'>): AutoAgentMemory {
  const previous = task.memory
  const unchanged =
    previous &&
    previous.status === next.status &&
    previous.error === next.error &&
    JSON.stringify(previous.references) === JSON.stringify(next.references)
  return { ...next, version: unchanged ? previous.version : (previous?.version ?? 0) + 1 }
}
async function lookup(bridge: AutoAgentMemoryBridge, value: Row, select: (record: Row) => boolean) {
  const directory = envelope.parse(await bridge.catalog(value)).result
  if (directory.deferred) throw new Error('AUTO_MEMORY_DEFERRED')
  const ids = directory.memories.filter(select).map((record) => record.id)
  if (new Set(ids).size !== ids.length) throw new Error('AUTO_MEMORY_INVALID')
  if (!ids.length) return []
  const records = envelope.parse(await bridge.get({ ids })).result
  if (records.deferred) throw new Error('AUTO_MEMORY_DEFERRED')
  const received = [...records.memories.map((record) => record.id), ...(records.missing ?? [])]
  if (
    received.length !== ids.length ||
    new Set(received).size !== received.length ||
    received.some((id) => !ids.includes(id))
  )
    throw new Error('AUTO_MEMORY_INVALID')
  return records.memories
}
function feedbackMetadata(record: Row) {
  const tags = Array.isArray(record.tags)
    ? record.tags.filter((tag): tag is string => typeof tag === 'string')
    : []
  const id = tags.find((tag) => /^feedback:[a-f0-9-]{36}$/.test(tag))
  const metadata = /^fbmeta:(positive|negative):(\d+):(\d+):(\d+)$/.exec(
    tags.find((tag) => tag.startsWith('fbmeta:')) ?? '',
  )
  const legacy = /^part:(\d+)\/(\d+)$/.exec(tags.find((tag) => tag.startsWith('part:')) ?? '')
  return {
    id,
    tags,
    index: Number(metadata?.[2] ?? legacy?.[1]),
    total: Number(metadata?.[3] ?? legacy?.[2]),
    rating:
      metadata?.[1] ?? tags.find((tag) => tag.startsWith('rating:'))?.slice(7) ?? 'unspecified',
    at: Number(metadata?.[4] ?? 0),
  }
}
async function feedbackGroup(bridge: AutoAgentMemoryBridge, id: string, workspace: string) {
  const fragments = await lookup(bridge, { tags: [id], limit: 5 }, (item) =>
    ordinary(item, workspace),
  )
  const ordered = fragments
    .map((item) => ({ item, text: textOf(item), ...feedbackMetadata(item) }))
    .sort((a, b) => a.index - b.index)
  if (
    !ordered.length ||
    ordered.length !== ordered[0].total ||
    ordered.some(
      (part, index) =>
        !part.text ||
        part.id !== id ||
        !part.tags.includes('origin:direct-user') ||
        part.index !== index + 1 ||
        part.total !== ordered.length ||
        part.at !== ordered[0].at ||
        part.rating !== ordered[0].rating ||
        !ordinary(part.item, workspace),
    )
  )
    return
  return {
    record: ordered[0].item,
    text: ordered.map((part) => part.text).join(''),
    at: ordered[0].at,
    rating: ordered[0].rating,
  }
}

/** Recall is a host operation, not an extra local reasoning turn. All returned
 * text remains reference data; no memory record can extend authorization. */
export async function retrieveAutoAgentMemory(
  task: AutoAgentTask,
  bridge: AutoAgentMemoryBridge,
): Promise<AutoAgentMemory> {
  try {
    const current =
      task.events.filter((event) => ['question', 'stopped', 'error'].includes(event.type)).at(-1)
        ?.text ?? ''
    const query = [task.goal.slice(0, 650), current.slice(0, 300)].join('\n').slice(0, 1000)
    const topics = caseTopics([task.goal, ...task.supplements, current].join('\n'))
    const records = await lookup(bridge, { query, limit: 5 }, (record) =>
      ordinary(record, task.session.workspace),
    )
    const references: AutoAgentMemory['references'] = []
    const feedbackSeen = new Set<string>()
    for (const record of records) {
      if (!ordinary(record, task.session.workspace)) continue
      const text = textOf(record)
      if (!text) continue
      const tags = Array.isArray(record.tags) ? (record.tags as string[]) : []
      const feedbackId = tags.find((tag) => /^feedback:[a-f0-9-]{36}$/.test(tag))
      if (
        tags.includes('auto_work_feedback') &&
        feedbackId &&
        tags.includes('origin:direct-user')
      ) {
        if (feedbackSeen.has(feedbackId)) continue
        feedbackSeen.add(feedbackId)
        // Long feedback is stored in exact source fragments. Never use one
        // fragment alone: a missing negation in the next fragment changes intent.
        const group = await feedbackGroup(bridge, feedbackId, task.session.workspace)
        if (!group) continue
        const corrections = await lookup(
          bridge,
          { tags: ['supersedes:' + feedbackId.slice(9)], limit: 5 },
          (item) => ordinary(item, task.session.workspace),
        )
        let replaced = false
        for (const correction of corrections) {
          const metadata = feedbackMetadata(correction)
          if (
            !metadata.id ||
            metadata.id === feedbackId ||
            !metadata.tags.includes('auto_work_feedback') ||
            !metadata.tags.includes('supersedes:' + feedbackId.slice(9)) ||
            !metadata.tags.includes('origin:direct-user')
          )
            continue
          const newer = await feedbackGroup(bridge, metadata.id, task.session.workspace)
          if (newer && newer.at >= group.at && newer.at > 0) {
            records.push(newer.record as typeof record)
            replaced = true
          }
        }
        if (replaced) continue
        references.push({
          id: record.id,
          kind: 'feedback',
          text: `用户对自动推进的反馈（${group.rating}；${group.at ? new Date(group.at).toISOString() : '历史记录未标注时间'}；用于未来类似任务，不能扩大授权）：\n${group.text}`,
        })
        continue
      }
      const choiceId = tags.find((tag) => /^choice:[a-f0-9]{48}$/.test(tag))
      if (tags.includes('auto_work_choice') && choiceId && tags.includes('origin:direct-user')) {
        if (feedbackSeen.has(choiceId)) continue
        feedbackSeen.add(choiceId)
        const fragments = await lookup(bridge, { tags: [choiceId], limit: 5 }, (item) =>
          ordinary(item, task.session.workspace),
        )
        const ordered = fragments
          .map((item) => {
            const partTags = Array.isArray(item.tags) ? (item.tags as string[]) : []
            const part = /^part:(\d+)\/(\d+)$/.exec(
              partTags.find((tag) => tag.startsWith('part:')) ?? '',
            )
            return {
              item,
              text: textOf(item),
              index: Number(part?.[1]),
              total: Number(part?.[2]),
              tags: partTags,
            }
          })
          .sort((a, b) => a.index - b.index)
        if (
          !ordered.length ||
          ordered.length !== ordered[0].total + 1 ||
          ordered.some(
            (part, index) =>
              !part.text ||
              part.index !== index ||
              part.total + 1 !== ordered.length ||
              !part.tags.includes(choiceId) ||
              !part.tags.includes('origin:direct-user'),
          )
        )
          continue
        let sourceMetadata: unknown
        try {
          sourceMetadata = JSON.parse(ordered[0].text!)
        } catch {
          continue
        }
        const metadata = z
          .object({
            event_id: z.string().min(1).max(200),
            source_task_id: z.string().uuid(),
            created_at: z.string().datetime(),
            parts: z.number().int().min(1).max(4),
          })
          .safeParse(sourceMetadata)
        if (!metadata.success || metadata.data.parts !== ordered.length - 1) continue
        const quote = ordered
          .slice(1)
          .map((part) => part.text)
          .join('')
        if (metadata.data.source_task_id !== task.id && !relatedCase(quote, topics)) continue
        references.push({
          id: record.id,
          kind: 'case',
          text: `真实用户选择案例（${metadata.data.created_at}；来源任务 ${metadata.data.source_task_id}；事件 ${metadata.data.event_id}；不是推断偏好或新授权）：\n${quote}`,
        })
        continue
      }
      const source = String(record.source ?? '')
      const automaticOrigin =
        ['coloop', 'auto_work', 'autowork', 'agent'].includes(
          String(record.origin ?? record.source_actor ?? ''),
        ) ||
        tags.some((tag) => ['origin:coloop', 'origin:auto_work', 'origin:autowork'].includes(tag))
      const kind =
        record.kind === 'preference'
          ? ['user', 'user_message'].includes(source) && !automaticOrigin
            ? 'explicit'
            : 'inferred'
          : 'case'
      // General user preferences (for example, language or communication style)
      // remain eligible even without business-topic overlap. Case records do not.
      if (kind === 'case' && record.sourceTaskId !== task.id && !relatedCase(text, topics)) continue
      references.push({ id: record.id, text, kind })
    }
    return version(task, { status: references.length ? 'matched' : 'empty', references })
  } catch (error) {
    const code =
      error instanceof Error && error.message === 'AUTO_MEMORY_DEFERRED'
        ? 'AUTO_MEMORY_DEFERRED'
        : 'AUTO_MEMORY_UNAVAILABLE'
    return version(task, { status: 'unavailable', references: [], error: code })
  }
}

/** The task journal owns the original feedback. Only an explicit future scope
 * is sent to durable memory, with its own provenance rather than preference
 * inference or the model's generated interpretation. */
export async function persistAutoAgentFeedback(
  task: AutoAgentTask,
  feedback: AutoAgentFeedback,
  bridge: AutoAgentMemoryBridge,
): Promise<void> {
  const value = autoAgentFeedbackSchema.parse({
    taskId: feedback.taskId,
    rating: feedback.rating,
    reason: feedback.reason,
    scope: feedback.scope,
    decisionId: feedback.decisionId,
  })
  if (
    value.taskId !== task.id ||
    !task.feedback.some(
      (item) =>
        item.id === feedback.id &&
        item.reason === feedback.reason &&
        item.scope === feedback.scope &&
        item.rating === feedback.rating &&
        item.supersedes === feedback.supersedes &&
        item.createdAt === feedback.createdAt,
    )
  )
    throw new Error('AUTO_FEEDBACK_SOURCE_MISMATCH')
  if (value.decisionId && !task.decisions.some((item) => item.id === value.decisionId))
    throw new Error('AUTO_FEEDBACK_DECISION_UNKNOWN')
  if (value.scope !== 'future') return
  if (!bridge.feedback) throw new Error('AUTO_FEEDBACK_MEMORY_UNAVAILABLE')
  const result = z
    .object({ ok: z.literal(true) })
    .passthrough()
    .parse(
      await bridge.feedback({
        feedback_id: feedback.id,
        source_task_id: task.id,
        decision_id: value.decisionId ?? '',
        scope: 'future',
        workspace_scope: scope(task.session.workspace),
        rating: value.rating,
        source_quote: value.reason,
        supersedes: feedback.supersedes ?? '',
        created_at: feedback.createdAt,
      }),
    )
  if (!result.ok) throw new Error('AUTO_FEEDBACK_MEMORY_FAILED')
}

/** Persist only an exact, already journaled human event. Native systems may
 * label automatically injected prompts as user messages, so provenance,
 * action linkage, known automatic text and explicit markers all participate. */
export async function persistAutoAgentChoice(
  task: AutoAgentTask,
  event: AutoAgentEvent,
  bridge: AutoAgentMemoryBridge,
): Promise<'stored' | 'ignored'> {
  if (
    event.type !== 'user_input' ||
    event.origin !== 'user' ||
    event.actionId ||
    event.agentId ||
    event.parentTurnId ||
    !event.text?.trim() ||
    event.text.length > 4000 ||
    /\[Coloop Auto (?:Agent )?Work:/i.test(event.text) ||
    task.actions.some((action) => action.message.trim() === event.text!.trim())
  )
    return 'ignored'
  const source = task.events.find(
    (item) =>
      item.id === event.id &&
      item.origin === 'user' &&
      item.type === 'user_input' &&
      item.text === event.text &&
      item.sessionId === event.sessionId &&
      item.instanceId === event.instanceId &&
      !item.actionId,
  )
  if (
    !source ||
    event.sessionId !== task.session.id ||
    event.instanceId !== task.session.instanceId
  )
    throw new Error('AUTO_CHOICE_SOURCE_MISMATCH')
  // Reuse the ordinary-memory credential guard without truncating the source.
  for (let index = 0; index < event.text.length; index += 900)
    if (!textOf({ value: event.text.slice(Math.max(0, index - 100), index + 900) }))
      return 'ignored'
  if (!bridge.choice) throw new Error('AUTO_CHOICE_MEMORY_UNAVAILABLE')
  z.object({ ok: z.literal(true) }).parse(
    await bridge.choice({
      source_task_id: task.id,
      event_id: event.id,
      workspace_scope: scope(task.session.workspace),
      source_quote: event.text,
      created_at: event.at,
      origin: 'user',
    }),
  )
  return 'stored'
}
