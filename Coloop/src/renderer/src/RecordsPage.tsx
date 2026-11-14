import { useState } from 'react'
import type { AppSnapshot } from '../../shared/contracts'
import { TaskHistoryPage } from './TaskHistoryPage'
import { AutoAgentWorkPage, taskLabels } from './AutoAgentWorkPage'
import { runLabels } from './ConversationHome'
export function RecordsPage({
  snapshot,
  onConversation,
  notify,
  initialRunId,
  onDiagnostic,
}: {
  snapshot: AppSnapshot
  onConversation(id: string): void
  notify(text: string, error?: boolean): void
  initialRunId?: string
  onDiagnostic(id: string): void
}) {
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('')
  const [model, setModel] = useState('')
  const [source, setSource] = useState('')
  const [date, setDate] = useState('')
  const [selected, setSelected] = useState<string | undefined>(initialRunId)
  const [limit, setLimit] = useState(50)
  const rows = (snapshot.conversations?.conversations ?? []).flatMap((conversation) =>
    conversation.runs.map((run) => ({ conversation, run })),
  )
  const current = rows.find((row) => row.run.id === selected)
  const external = snapshot.autoAgentWork?.tasks.find((task) => task.id === selected)
  const externalRows = (snapshot.autoAgentWork?.tasks ?? []).filter(
    (task) =>
      (!source || source === 'external') &&
      (!query || task.goal.includes(query)) &&
      (!date || task.createdAt >= new Date(date).toISOString()) &&
      (!model || task.decisions.some((decision) => decision.model?.includes(model))) &&
      (!status ||
        status === task.state ||
        (status === 'running' &&
          ['watching', 'deciding', 'waiting_receipt'].includes(task.state)) ||
        (status === 'cancelled' && task.state === 'unbound')),
  )
  const filtered = rows
    .filter(
      ({ conversation, run }) =>
        (!query || conversation.title.includes(query) || run.task?.prompt.includes(query)) &&
        (!status || run.state === status) &&
        (!model || run.task?.model.includes(model)) &&
        (!date || run.createdAt >= new Date(date).toISOString()) &&
        (!source || source === (run.task?.source === 'screen' ? 'screen' : 'task')),
    )
    .sort((a, b) => b.run.createdAt.localeCompare(a.run.createdAt))
  if (external)
    return (
      <div className="workspace-page">
        <button className="text-button" onClick={() => setSelected(undefined)}>
          ← 返回记录
        </button>
        <AutoAgentWorkPage snapshot={snapshot} initialTaskId={external.id} />
      </div>
    )
  if (current)
    return (
      <div className="workspace-page">
        <div className="record-detail-links">
          <button className="text-button" onClick={() => setSelected(undefined)}>
            ← 返回记录
          </button>
          <button className="text-button" onClick={() => onConversation(current.conversation.id)}>
            回到聊天 →
          </button>
        </div>
        <div className="record-metadata">
          <span>
            执行策略 ·{' '}
            {
              { cloud: '云端执行', local: '本地执行', 'local-auto': '本地判断' }[
                current.run.policy.mode
              ]
            }
          </span>
          <span>{current.run.policy.cloudFallback ? '允许云端接管' : '按选定模型执行'}</span>
          <span>{runLabels[current.run.state]}</span>
          <button className="text-button" onClick={() => onDiagnostic(current.run.id)}>
            查看运行诊断
          </button>
        </div>
        {current.run.task ? (
          <TaskHistoryPage
            task={current.run.task}
            onBack={() => setSelected(undefined)}
            notify={notify}
          />
        ) : (
          <>
            <h1>{current.conversation.title}</h1>
            <p>{current.run.error ?? runLabels[current.run.state]}</p>
          </>
        )}
      </div>
    )
  return (
    <div className="workspace-page records-page">
      <h1>记录</h1>
      <div className="record-filters">
        <input
          aria-label="搜索记录"
          placeholder="搜索任务"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <select
          aria-label="按状态筛选"
          value={status}
          onChange={(event) => setStatus(event.target.value)}
        >
          <option value="">全部状态</option>
          {Object.entries(runLabels).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <input
          type="date"
          aria-label="开始日期"
          value={date}
          onChange={(event) => setDate(event.target.value)}
        />
        <input
          aria-label="按模型筛选记录"
          placeholder="模型"
          value={model}
          onChange={(event) => setModel(event.target.value)}
        />
        <select
          aria-label="按来源筛选"
          value={source}
          onChange={(event) => setSource(event.target.value)}
        >
          <option value="">全部来源</option>
          <option value="task">任务聊天</option>
          <option value="screen">屏幕任务</option>
          <option value="external">外部 Agent</option>
        </select>
      </div>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>任务名称</th>
              <th>状态</th>
              <th>实际模型</th>
              <th>时间</th>
              <th>耗时</th>
            </tr>
          </thead>
          <tbody>
            {filtered.slice(0, limit).map(({ conversation, run }) => (
              <tr key={run.id}>
                <td>
                  <button className="record-title" onClick={() => setSelected(run.id)}>
                    {conversation.title}
                  </button>
                  {conversation.archived && <small>已归档</small>}
                </td>
                <td>{runLabels[run.state]}</td>
                <td>{run.task?.model ?? '等待执行'}</td>
                <td>{new Date(run.createdAt).toLocaleString()}</td>
                <td>
                  {run.task?.finishedAt
                    ? `${Math.max(0, Math.round((Date.parse(run.task.finishedAt) - Date.parse(run.task.createdAt)) / 1000))} 秒`
                    : '—'}
                </td>
              </tr>
            ))}
            {externalRows.map((task) => (
              <tr key={task.id}>
                <td>
                  <button className="record-title" onClick={() => setSelected(task.id)}>
                    {task.goal}
                  </button>
                  <small>外部 Agent</small>
                </td>
                <td>{taskLabels[task.state]}</td>
                <td>{task.decisions.at(-1)?.model ?? '未记录'}</td>
                <td>{new Date(task.createdAt).toLocaleString()}</td>
                <td>未记录</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!filtered.length && !externalRows.length && <p className="empty-copy">没有匹配的任务记录</p>}
      {filtered.length > limit && (
        <button className="button" onClick={() => setLimit(limit + 50)}>
          加载更多记录
        </button>
      )}
      {snapshot.conversations?.conversations
        .filter((entry) => entry.archived && !entry.runs.length)
        .map((entry) => (
          <button
            className="configuration-link"
            key={entry.id}
            onClick={() => onConversation(entry.id)}
          >
            {entry.title}
            <span>重新打开已归档聊天 →</span>
          </button>
        ))}
    </div>
  )
}
