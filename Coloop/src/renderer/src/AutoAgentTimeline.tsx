import { useState } from 'react'
import type { AutoAgentTask } from '../../shared/auto-agent-work'
import { time } from './components'
import './home-activity.css'

export function AutoAgentTimeline({ task }: { task: AutoAgentTask }) {
  const [limit, setLimit] = useState(50)
  const entries = [
    ...task.events.map((event) => ({
      id: event.id,
      at: event.at,
      label: 'Agent 事件',
      text: event.text || event.type,
    })),
    ...task.decisions.map((decision) => ({
      id: decision.id,
      at: decision.createdAt,
      label: '推进判断',
      text: [decision.reason, decision.message, ...decision.evidence].filter(Boolean).join('\n'),
    })),
    ...task.actions.map((action) => ({
      id: action.id,
      at: action.updatedAt,
      label: `执行回执 · ${action.status}`,
      text: [action.message, action.receipt, action.error].filter(Boolean).join('\n'),
    })),
  ].sort((a, b) => a.at.localeCompare(b.at))
  return (
    <>
      {entries.length > limit && (
        <button className="text-button" onClick={() => setLimit(limit + 50)}>
          加载更早的过程
        </button>
      )}
      <ol className="home-task-output" aria-label="自动推进过程与输出" tabIndex={0}>
        {entries.slice(-limit).map((entry) => (
          <li key={entry.id}>
            <details open>
              <summary>
                <strong>{entry.label}</strong> <time>{time(entry.at)}</time>
              </summary>
              <pre>{entry.text}</pre>
            </details>
          </li>
        ))}
      </ol>
      {!entries.length && <p className="muted">等待 Agent 返回过程与输出…</p>}
    </>
  )
}
