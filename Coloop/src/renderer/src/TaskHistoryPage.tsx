import { useEffect, useState } from 'react'
import { ArrowLeft, LoaderCircle } from 'lucide-react'
import type { Task, TaskHistoryDetail } from '../../shared/contracts'
import { api, unwrap } from './api'
import { TaskResult, time } from './components'
import './task-history.css'

export function TaskHistoryPage({
  task,
  notify,
  onBack,
}: {
  task?: Task
  notify: (message: string, error?: boolean) => void
  onBack: () => void
}) {
  const [detail, setDetail] = useState<TaskHistoryDetail>()
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const taskId = task?.id
  const running = task?.status === 'running'
  useEffect(() => {
    if (!taskId) return
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    async function load() {
      try {
        const result = await unwrap(api.taskHistory(taskId!))
        if (!disposed) {
          setDetail(result)
          setError('')
        }
      } catch (failure) {
        if (!disposed) setError((failure as Error).message)
      } finally {
        if (!disposed && running) timer = setTimeout(() => void load(), 3000)
      }
    }
    void load()
    return () => {
      disposed = true
      clearTimeout(timer)
    }
  }, [taskId, running, retry])

  return (
    <div className="page-content task-history-detail">
      <button className="text-button" onClick={onBack}>
        <ArrowLeft size={15} />
        返回记录
      </button>
      <div className="page-title-row">
        <h1>任务详情</h1>
      </div>
      {task ? (
        <>
          <section className="result-panel" aria-label="任务提问">
            <div className="section-bar">
              <h2>你</h2>
              <span className="muted">{time(task.createdAt)}</span>
            </div>
            <div className="answer">{task.prompt}</div>
          </section>
          <section className="result-panel" aria-label="对话与工具调用">
            <div className="record-metadata">
              <span>实际模型 · {task.model || '未记录'}</span>
              <span>模型请求 · {detail?.usage?.requests ?? '未记录'}</span>
              <span>用量单位 · {detail?.usage?.tokenUnits ?? '未记录'}</span>
              <span>
                估算费用 ·{' '}
                {detail?.usage && !detail.usage.unpricedRequests
                  ? `¥${detail.usage.estimatedCostYuan.toFixed(4)}`
                  : '未完整计价'}
              </span>
            </div>
            <div className="section-bar">
              <h2>对话与工具调用</h2>
            </div>
            {error && (
              <div role="alert" className="inline-error">
                <span>{error}</span>
                <button className="text-button" onClick={() => setRetry((value) => value + 1)}>
                  重试
                </button>
              </div>
            )}
            {!detail && !error && (
              <p role="status">
                <LoaderCircle size={16} className="spin" />
                正在读取记录…
              </p>
            )}
            {detail?.notice && <p className="muted">{detail.notice}</p>}
            <ol className="task-history-events">
              {detail?.entries.map((entry, index) => (
                <li key={index}>
                  {entry.kind === 'tool_call' || entry.kind === 'tool_result' ? (
                    <details>
                      <summary>
                        {entry.kind === 'tool_call'
                          ? '调用工具'
                          : entry.error
                            ? '工具返回错误'
                            : '工具返回'}
                        {' · '}
                        {entry.name || '工具'}
                        {entry.at && <time>{time(new Date(entry.at).toISOString())}</time>}
                      </summary>
                      {entry.callId && <p className="muted">调用 ID {entry.callId}</p>}
                      <pre>{entry.text || '未保存详细内容'}</pre>
                    </details>
                  ) : (
                    <>
                      <div className="section-bar">
                        <strong>{entry.kind === 'user' ? '你' : 'Coloop'}</strong>
                        {entry.at && <time>{time(new Date(entry.at).toISOString())}</time>}
                      </div>
                      <div className="answer">{entry.text}</div>
                    </>
                  )}
                </li>
              ))}
            </ol>
          </section>
          <TaskResult task={task} notify={notify} />
          {!!detail?.artifacts?.length && (
            <section className="result-panel">
              <h2>产物</h2>
              {detail.artifacts.map((artifact) => (
                <div className="model-status-row" key={artifact.id}>
                  <span>{artifact.path}</span>
                  <button
                    className="button"
                    onClick={() =>
                      void unwrap(
                        api.openTaskArtifact({ taskId: task.id, artifactId: artifact.id }),
                      ).catch((error) => notify(error.message, true))
                    }
                  >
                    打开文件
                  </button>
                </div>
              ))}
            </section>
          )}
        </>
      ) : (
        <p role="status">任务记录已不存在，请返回历史列表查看。</p>
      )}
    </div>
  )
}
