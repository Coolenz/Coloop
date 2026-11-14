import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from 'react'
import {
  ArrowUpRight,
  ArrowUp,
  ChevronDown,
  ChevronUp,
  GripHorizontal,
  LoaderCircle,
  Square,
  TriangleAlert,
  X,
  ChevronLeft,
  ChevronRight,
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
  const [commandStatus, setCommandStatus] = useState('')
  useEffect(() => {
    if (!commandStatus) return
    const timer = setTimeout(() => setCommandStatus(''), 4000)
    return () => clearTimeout(timer)
  }, [commandStatus])
  const [hovered, setHovered] = useState(false)
  const [focusWithin, setFocusWithin] = useState(false)
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const dragging = useRef(false)
  const [draggingTab, setDraggingTab] = useState(false)
  const gesture = useRef<{ x: number; y: number; moved: boolean } | null>(null)
  const suppressClick = useRef(false)
  const surface = useRef<HTMLElement>(null)
  const panel = useRef<HTMLElement>(null)
  const closing = useRef(false)
  const [reducedMotion, setReducedMotion] = useState(
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  )
  const revealed =
    hovered || focusWithin || editingAnswer || (snapshot.mode === 'preview' && !snapshot.dockEdge)
  useLayoutEffect(() => {
    document.body.dataset.dock = snapshot.dockEdge ?? ''
    return () => {
      delete document.body.dataset.dock
    }
  }, [snapshot.dockEdge])
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
      setActionError('连接不可用，请打开 Coloop 检查。')
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
        else if (active) setActionError('连接不可用，请打开 Coloop 检查。')
      },
      () => active && setActionError('连接已断开，请打开 Coloop 检查。'),
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
          setActionError('连接已断开，请打开 Coloop 检查。')
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
      if (!result.ok) setActionError('停止结果未确认，请打开 Coloop 检查。')
    } catch {
      setActionError('停止结果未确认，请打开 Coloop 检查。')
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
    commandStatus ||
    snapshot.detail ||
    (preview
      ? '灵动岛预览'
      : stopping
        ? '等待停止确认'
        : uncertain
          ? '操作状态待确认'
          : snapshot.mode === 'idle'
            ? snapshot.observationPaused
              ? '观察已暂停'
              : '准备开始'
            : snapshot.mode === 'suggestion'
              ? '当前任务有新建议'
              : snapshot.mode === 'question'
                ? '等待你的回答'
                : snapshot.mode === 'completed'
                  ? '任务已完成'
                  : snapshot.mode === 'blocked'
                    ? '任务需要处理'
                    : snapshot.mode === 'failed'
                      ? '任务未完成'
                      : '正在操作电脑')
  const active = isActiveControlMode(snapshot.mode)
  const canStartTask = [
    'idle',
    'suggestion',
    'completed',
    'blocked',
    'failed',
    'controlling',
    'question',
  ].includes(snapshot.mode)
  const expanded = snapshot.expanded === true
  const detailsVisible = revealed && expanded
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
      if (!result?.ok) setActionError(result?.error || '连接不可用，请打开 Coloop 检查。')
    } catch {
      setActionError('请求失败，请打开 Coloop 重试。')
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

  const beginDrag = (event: PointerEvent<HTMLElement>) => {
    if (
      event.button !== 0 ||
      (event.target as Element).closest(
        '.control-stop, .control-preview-open, .control-preview-close',
      )
    )
      return
    event.preventDefault()
    if (leaveTimer.current) clearTimeout(leaveTimer.current)
    gesture.current = { x: event.screenX, y: event.screenY, moved: false }
    suppressClick.current = false
    dragging.current = true
    setDraggingTab(Boolean((event.target as Element).closest('.island-edge-tab')))
    const target = (event.target as Element).closest('button, .island-drag-handle')
    const captureTarget = target instanceof HTMLElement ? target : event.currentTarget
    captureTarget.setPointerCapture(event.pointerId)
    void window.coloopControl?.drag('start', { x: event.screenX, y: event.screenY })
  }
  const moveDrag = (event: PointerEvent<HTMLElement>) => {
    const start = gesture.current
    if (!dragging.current || !start) return
    if (Math.hypot(event.screenX - start.x, event.screenY - start.y) >= 4) start.moved = true
    if (start.moved) void window.coloopControl?.drag('move', { x: event.screenX, y: event.screenY })
  }
  const endDrag = (event: PointerEvent<HTMLElement>) => {
    if (!dragging.current) return
    dragging.current = false
    setDraggingTab(false)
    suppressClick.current = gesture.current?.moved ?? false
    gesture.current = null
    void window.coloopControl?.drag('end', { x: event.screenX, y: event.screenY })
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId)
  }
  const toggleDetails = () => {
    if (leaveTimer.current) clearTimeout(leaveTimer.current)
    setHovered(true)
    void runAction(async () => {
      const revealed = await window.coloopControl?.setRevealed(true, reducedMotion)
      if (!revealed?.ok) return revealed || { ok: false }
      return (await window.coloopControl?.setExpanded(!expanded)) || { ok: false }
    })
  }

  if (snapshot.mode === 'hidden' && !actionError) return null
  return (
    <main
      ref={surface}
      className="control-indicator"
      data-mode={snapshot.mode}
      data-expanded={expanded}
      data-revealed={revealed}
      data-details-visible={detailsVisible}
      data-attention={snapshot.attention && snapshot.mode === 'question'}
      data-snap={snapshot.snapEdge}
      data-dock={snapshot.dockEdge}
      data-dock-collapsed={snapshot.dockCollapsed || draggingTab}
      onMouseEnter={(event) => {
        if (leaveTimer.current) clearTimeout(leaveTimer.current)
        if (
          !snapshot.dockCollapsed &&
          !dragging.current &&
          !(event.target as Element).closest('.island-drag-handle')
        )
          setHovered(true)
      }}
      onMouseMove={(event) => {
        if (leaveTimer.current) clearTimeout(leaveTimer.current)
        if (
          !snapshot.dockCollapsed &&
          !dragging.current &&
          !(event.target as Element).closest('.island-drag-handle')
        )
          setHovered(true)
      }}
      onMouseLeave={() => {
        if (leaveTimer.current) clearTimeout(leaveTimer.current)
        leaveTimer.current = setTimeout(() => {
          if (!dragging.current) setHovered(false)
        }, 350)
      }}
      onFocusCapture={(event) =>
        setFocusWithin(
          (event.target as HTMLElement).matches(
            'input, textarea, select, [contenteditable="true"]',
          ),
        )
      }
      onBlurCapture={(event) => {
        if (
          !(event.relatedTarget instanceof HTMLElement) ||
          !event.relatedTarget.matches('input, textarea, select, [contenteditable="true"]')
        )
          setFocusWithin(false)
      }}
      onClickCapture={(event) => {
        if (suppressClick.current) {
          suppressClick.current = false
          event.preventDefault()
          event.stopPropagation()
        }
      }}
      aria-label="Coloop control status"
    >
      {(snapshot.dockCollapsed || draggingTab) && (
        <button
          className="island-edge-tab"
          aria-label="展开 Coloop 浮窗"
          title="展开 Coloop 浮窗"
          onPointerDown={beginDrag}
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onLostPointerCapture={endDrag}
          onClick={toggleDetails}
        >
          <img src={brandMark} alt="" />
          {snapshot.dockEdge === 'top' ? (
            <ChevronDown size={14} />
          ) : snapshot.dockEdge === 'left' ? (
            <ChevronRight size={14} />
          ) : (
            <ChevronLeft size={14} />
          )}
          {snapshot.mode === 'question' && snapshot.attention && (
            <i className="island-attention-dot" />
          )}
        </button>
      )}
      <header
        className="island-header"
        onPointerDown={beginDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
      >
        <div className="island-drag-handle" title="按住拖动灵动岛" aria-label="拖动灵动岛">
          {snapshot.snapEdge === 'top' ? (
            <ChevronUp size={16} aria-hidden="true" />
          ) : snapshot.snapEdge === 'left' ? (
            <ChevronLeft size={16} aria-hidden="true" />
          ) : snapshot.snapEdge === 'right' ? (
            <ChevronRight size={16} aria-hidden="true" />
          ) : (
            <GripHorizontal size={16} aria-hidden="true" />
          )}
        </div>
        <button
          className="control-brand"
          title={expanded ? '收起任务详情' : '展开任务详情'}
          aria-label={expanded ? '收起浮窗详情' : '展开浮窗详情'}
          onClick={toggleDetails}
        >
          <img src={brandMark} alt="" />
          {uncertain && <TriangleAlert className="control-warning" size={12} aria-hidden="true" />}
        </button>
        <button
          className="control-copy"
          aria-label={expanded ? '收起任务详情' : '展开任务详情'}
          aria-expanded={expanded}
          disabled={pendingAction}
          onClick={toggleDetails}
        >
          <strong key={snapshot.questionId ?? snapshot.mode} className="control-title">
            {snapshot.previewDetails === false ? 'Coloop' : (snapshot.title ?? 'Coloop')}
          </strong>
          <span
            className="control-detail"
            title={snapshot.snapEdge ? undefined : detail}
            role={snapshot.snapEdge ? 'status' : undefined}
          >
            {snapshot.snapEdge
              ? `松开即可收至${{ top: '顶部', left: '左侧', right: '右侧' }[snapshot.snapEdge]}`
              : detail}
          </span>
        </button>

        {preview ? (
          <>
            <button
              className="control-preview-open"
              onClick={() => void window.coloopControl?.openMain().catch(() => {})}
              aria-label="打开 Coloop"
              title="打开 Coloop"
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
            <span>{stopping ? '停止中' : '停止'}</span>
          </button>
        ) : null}
      </header>
      {!preview && snapshot.mode !== 'question' && (
        <form
          data-visible={detailsVisible}
          inert={!detailsVisible}
          aria-hidden={!detailsVisible}
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
              if (result?.ok) {
                setGoal('')
                setCommandStatus(active ? '已加入当前任务消息队列' : '已发送任务')
                setActionError('')
              }
              return result || { ok: false }
            })
          }}
        >
          <input
            ref={commandInput}
            id="island-goal"
            aria-label="让 Coloop 做什么"
            placeholder={
              active && canStartTask
                ? '补充要求，Enter 加入消息队列'
                : canStartTask
                  ? '让 Coloop 做什么？'
                  : '正在停止，请稍候'
            }
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
            onChange={(event) => {
              setGoal(event.target.value)
              setCommandStatus('')
            }}
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
      {!preview && (
        <section
          ref={panel}
          className="island-panel"
          data-visible={revealed && expanded}
          inert={!revealed || !expanded}
          aria-hidden={!revealed || !expanded}
          aria-label="任务详情"
        >
          <div className="island-model">
            <span>{snapshot.model}</span>
            {active && <span>{elapsed(snapshot.startedAt, now)}</span>}
          </div>
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
                执行
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
                忽略
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
              {snapshot.questionKind === 'approval' ? null : !editingAnswer ? (
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
                  填写回答
                </button>
              ) : (
                <form
                  onSubmit={(event) => {
                    event.preventDefault()
                    if (answer.trim()) void submitAnswer(answer.trim())
                  }}
                >
                  <label htmlFor="island-answer">你的回答</label>
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
                      提交回答
                    </button>
                    <button
                      className="island-secondary"
                      type="button"
                      onClick={() => {
                        setEditingAnswer(false)
                        void window.coloopControl?.endAnswer()
                      }}
                    >
                      取消回答
                    </button>
                  </div>
                </form>
              )}
            </>
          )}
        </section>
      )}
      {!preview && detailsVisible && (
        <footer className="island-footer-actions">
          <button
            onClick={() =>
              void runAction(() =>
                window.coloopControl?.pauseObservation(!snapshot.observationPaused),
              )
            }
          >
            {snapshot.observationPaused ? '继续观察' : '暂停观察'}
          </button>
          <button
            onClick={() => {
              setEditingAnswer(false)
              setFocusWithin(false)
              void window.coloopControl?.endAnswer()
              void window.coloopControl?.setExpanded(false)
            }}
          >
            收起详情
          </button>
          <button aria-label="关闭灵动岛" onClick={() => closeSurface()}>
            关闭浮窗
          </button>
          <button
            className="island-chat-link"
            onClick={() => void runAction(() => window.coloopControl?.openMain())}
          >
            回到聊天 →
          </button>
        </footer>
      )}
    </main>
  )
}
