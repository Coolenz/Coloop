import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  ArrowUpRight,
  ArrowUp,
  ChevronDown,
  GripHorizontal,
  Minus,
  LoaderCircle,
  Square,
  TriangleAlert,
  X,
} from 'lucide-react'
import { isActiveControlMode, type ControlIndicatorView } from '../../shared/control-indicator'
import brandMark from '../../../resources/brand.svg'
import './control-indicator.css'

function elapsed(startedAt: string | undefined, now: number) {
  if (!startedAt) return '00:00'
  const seconds = Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1000))
  if (!Number.isFinite(seconds)) return '00:00'
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  return `${hours ? `${hours}:` : ''}${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
}

export function ControlIndicator() {
  const [snapshot, setSnapshot] = useState<ControlIndicatorView>({ mode: 'hidden', revision: 0 })
  const [now, setNow] = useState(Date.now())
  const [actionError, setActionError] = useState('')
  const [requestingStop, setRequestingStop] = useState(false)
  const [answer, setAnswer] = useState('')
  const [pendingAction, setPendingAction] = useState(false)
  const [editingAnswer, setEditingAnswer] = useState(false)
  const commandInput = useRef<HTMLInputElement>(null)
  const preparingCommand = useRef<Promise<boolean> | null>(null)
  const composingCommand = useRef(false)
  const [goal, setGoal] = useState('')
  const [hovered, setHovered] = useState(false)
  const [focusWithin, setFocusWithin] = useState(false)
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const dragging = useRef(false)
  const surface = useRef<HTMLElement>(null)
  const panel = useRef<HTMLElement>(null)
  const closing = useRef(false)
  const [reducedMotion, setReducedMotion] = useState(
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  )
  const revealed = hovered || focusWithin || editingAnswer || snapshot.mode === 'preview'
  useEffect(() => {
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = () => setReducedMotion(preference.matches)
    preference.addEventListener('change', update)
    return () => preference.removeEventListener('change', update)
  }, [])
  useEffect(() => {
    void window.coloopControl?.setRevealed?.(revealed, reducedMotion)
  }, [revealed, reducedMotion])
  useEffect(() => {
    const blur = () => setFocusWithin(false)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('blur', blur)
      if (leaveTimer.current) clearTimeout(leaveTimer.current)
    }
  }, [])
  useEffect(() => {
    setAnswer('')
    setEditingAnswer(false)
  }, [snapshot.questionId])

  useEffect(() => {
    const api = window.coloopControl
    if (!api) {
      setActionError('Connection unavailable. Open Coloop.')
      return
    }
    let active = true
    const accept = (next: ControlIndicatorView) => {
      if (active) {
        setSnapshot((current) => (next.revision >= current.revision ? next : current))
        setActionError('')
      }
    }
    const unsubscribe = api.onSnapshot(accept)
    void api.snapshot().then(
      (result) => {
        if (result.ok) accept(result.value)
        else if (active) setActionError('Connection unavailable. Open Coloop.')
      },
      () => active && setActionError('Connection lost. Open Coloop.'),
    )
    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  // The host waits for this acknowledgment before it may dispatch real control.
  useLayoutEffect(() => {
    if (!snapshot.revision || snapshot.mode === 'hidden') return
    let secondFrame = 0
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        void window.coloopControl?.snapshot(snapshot.revision).catch(() => {
          setActionError('Connection lost. Open Coloop.')
        })
      })
    })
    return () => {
      cancelAnimationFrame(firstFrame)
      cancelAnimationFrame(secondFrame)
    }
  }, [snapshot.revision, snapshot.mode])

  useEffect(() => {
    if (!isActiveControlMode(snapshot.mode)) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [snapshot.mode, snapshot.startedAt])

  const stop = async () => {
    if (!window.coloopControl || requestingStop) return
    setRequestingStop(true)
    setActionError('')
    try {
      const result = await window.coloopControl.stop()
      if (!result.ok) setActionError('Stop unconfirmed. Open Coloop.')
    } catch {
      setActionError('Stop unconfirmed. Open Coloop.')
    } finally {
      setRequestingStop(false)
    }
  }
  const preview = snapshot.mode === 'preview'
  const stopping = snapshot.mode === 'stopping' || requestingStop
  const uncertain =
    snapshot.mode === 'unconfirmed' || Boolean(actionError) || Boolean(snapshot.error)
  const detail =
    actionError ||
    snapshot.detail ||
    (preview
      ? 'Preview · No actions running'
      : stopping
        ? 'Waiting for stop confirmation'
        : uncertain
          ? 'Control status unconfirmed'
          : snapshot.mode === 'idle'
            ? snapshot.observationPaused
              ? 'Observation paused'
              : 'Ready to help'
            : snapshot.mode === 'suggestion'
              ? 'A suggestion for your work'
              : snapshot.mode === 'question'
                ? 'Your answer is needed'
                : snapshot.mode === 'completed'
                  ? 'Task completed'
                  : snapshot.mode === 'blocked'
                    ? 'Task needs attention'
                    : snapshot.mode === 'failed'
                      ? 'Task could not finish'
                      : 'Controlling your computer')
  const active = isActiveControlMode(snapshot.mode)
  const canStartTask = ['idle', 'suggestion', 'completed', 'blocked', 'failed'].includes(
    snapshot.mode,
  )
  const hasPanel = ['suggestion', 'question', 'completed', 'blocked', 'failed'].includes(
    snapshot.mode,
  )
  const expanded = snapshot.expanded ?? hasPanel
  // Animate a new task/phase, never each polling revision or elapsed-time tick.
  useLayoutEffect(() => {
    if (!panel.current) return
    const animation = panel.current.animate([{ opacity: 0.6 }, { opacity: 1 }], {
      duration: reducedMotion ? 70 : 160,
      easing: 'ease-out',
    })
    return () => animation.cancel()
  }, [snapshot.mode, snapshot.taskId, snapshot.suggestionId, snapshot.questionId, reducedMotion])
  const runAction = async (action: () => Promise<{ ok: boolean; error?: string }> | undefined) => {
    if (pendingAction) return
    setPendingAction(true)
    try {
      const result = await action()
      if (!result?.ok) setActionError(result?.error || 'Connection unavailable. Open Coloop.')
    } catch {
      setActionError('Request failed. Open Coloop to retry.')
    } finally {
      setPendingAction(false)
    }
  }
  const prepareCommand = (): Promise<boolean> => {
    if (preparingCommand.current) return preparingCommand.current
    const preparation = (async () => {
      try {
        const result = await window.coloopControl?.beginTask()
        if (!result?.ok) {
          setActionError(result?.error || '无法输入命令，请重试。')
          return false
        }
        commandInput.current?.focus()
        return true
      } catch {
        setActionError('无法输入命令，请重试。')
        return false
      }
    })()
    preparingCommand.current = preparation
    void preparation.finally(() => {
      preparingCommand.current = null
    })
    return preparation
  }
  const closeSurface = (isPreview = false) => {
    if (closing.current || pendingAction) return
    closing.current = true
    void runAction(async () => {
      let animation: Animation | undefined
      try {
        // Stopping real control must never wait on a decorative exit.
        if (!active && surface.current) {
          animation = surface.current.animate(
            [
              { opacity: 1, transform: 'scale(1)' },
              { opacity: 0, transform: reducedMotion ? 'scale(1)' : 'scale(0.98)' },
            ],
            { duration: reducedMotion ? 60 : 110, easing: 'ease-in', fill: 'forwards' },
          )
          await animation.finished.catch(() => {})
        }
        return (
          (await (isPreview
            ? window.coloopControl?.closePreview()
            : window.coloopControl?.close())) || { ok: false }
        )
      } finally {
        animation?.cancel()
        closing.current = false
      }
    })
  }
  const submitAnswer = (value: string) =>
    runAction(() => {
      if (!snapshot.taskId || !snapshot.questionId) return undefined
      return window.coloopControl?.answerQuestion({
        taskId: snapshot.taskId,
        questionId: snapshot.questionId,
        answer: value,
      })
    })

  if (snapshot.mode === 'hidden' && !actionError) return null
  return (
    <main
      ref={surface}
      className="control-indicator"
      data-mode={snapshot.mode}
      data-expanded={expanded}
      data-revealed={revealed}
      onMouseEnter={() => {
        if (leaveTimer.current) clearTimeout(leaveTimer.current)
        setHovered(true)
      }}
      onMouseLeave={() => {
        if (leaveTimer.current) clearTimeout(leaveTimer.current)
        leaveTimer.current = setTimeout(() => setHovered(false), 350)
      }}
      onFocusCapture={() => setFocusWithin(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocusWithin(false)
      }}
      aria-label="Coloop control status"
    >
      <header className="island-header">
        <div
          className="island-drag-handle"
          title="按住拖动灵动岛"
          aria-label="拖动灵动岛"
          onPointerDown={(event) => {
            if (event.button !== 0) return
            event.preventDefault()
            dragging.current = true
            event.currentTarget.setPointerCapture(event.pointerId)
            void window.coloopControl?.drag('start', { x: event.screenX, y: event.screenY })
          }}
          onPointerMove={(event) => {
            if (dragging.current)
              void window.coloopControl?.drag('move', { x: event.screenX, y: event.screenY })
          }}
          onPointerUp={(event) => {
            if (!dragging.current) return
            dragging.current = false
            event.currentTarget.releasePointerCapture(event.pointerId)
            void window.coloopControl?.drag('end', { x: event.screenX, y: event.screenY })
          }}
          onLostPointerCapture={(event) => {
            if (dragging.current) {
              dragging.current = false
              void window.coloopControl?.drag('end', { x: event.screenX, y: event.screenY })
            }
          }}
        >
          <GripHorizontal size={16} aria-hidden="true" />
        </div>
        <button
          className="control-brand"
          title="Open Coloop"
          aria-label="Open Coloop"
          onClick={() => {
            void window.coloopControl
              ?.openMain()
              .then((result) => {
                if (!result.ok) setActionError('Unable to open Coloop.')
              })
              .catch(() => setActionError('Unable to open Coloop. Use the taskbar.'))
          }}
        >
          <img src={brandMark} alt="" />
          {uncertain && <TriangleAlert className="control-warning" size={12} aria-hidden="true" />}
        </button>
        <div className="control-copy" role="status" aria-live="polite" aria-atomic="true">
          <strong className="control-title">Coloop</strong>
          <span key={detail} className="control-detail" title={detail}>
            {detail}
          </span>
        </div>
        {active && (
          <time
            className="control-timer"
            aria-label={`Elapsed ${elapsed(snapshot.startedAt, now)}`}
          >
            {elapsed(snapshot.startedAt, now)}
          </time>
        )}
        {preview ? (
          <>
            <button
              className="control-preview-open"
              onClick={() => void window.coloopControl?.openMain().catch(() => {})}
              aria-label="Open Coloop"
              title="Open Coloop"
            >
              <ArrowUpRight size={17} aria-hidden="true" />
            </button>
            <button
              className="control-preview-close"
              onClick={() => closeSurface(true)}
              aria-label="Close preview"
              title="Close preview"
            >
              <X size={17} aria-hidden="true" />
            </button>
          </>
        ) : active ? (
          <button className="control-stop" onClick={() => void stop()} disabled={stopping}>
            {stopping ? (
              <LoaderCircle size={14} className="control-spinner" aria-hidden="true" />
            ) : (
              <Square size={11} fill="currentColor" aria-hidden="true" />
            )}
            <span>{stopping ? 'Stopping' : 'Stop'}</span>
          </button>
        ) : null}
        <div
          className="island-header-actions"
          data-visible={revealed}
          inert={!revealed}
          aria-hidden={!revealed}
        >
          {hasPanel && (
            <button
              className="island-expand"
              aria-expanded={expanded}
              aria-label={expanded ? 'Collapse' : 'Expand'}
              onClick={() => void runAction(() => window.coloopControl?.setExpanded(!expanded))}
            >
              <ChevronDown size={17} />
            </button>
          )}
          {canStartTask && (
            <button
              className="island-text-button"
              onClick={() =>
                void runAction(() =>
                  window.coloopControl?.pauseObservation(!snapshot.observationPaused),
                )
              }
            >
              {snapshot.observationPaused ? 'Resume' : 'Pause'}
            </button>
          )}
          {!preview && (
            <button
              aria-label="收起灵动岛"
              title="收起灵动岛"
              onClick={() => {
                setHovered(false)
                setFocusWithin(false)
                setEditingAnswer(false)
                if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
                void window.coloopControl?.endAnswer()
              }}
            >
              <Minus size={16} />
            </button>
          )}
          {!preview && (
            <button
              aria-label="关闭灵动岛"
              title={active ? '停止任务并关闭灵动岛' : '关闭灵动岛（从托盘重新打开）'}
              disabled={pendingAction || stopping}
              onClick={() => closeSurface()}
            >
              <X size={16} />
            </button>
          )}
        </div>
      </header>
      {!preview && (
        <form
          data-visible={revealed}
          inert={!revealed}
          aria-hidden={!revealed}
          className="island-command"
          aria-label="主动命令"
          onBlur={(event) => {
            if (!pendingAction && !event.currentTarget.contains(event.relatedTarget as Node | null))
              void window.coloopControl?.endAnswer()
          }}
          onSubmit={(event) => {
            event.preventDefault()
            if (!canStartTask || pendingAction || composingCommand.current || !goal.trim()) return
            const command = goal.trim()
            void runAction(async () => {
              if (!(await prepareCommand())) return { ok: false, error: '无法输入命令，请重试。' }
              const result = await window.coloopControl?.startTask(command)
              if (result?.ok) setGoal('')
              return result || { ok: false }
            })
          }}
        >
          <input
            ref={commandInput}
            id="island-goal"
            aria-label="让 Coloop 做什么"
            placeholder={canStartTask ? '让 Coloop 做什么？' : '任务进行中，完成后可输入新命令'}
            autoComplete="off"
            maxLength={4000}
            value={goal}
            disabled={!canStartTask}
            readOnly={pendingAction}
            onMouseDown={(event) => {
              if (document.activeElement !== event.currentTarget) {
                event.preventDefault()
              }
              void prepareCommand()
            }}
            onFocus={() => void prepareCommand()}
            onCompositionStart={() => {
              composingCommand.current = true
            }}
            onCompositionEnd={() => {
              composingCommand.current = false
            }}
            onKeyDown={(event) => {
              if (
                event.key === 'Enter' &&
                (composingCommand.current || event.nativeEvent.isComposing || event.keyCode === 229)
              )
                event.preventDefault()
              if (event.key === 'Escape') event.currentTarget.blur()
            }}
            onChange={(event) => setGoal(event.target.value)}
          />
          <button
            className="island-command-send"
            type="submit"
            aria-label="发送命令"
            title="发送命令 · Enter"
            disabled={!canStartTask || pendingAction || !goal.trim()}
          >
            {pendingAction ? (
              <LoaderCircle size={17} className="control-spinner" />
            ) : (
              <ArrowUp size={18} />
            )}
          </button>
        </form>
      )}
      {hasPanel && (
        <section
          ref={panel}
          className="island-panel"
          data-visible={revealed && expanded}
          inert={!revealed || !expanded}
          aria-hidden={!revealed || !expanded}
          aria-label="Task details"
        >
          {snapshot.title && <h1>{snapshot.title}</h1>}
          {snapshot.content && <div className="island-content">{snapshot.content}</div>}
          {snapshot.error && (
            <p className="island-error" role="alert">
              {snapshot.error}
            </p>
          )}
          {['completed', 'blocked', 'failed'].includes(snapshot.mode) && (
            <div className="island-actions">
              <button
                className="island-secondary"
                disabled={pendingAction || !snapshot.taskId}
                onClick={() =>
                  void runAction(() =>
                    window.coloopControl?.dismissResult(snapshot.taskId!, snapshot.revision),
                  )
                }
              >
                {snapshot.mode === 'completed' ? '完成' : '取消'}
              </button>
            </div>
          )}
          {snapshot.mode === 'suggestion' && (
            <div className="island-actions">
              <button
                className="island-primary"
                disabled={pendingAction || !snapshot.suggestionId}
                onClick={() =>
                  void runAction(() =>
                    window.coloopControl?.acceptSuggestion(
                      snapshot.suggestionId!,
                      snapshot.revision,
                    ),
                  )
                }
              >
                Execute
              </button>
              <button
                className="island-secondary"
                disabled={pendingAction || !snapshot.suggestionId}
                onClick={() =>
                  void runAction(() =>
                    window.coloopControl?.dismissSuggestion(
                      snapshot.suggestionId!,
                      snapshot.revision,
                    ),
                  )
                }
              >
                Ignore
              </button>
            </div>
          )}
          {snapshot.mode === 'question' && (
            <>
              <div className="island-choices">
                {snapshot.choices?.map((choice) => (
                  <button
                    className="island-secondary"
                    disabled={pendingAction}
                    key={choice}
                    onClick={() => void submitAnswer(choice)}
                  >
                    {choice}
                  </button>
                ))}
              </div>
              {!editingAnswer ? (
                <button
                  className="island-secondary"
                  onClick={() =>
                    void runAction(async () => {
                      const result = await window.coloopControl?.beginAnswer()
                      if (result?.ok) setEditingAnswer(true)
                      return result || { ok: false }
                    })
                  }
                >
                  Write an answer
                </button>
              ) : (
                <form
                  onSubmit={(event) => {
                    event.preventDefault()
                    if (answer.trim()) void submitAnswer(answer.trim())
                  }}
                >
                  <label htmlFor="island-answer">Your answer</label>
                  <textarea
                    id="island-answer"
                    autoFocus
                    value={answer}
                    maxLength={4000}
                    rows={3}
                    onChange={(event) => setAnswer(event.target.value)}
                  />
                  <div className="island-actions">
                    <button
                      className="island-primary"
                      type="submit"
                      disabled={pendingAction || !answer.trim()}
                    >
                      Continue
                    </button>
                    <button
                      className="island-secondary"
                      type="button"
                      onClick={() => {
                        setEditingAnswer(false)
                        void window.coloopControl?.endAnswer()
                      }}
                    >
                      Cancel answer
                    </button>
                  </div>
                </form>
              )}
            </>
          )}
        </section>
      )}
    </main>
  )
}
