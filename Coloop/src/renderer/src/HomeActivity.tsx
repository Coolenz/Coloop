import { useEffect, useState } from 'react'
import type { AppSnapshot, Task, TaskHistoryDetail } from '../../shared/contracts'
import { api, unwrap } from './api'
import { sessionName, taskLabels } from './AutoAgentWorkPage'
import { time } from './components'
import { AutoAgentTimeline } from './AutoAgentTimeline'
import './home-activity.css'

function TaskProcess({ task, onOpen }: { task: Task; onOpen: () => void }) {
  const [detail, setDetail] = useState<TaskHistoryDetail>()
  const [error, setError] = useState('')
  useEffect(() => {
    let disposed = false
    let timer: ReturnType<typeof setTimeout>
    async function load() {
      try {
        const result = await unwrap(api.taskHistory(task.id))
        if (!disposed) {
          setDetail(result)
          setError('')
        }
      } catch (reason) {
        if (!disposed) setError((reason as Error).message)
      } finally {
        if (!disposed) timer = setTimeout(() => void load(), 2000)
      }
    }
    void load()
    return () => {
      disposed = true
      clearTimeout(timer)
    }
  }, [task.id])
  return (
    <article className="home-task">
      <div className="section-bar">
        <h3>{task.prompt}</h3>
        <button className="text-button" onClick={onOpen}>
          完整记录
        </button>
      </div>
      <p role="status">{task.stage || '正在运行'}</p>
      {error && <p role="alert">过程读取失败，正在重试。{error}</p>}
      {detail?.notice && <p className="muted">{detail.notice}</p>}
      <ol className="home-task-output" aria-label="执行过程与输出" tabIndex={0}>
        {detail?.entries
          .filter((entry) => entry.kind !== 'user')
          .slice(-30)
          .map((entry, index) => (
            <li key={index}>
              <strong>
                {entry.kind === 'assistant'
                  ? 'Coloop 输出'
                  : `${entry.kind === 'tool_call' ? '调用工具' : entry.error ? '工具错误' : '工具返回'} · ${entry.name || '工具'}`}
              </strong>
              <pre>{entry.text || '等待详细输出'}</pre>
            </li>
          ))}
      </ol>
      {task.answer && <pre className="home-answer">{task.answer}</pre>}
      {!detail?.entries.some((entry) => entry.kind !== 'user') && !task.answer && (
        <p className="muted">等待执行器返回过程与输出…</p>
      )}
    </article>
  )
}

export function HomeActivity({
  snapshot,
  onTask,
  onAutoTask,
}: {
  snapshot: AppSnapshot
  onTask: (task: Task) => void
  onAutoTask: (id: string) => void
}) {
  const state = snapshot.autoAgentWork
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function toggle() {
    setBusy(true)
    setError('')
    try {
      await unwrap(api.setAutoAgentEnabled(!state?.enabled))
    } catch (reason) {
      setError((reason as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const tasks = snapshot.tasks.filter((task) => task.status === 'running')
  const followed =
    state?.tasks.filter((task) => !['completed', 'unbound'].includes(task.state)) ?? []
  return (
    <section className="home-activity" aria-label="当前任务与自动推进">
      <div className="home-auto-work">
        <div>
          <h2>Auto Agent Work</h2>
          <p>自动发现新任务，在需要选择、继续或验收时推进。</p>
        </div>
        <button
          className="button secondary"
          role="switch"
          aria-checked={!!state?.enabled}
          aria-label="自动发现与推进任务"
          disabled={busy || !state}
          onClick={() => void toggle()}
        >
          {busy ? '正在设置…' : state?.enabled ? '已开启' : '开启'}
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
      {state?.enabled && (
        <p className="muted" role="status">
          正在监听已接入的 Codex / OpenCode 会话。
          {state.hooks.workspace && `工作目录 ${state.hooks.workspace}。`}
          {state.hooks.trust !== 'observed' &&
            '等待新任务事件，若原 Agent 提示 Hook 信任，请在原应用完成。'}
        </p>
      )}
      {state?.journalError && (
        <p role="alert">任务记录不可用，自动推进已停止。{state.journalError}</p>
      )}
      <h2>当前任务</h2>
      {!tasks.length && !followed.length && (
        <p className="muted">当前没有运行中的任务。新任务的执行过程和输出会显示在这里。</p>
      )}
      {tasks.map((task) => (
        <TaskProcess key={task.id} task={task} onOpen={() => onTask(task)} />
      ))}
      {followed.map((task) => (
        <article key={task.id} className="home-task">
          <div className="section-bar">
            <h3>{task.goal}</h3>
            <button className="text-button" onClick={() => onAutoTask(task.id)}>
              完整记录
            </button>
          </div>
          <p>
            {sessionName(task.session)} · <span role="status">{taskLabels[task.state]}</span>
          </p>
          {task.pauseReason && <p>{task.pauseReason}</p>}
          {task.error && <p role="alert">{task.error}</p>}
          <AutoAgentTimeline task={task} />
        </article>
      ))}
    </section>
  )
}
