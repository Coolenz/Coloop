import { useState } from 'react'
import { CheckCircle2, LoaderCircle, MousePointer2, Pause, Play, Square } from 'lucide-react'
import type { AppSnapshot } from '../../shared/contracts'
import { proactiveErrorLabels, proactivePhaseLabels } from '../../shared/proactive'
import { api, unwrap } from './api'
import './desktop.css'

function QuestionReply({
  taskId,
  question,
}: {
  taskId: string
  question: Record<string, unknown>
}) {
  const [answer, setAnswer] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const options = Array.isArray(question.options)
    ? question.options.filter((item): item is string => typeof item === 'string')
    : []
  async function send(event: React.FormEvent) {
    event.preventDefault()
    if (!answer.trim() || busy) return
    setBusy(true)
    setError('')
    try {
      await unwrap(
        api.answerProactiveQuestion({ taskId, questionId: String(question.question_id), answer }),
      )
    } catch (failure) {
      setError((failure as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <form className="computer-question" onSubmit={(event) => void send(event)}>
      <label htmlFor="computer-answer">{String(question.question ?? '请补充任务信息')}</label>
      {!!options.length && (
        <div className="computer-choices">
          {options.map((option, index) => (
            <button
              key={index}
              type="button"
              className="button secondary small"
              disabled={busy}
              aria-pressed={answer === option}
              onClick={() => setAnswer(option)}
            >
              {option}
            </button>
          ))}
        </div>
      )}
      <textarea
        id="computer-answer"
        value={answer}
        onChange={(event) => setAnswer(event.target.value)}
        placeholder="填写回答，继续同一个任务"
        maxLength={4000}
        rows={3}
        disabled={busy}
        required
      />
      <button type="submit" className="button primary" disabled={busy || !answer.trim()}>
        {busy && <LoaderCircle size={15} className="spin" />}回答并继续
      </button>
      {error && (
        <p className="desktop-error" role="alert">
          {error}
        </p>
      )}
    </form>
  )
}

export function ComputerAgentStatus({ snapshot }: { snapshot: AppSnapshot }) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const state = snapshot.proactive
  const suggestion = state?.suggestion
  const taskBusy = snapshot.tasks.some((task) => task.status === 'running')
  const otherBusy = !!snapshot.desktop?.active || !!snapshot.violoop?.active || taskBusy
  const paused = !!state?.observationPaused
  async function act(operation: () => Promise<unknown>) {
    if (pending) return
    setPending(true)
    setError('')
    try {
      await operation()
    } catch (failure) {
      setError((failure as Error).message)
    } finally {
      setPending(false)
    }
  }
  return (
    <section className="computer-agent-status" aria-label="电脑操作状态">
      <div className="computer-status-heading">
        <div className="desktop-status" role="status" aria-live="polite">
          {state?.phase === 'completed' ? (
            <CheckCircle2 size={20} />
          ) : state?.active ? (
            <LoaderCircle size={20} className="spin" />
          ) : (
            <MousePointer2 size={20} />
          )}
          <div>
            <h2>{proactivePhaseLabels[state?.phase ?? 'idle'] ?? '正在处理任务'}</h2>
            <p>
              {snapshot.device.status !== 'connected'
                ? '连接 RK 后可执行任务和获取页面建议'
                : paused
                  ? '自动页面建议已暂停'
                  : state?.active
                    ? '请保持目标应用位于前台，小窗会同步显示执行进度'
                    : '切回目标应用后，自动观察并推荐下一步'}
            </p>
          </div>
        </div>
        <button
          type="button"
          className="button secondary small"
          aria-pressed={paused}
          disabled={pending}
          onClick={() => void act(() => unwrap(api.pauseProactiveObservation(!paused)))}
        >
          {paused ? <Play size={14} /> : <Pause size={14} />}
          {paused ? '恢复页面建议' : '暂停页面建议'}
        </button>
      </div>
      {suggestion && !state?.active && (
        <div className="computer-suggestion">
          <h3>{String(suggestion.title ?? '下一步建议')}</h3>
          <p>{String(suggestion.text ?? '')}</p>
          <div className="computer-inline-actions">
            <button
              type="button"
              className="button primary"
              disabled={pending || otherBusy}
              onClick={() =>
                void act(() =>
                  unwrap(api.acceptProactiveSuggestion(String(suggestion.suggestion_id))),
                )
              }
            >
              执行这条建议
            </button>
            <button
              type="button"
              className="button secondary"
              disabled={pending}
              onClick={() =>
                void act(() =>
                  unwrap(api.dismissProactiveSuggestion(String(suggestion.suggestion_id))),
                )
              }
            >
              忽略建议
            </button>
          </div>
        </div>
      )}
      {state?.active && state.question && state.taskId && (
        <QuestionReply
          key={String(state.question.question_id)}
          taskId={state.taskId}
          question={state.question}
        />
      )}
      {state?.summary && !state.active && <p className="computer-task-summary">{state.summary}</p>}
      {state?.phase === 'completed' && (
        <p className="computer-memory-status" role="status">
          {state.memorySaved === true
            ? '任务记忆已保存，可在「记忆」中查看'
            : state.memorySaved === false
              ? '任务已完成，记忆保存未完成'
              : '任务已完成，RK 正在后台整理记忆'}
        </p>
      )}
      {state?.active && (
        <button
          type="button"
          className="button secondary"
          disabled={pending || state.phase === 'stopping'}
          onClick={() => void act(() => unwrap(api.stopProactiveTask()))}
        >
          <Square size={14} />
          {state.phase === 'stopping' ? '正在等待停止确认' : '停止电脑操作'}
        </button>
      )}
      {state?.phase === 'input_unknown' && !state.active && (
        <button
          type="button"
          className="button secondary"
          disabled={pending}
          onClick={() => void act(() => unwrap(api.resumeSessionControl()))}
        >
          已检查目标窗口，恢复控制
        </button>
      )}
      {(error || state?.error) && (
        <p className="desktop-error" role="alert">
          {error || proactiveErrorLabels[state?.error ?? ''] || state?.error}
        </p>
      )}
      {!state?.active && state?.recommendationError && (
        <p role="status">
          {proactiveErrorLabels[state.recommendationError] ?? state.recommendationError}
        </p>
      )}
      {state?.active && state.progress && (
        <p role="status">
          已确认 {state.progress.units} 项进展，上次进展{' '}
          {new Date(state.progress.lastProgressAt).toLocaleTimeString()}。
          {state.progress.stalled && '已连续15分钟无新进展，正在诊断，任务保留。'}
        </p>
      )}
    </section>
  )
}
