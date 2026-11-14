import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { TaskHistoryDetail, TaskHistoryEntry } from '../../shared/contracts'
import { ExecutionCheckpointStore } from '../infrastructure/execution-checkpoints'

type Row = Record<string, unknown>
const row = (value: unknown): Row =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : {}

function contentText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        const item = row(part)
        return typeof item.text === 'string' ? item.text : ''
      })
      .filter(Boolean)
      .join('\n')
  }
  return value == null ? '' : JSON.stringify(value, null, 2)
}

async function directories(path: string) {
  try {
    return await readdir(path, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

async function* records(path: string) {
  const input = createReadStream(path, { encoding: 'utf8' })
  let pending = ''
  try {
    for await (const chunk of input) {
      pending += chunk
      let newline = pending.indexOf('\n')
      while (newline !== -1) {
        const line = pending.slice(0, newline).trim()
        pending = pending.slice(newline + 1)
        if (line) yield row(JSON.parse(line))
        newline = pending.indexOf('\n')
      }
    }
    // Ignore an uncommitted final line while the runtime is appending it.
  } finally {
    input.destroy()
  }
}

/** Read existing local evidence without opening or resuming an execution session. */
async function readSessionHistory(directory: string, taskId: string): Promise<TaskHistoryDetail> {
  const entries: TaskHistoryEntry[] = []
  const key = createHash('sha256').update(taskId).digest('hex')
  const sessions = join(directory, '.coloop-harness', key, 'sessions')
  for (const project of await directories(sessions)) {
    if (!project.isDirectory() || project.isSymbolicLink()) continue
    const session = join(sessions, project.name, taskId)
    const files = (await directories(session))
      .filter((file) => file.isFile() && /^session(?:\.v[1-9]\d*)?\.jsonl$/.test(file.name))
      .sort((a, b) => version(b.name) - version(a.name))
    if (!files.length) continue
    const names = new Map<string, string>()
    let header = true
    for await (const event of records(join(session, files[0].name))) {
      if (header) {
        if (event.id !== taskId) throw new Error('会话记录与任务不匹配')
        header = false
        continue
      }
      const data = row(event.data)
      const message = row(data.message)
      const at = typeof event.time === 'number' ? event.time : undefined
      if (event.type === 'user/message' || event.type === 'assistant/message') {
        const text = contentText(data.content ?? message.content)
        if (text)
          entries.push({ kind: event.type === 'user/message' ? 'user' : 'assistant', text, at })
      }
      if (event.type === 'tool/call') {
        const name = String(data.name ?? '工具')
        const callId = String(data.callId ?? '')
        names.set(callId, name)
        entries.push({ kind: 'tool_call', name, callId, text: contentText(data.arguments), at })
      }
      if (event.type === 'tool/result') {
        const callId = String(message.toolCallId ?? '')
        entries.push({
          kind: 'tool_result',
          name: names.get(callId),
          callId,
          text: contentText(message.content),
          error: message.isError === true,
          at,
        })
      }
    }
    if (entries.length) return { entries }
  }

  // Older runtimes retained metadata only. Keep that boundary when presenting it.
  const audit = join(directory, 'tars-events')
  if ((await directories(audit)).some((file) => file.name === 'events.jsonl' && file.isFile())) {
    for await (const record of records(join(audit, 'events.jsonl'))) {
      if (record.sessionId !== taskId.toLowerCase()) continue
      const event = row(record.event)
      if (event.type !== 'tool_call' && event.type !== 'tool_result') continue
      entries.push({
        kind: event.type,
        name: typeof event.name === 'string' ? event.name : undefined,
        text: typeof event.errorCode === 'string' ? event.errorCode : '',
        error: event.hasError === true,
        at: typeof record.recordedAt === 'number' ? record.recordedAt : undefined,
      })
    }
  }
  return {
    entries,
    notice: entries.length
      ? '这条历史仅保存了工具调用元数据，参数、返回内容和中间对话未保留。'
      : '这条历史没有保存对话过程或工具调用明细。',
  }
}

function version(name: string) {
  return Number(/\.v(\d+)\./.exec(name)?.[1] ?? 0)
}

export async function readTaskHistory(
  directory: string,
  taskId: string,
): Promise<TaskHistoryDetail> {
  const original = await readSessionHistory(directory, taskId)
  const saved = await new ExecutionCheckpointStore(join(directory, 'execution-checkpoints')).get(
    taskId,
  )
  if (!saved?.cloudSessionId) return { ...original, artifacts: saved?.artifacts ?? [] }
  const cloud = await readSessionHistory(directory, saved.cloudSessionId)
  return {
    artifacts: saved.artifacts,
    entries: [
      ...original.entries,
      ...(saved.handoffs ?? []).map((handoff) => ({
        kind: 'assistant' as const,
        at: handoff.at,
        text: `执行模型已从 ${handoff.from} 切换为 ${handoff.to}。原因：${handoff.reason}`,
      })),
      ...cloud.entries,
    ].sort((a, b) => (a.at ?? 0) - (b.at ?? 0)),
    ...(!cloud.entries.length ? { notice: '任务已准备转交云端，云端会话尚未产生对话记录。' } : {}),
  }
}
