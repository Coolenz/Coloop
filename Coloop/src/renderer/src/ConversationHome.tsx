import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  ShieldCheck,
  ShieldAlert,
  Hand,
  Check,
  Plus,
  Search,
  ArrowUp,
  PanelLeft,
  Paperclip,
  ScanLine,
  X,
  Square,
  Archive,
  Pencil,
} from 'lucide-react'
import type { AppSnapshot, TaskHistoryEntry } from '../../shared/contracts'
import type {
  ConversationDetail,
  ConversationRun,
  PermissionMode,
} from '../../shared/conversations'
import { api, unwrap } from './api'
import { proactivePhaseLabels } from '../../shared/proactive'
import { AutoAgentWorkPage } from './AutoAgentWorkPage'

const permissionOptions: {
  value: PermissionMode
  label: string
  description: string
  icon: typeof Hand
}[] = [
  {
    value: 'ask',
    label: '请求批准',
    description: '访问文件、网络或操作电脑前逐次询问',
    icon: Hand,
  },
  {
    value: 'auto',
    label: '帮我批准',
    description: '自动允许只读工具，写入和执行操作请求批准',
    icon: ShieldCheck,
  },
  {
    value: 'full',
    label: '完全访问权限',
    description: '自动执行当前任务可用工具，使用已授权的目录与连接',
    icon: ShieldAlert,
  },
]

export const runLabels: Record<ConversationRun['state'], string> = {
  queued: '等待执行',
  running: '执行中',
  interrupted: '等待恢复',
  completed: '已完成',
  failed: '未完成',
  cancelled: '已取消',
}
const clock = (at: string | number) =>
  new Date(at).toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })

export function ConversationHome({
  snapshot,
  selectedId,
  select,
  onConfigure,
  externalTaskId,
  focusedRunId,
}: {
  snapshot: AppSnapshot
  selectedId?: string
  select(id: string): void
  onConfigure(): void
  externalTaskId?: string
  focusedRunId?: string
}) {
  const state = snapshot.conversations
  const [query, setQuery] = useState('')
  const [drawer, setDrawer] = useState(false)
  const [external, setExternal] = useState<string>()
  useEffect(() => {
    setExternal(externalTaskId)
  }, [externalTaskId])
  const [detail, setDetail] = useState<ConversationDetail>()
  const [error, setError] = useState('')
  const [historyError, setHistoryError] = useState('')
  const [draft, setDraft] = useState('')
  const [reference, setReference] = useState<{ text: string; image?: string; name: string }>()
  const [busy, setBusy] = useState(false)
  const [newMessages, setNewMessages] = useState(false)
  const [messageLimit, setMessageLimit] = useState(50)
  const [editingTitle, setEditingTitle] = useState(false)
  const [title, setTitle] = useState('')
  const [workspace, setWorkspace] = useState('')
  const [optionsOpen, setOptionsOpen] = useState(false)
  const [permissionOpen, setPermissionOpen] = useState(false)
  const [newPermission, setNewPermission] = useState<PermissionMode>('auto')
  const permissionControl = useRef<HTMLDivElement>(null)
  const permissionButton = useRef<HTMLButtonElement>(null)
  const [expandedDetails, setExpandedDetails] = useState<string[]>([])
  const input = useRef<HTMLTextAreaElement>(null)
  const list = useRef<HTMLElement>(null)
  const listButton = useRef<HTMLButtonElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const scroll = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)
  const draftTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const scrollTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const drafts = useRef(new Map<string, string>())
  const pendingSends = useRef(new Map<string, { id: string; text: string; context?: string }>())
  const readPositions = useRef(new Map<string, { scrollTop: number; followingLatest: boolean }>())
  const restoreScroll = useRef(true)
  const olderHeight = useRef<number | undefined>(undefined)
  const selectionRef = useRef(selectedId)
  selectionRef.current = selectedId
  const selected = state?.conversations.find((entry) => entry.id === selectedId)
  const activeOwner = state?.conversations.find((entry) =>
    entry.runs.some((run) => run.state === 'running'),
  )
  const permissionMode = selected ? (selected.permissionMode ?? 'full') : newPermission
  const permission = permissionOptions.find((option) => option.value === permissionMode)!
  const closeDrawer = () => {
    setDrawer(false)
    requestAnimationFrame(() => listButton.current?.focus())
  }
  useEffect(() => {
    if (!drawer) return
    search.current?.focus()
    const keyboard = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return
      if (event.key === 'Escape') {
        event.preventDefault()
        closeDrawer()
      }
      if (event.key !== 'Tab') return
      const controls = Array.from(
        list.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input') ?? [],
      ).filter((element) => element.getClientRects().length)
      const first = controls[0]
      const last = controls.at(-1)
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last?.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first?.focus()
      }
    }
    const media = window.matchMedia('(max-width: 1179px)')
    const resize = () => {
      if (!media.matches) setDrawer(false)
    }
    document.addEventListener('keydown', keyboard)
    media.addEventListener('change', resize)
    return () => {
      document.removeEventListener('keydown', keyboard)
      media.removeEventListener('change', resize)
    }
  }, [drawer])
  useLayoutEffect(() => {
    const element = input.current
    if (!element) return
    const resize = () => {
      element.style.height = 'auto'
      element.style.height = `${element.scrollHeight}px`
    }
    resize()
    let width = element.clientWidth
    const observer = new ResizeObserver(() => {
      if (width === element.clientWidth) return
      width = element.clientWidth
      resize()
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [draft, external, optionsOpen])
  useEffect(() => {
    setPermissionOpen(false)
  }, [selectedId])
  useEffect(() => {
    if (!permissionOpen) return
    const close = (event: PointerEvent) => {
      if (!permissionControl.current?.contains(event.target as Node)) setPermissionOpen(false)
    }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [permissionOpen])
  const latest = selected?.runs.at(-1)
  const question =
    snapshot.proactive?.taskId === latest?.id ? snapshot.proactive?.question : undefined
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const matchesQuery = (text: string) => text.toLocaleLowerCase().includes(normalizedQuery)
  const externalTasks = (snapshot.autoAgentWork?.tasks ?? []).filter(
    (task) => task.state !== 'unbound' && matchesQuery(task.goal),
  )
  const conversations = (state?.conversations ?? [])
    .filter(
      (entry) =>
        !entry.archived &&
        (matchesQuery(entry.title) || entry.messages.some((message) => matchesQuery(message.text))),
    )
    .sort((a, b) => {
      const priority = (value: typeof a) =>
        value.runs.some((run) => ['running', 'queued', 'interrupted'].includes(run.state)) ? 1 : 0
      return priority(b) - priority(a) || b.updatedAt.localeCompare(a.updatedAt)
    })
  useEffect(() => {
    setDetail(undefined)
    setError('')
    setHistoryError('')
    setMessageLimit(selected?.visibleMessages ?? 50)
    setExpandedDetails(selected?.expandedDetails ?? [])
    setReference(undefined)
    setEditingTitle(false)
    setDraft(selectedId ? (drafts.current.get(selectedId) ?? selected?.draft ?? '') : '')
    setWorkspace(latest?.workspace ?? snapshot.settings.taskWorkspace ?? '')
    restoreScroll.current = true
    setNewMessages(false)
    const position = selectedId ? readPositions.current.get(selectedId) : undefined
    stickToBottom.current =
      position?.followingLatest ?? selected?.followingLatest ?? !selected?.scrollTop
    return () => {
      if (selectedId && drafts.current.has(selectedId))
        void api.updateConversation({ id: selectedId, draft: drafts.current.get(selectedId) })
    }
  }, [selectedId])
  useEffect(() => {
    if (selected && !drafts.current.has(selected.id)) {
      drafts.current.set(selected.id, selected.draft)
      setDraft(selected.draft)
    }
  }, [selected?.id])
  useEffect(() => {
    if (!selectedId || external) return
    let alive = true
    let timer: ReturnType<typeof setTimeout>
    const read = async () => {
      try {
        const value = await unwrap(api.conversationDetail(selectedId))
        if (alive) {
          setDetail(value)
          setHistoryError('')
        }
      } catch (failure) {
        if (alive) setHistoryError((failure as Error).message)
      } finally {
        if (alive) timer = setTimeout(() => void read(), latest?.state === 'running' ? 1500 : 4000)
      }
    }
    void read()
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [selectedId, latest?.state, external])
  useEffect(
    () => () => {
      clearTimeout(draftTimer.current)
      clearTimeout(scrollTimer.current)
      for (const [id, draft] of drafts.current) void api.updateConversation({ id, draft })
      for (const [id, position] of readPositions.current)
        void api.updateConversation({ id, ...position })
    },
    [],
  )
  const events: {
    id: string
    at: number
    entry: TaskHistoryEntry
    run?: ConversationRun
    delivery?: string
    error?: string
  }[] = []
  for (const message of selected?.messages ?? [])
    events.push({
      id: message.id,
      at: Date.parse(message.at),
      entry: { kind: 'user', text: message.text },
      run: selected?.runs.find((run) => run.id === message.runId),
      delivery: message.delivery,
      error: message.error,
    })
  for (const run of selected?.runs ?? []) {
    const history = detail?.history[run.id]
    for (const [index, entry] of (history?.entries ?? []).entries())
      if (entry.kind !== 'user')
        events.push({
          id: `${run.id}-${index}`,
          at: entry.at ?? Date.parse(run.createdAt),
          entry,
          run,
        })
    if (run.task?.answer && !history?.entries.some((entry) => entry.text === run.task?.answer))
      events.push({
        id: `${run.id}-answer`,
        at: Date.parse(run.task.finishedAt ?? run.createdAt),
        entry: { kind: 'assistant', text: run.task.answer },
        run,
      })
  }
  events.sort((a, b) => a.at - b.at)
  const lastEvent = events.at(-1)?.id
  useLayoutEffect(() => {
    if (!scroll.current || detail?.id !== selectedId) return
    if (restoreScroll.current) {
      scroll.current.scrollTop = stickToBottom.current
        ? scroll.current.scrollHeight
        : (readPositions.current.get(selectedId!)?.scrollTop ?? selected?.scrollTop ?? 0)
      restoreScroll.current = false
      return
    }
    if (olderHeight.current !== undefined) {
      scroll.current.scrollTop += scroll.current.scrollHeight - olderHeight.current
      olderHeight.current = undefined
      return
    }
    if (stickToBottom.current) scroll.current.scrollTop = scroll.current.scrollHeight
    else setNewMessages(true)
  }, [lastEvent, detail?.id, messageLimit])
  useEffect(() => {
    if (!focusedRunId || detail?.id !== selectedId) return
    const element = scroll.current?.querySelector(`[data-run-id="${focusedRunId}"]`)
    if (element) {
      stickToBottom.current = false
      element.scrollIntoView({ block: 'center' })
    } else if (messageLimit < events.length) setMessageLimit(events.length)
  }, [focusedRunId, detail?.id, messageLimit])
  const act = async (work: () => Promise<unknown>) => {
    setError('')
    setBusy(true)
    try {
      await work()
    } catch (failure) {
      setError((failure as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const create = () =>
    void act(async () => {
      const id = await unwrap(api.createConversation({ permissionMode: newPermission }))
      setExternal(undefined)
      select(id)
      setDrawer(false)
      requestAnimationFrame(() => input.current?.focus())
    })
  const changeDraft = (text: string) => {
    setDraft(text)
    if (!selectedId) return
    drafts.current.set(selectedId, text)
    clearTimeout(draftTimer.current)
    const id = selectedId
    draftTimer.current = setTimeout(() => {
      void api.updateConversation({ id, draft: text }).then((result) => {
        if (!result.ok) setError(result.error)
      })
    }, 250)
  }
  const answer = (text: string) =>
    act(async () => {
      if (!question || !latest) return
      const owner = selectedId
      const originalDraft = draft
      await unwrap(
        api.answerProactiveQuestion({
          taskId: latest.id,
          questionId: String(question.question_id),
          answer: text,
        }),
      )
      if (
        selectionRef.current === owner &&
        (drafts.current.get(owner!) ?? originalDraft) === originalDraft
      )
        changeDraft('')
    })
  const send = () => {
    if (!draft.trim() || busy) return
    if (question) {
      void answer(draft)
      return
    }
    void act(async () => {
      const originalDraft = draft
      const text = draft.trim()
      const id =
        selectedId ?? (await unwrap(api.createConversation({ permissionMode: newPermission })))
      if (!selectedId) {
        drafts.current.set(id, originalDraft)
        await unwrap(api.updateConversation({ id, draft: originalDraft }))
        select(id)
      }
      let pending = pendingSends.current.get(id)
      if (!pending || pending.text !== text || pending.context !== reference?.text) {
        pending = { id: crypto.randomUUID(), text, context: reference?.text }
        pendingSends.current.set(id, pending)
      }
      clearTimeout(draftTimer.current)
      const result = await api.sendConversation({
        conversationId: id,
        messageId: pending.id,
        text,
        context: reference?.text,
        workspace: workspace || undefined,
      })
      if (!result.ok) {
        if (!/待确认|未确认/.test(result.error)) pendingSends.current.delete(id)
        throw new Error(result.error)
      }
      pendingSends.current.delete(id)
      if ((drafts.current.get(id) ?? originalDraft) === originalDraft) {
        if (selectionRef.current === id) clearTimeout(draftTimer.current)
        drafts.current.set(id, '')
        if (selectionRef.current === id)
          setDraft((current) => (current === originalDraft ? '' : current))
      }
      if (selectionRef.current === id) {
        setReference(undefined)
        stickToBottom.current = true
        const nextDetail = await unwrap(api.conversationDetail(id))
        if (selectionRef.current === id) setDetail(nextDetail)
      }
    })
  }
  const attach = (capture: boolean) =>
    void act(async () => {
      const owner = selectedId
      const value = await unwrap(capture ? api.captureScreen() : api.openImage())
      if (!value) return
      const ocr = await unwrap(api.recognize(value.id))
      if (selectionRef.current !== owner) return
      setReference({
        text: `图片参考资料（${value.name}）：\n${ocr.text}`,
        image: value.dataUrl,
        name: value.name,
      })
    })
  return (
    <div className="conversation-home">
      {drawer && <div className="conversation-backdrop" onClick={closeDrawer} aria-hidden="true" />}
      <aside
        ref={list}
        id="task-conversation-list"
        className="conversation-list"
        data-open={drawer}
        aria-label="任务聊天列表"
      >
        <div className="conversation-drawer-heading">
          <strong>任务列表</strong>
          <button className="icon-button" aria-label="关闭任务列表" onClick={closeDrawer}>
            <X size={18} />
          </button>
        </div>
        <button className="button primary" onClick={create}>
          <Plus size={16} />
          新任务
        </button>
        <label className="conversation-search">
          <Search size={16} />
          <input
            ref={search}
            aria-label="搜索任务"
            placeholder="搜索任务"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {query && (
            <button
              type="button"
              className="search-clear"
              aria-label="清除搜索"
              onClick={() => {
                setQuery('')
                search.current?.focus()
              }}
            >
              <X size={14} />
            </button>
          )}
        </label>
        <div className="conversation-list-scroll">
          {conversations.map((conversation) => {
            const run = conversation.runs.at(-1)
            const position = run ? (state?.queue.indexOf(run.id) ?? -1) : -1
            return (
              <button
                key={conversation.id}
                className="conversation-item"
                aria-current={selectedId === conversation.id && !external ? 'page' : undefined}
                onClick={() => {
                  setExternal(undefined)
                  select(conversation.id)
                  if (drawer) closeDrawer()
                }}
              >
                <strong>{conversation.title}</strong>
                <span>{conversation.messages.at(-1)?.text ?? '开始新的任务'}</span>
                <small>
                  {run
                    ? position >= 0
                      ? `等待执行 · 第 ${position + 1} 项`
                      : runLabels[run.state]
                    : '草稿'}{' '}
                  · {clock(conversation.updatedAt)}
                </small>
              </button>
            )
          })}
          {externalTasks.map((task) => (
            <button
              className="conversation-item"
              key={task.id}
              aria-current={external === task.id ? 'page' : undefined}
              onClick={() => {
                setExternal(task.id)
                if (drawer) closeDrawer()
              }}
            >
              <strong>{task.goal}</strong>
              <small>外部 Agent 跟进</small>
            </button>
          ))}
          {!conversations.length && !externalTasks.length && (
            <p className="empty-copy" role="status">
              {normalizedQuery ? '没有匹配的任务' : '从一条消息开始'}
            </p>
          )}
        </div>
        {!!state?.queue.length && (
          <div className="queue-summary">
            <span>{state.queue.length} 项等待执行</span>
            <button onClick={() => void act(() => unwrap(api.pauseQueue(!state.paused)))}>
              {state.paused ? '继续队列' : '暂停队列'}
            </button>
          </div>
        )}
      </aside>
      <section className="conversation-content" aria-label="任务聊天">
        {external ? (
          <>
            <div className="external-task-navigation">
              <button
                ref={listButton}
                className="text-button"
                aria-label="打开任务列表"
                aria-expanded={drawer}
                aria-controls="task-conversation-list"
                onClick={() => setDrawer(true)}
              >
                <PanelLeft size={19} />
                任务列表
              </button>
            </div>
            <AutoAgentWorkPage snapshot={snapshot} initialTaskId={external} key={external} />
          </>
        ) : (
          <>
            <header className="conversation-header">
              <button
                ref={listButton}
                className="icon-button conversation-menu"
                aria-label="打开任务列表"
                aria-expanded={drawer}
                aria-controls="task-conversation-list"
                onClick={() => setDrawer(!drawer)}
              >
                <PanelLeft size={19} />
              </button>
              <div>
                <h1>{selected?.title ?? '新任务'}</h1>
                <p>
                  {latest ? runLabels[latest.state] : '准备开始'}
                  {latest?.task?.model
                    ? ` · ${latest.task.model}`
                    : ` · ${snapshot.settings.provider.model}`}
                </p>
              </div>
              {selected && (
                <div className="conversation-actions">
                  <button
                    className="icon-button"
                    aria-label="重命名任务"
                    onClick={() => {
                      setTitle(selected.title)
                      setEditingTitle(true)
                    }}
                  >
                    <Pencil size={16} />
                  </button>
                  <button
                    className="icon-button"
                    aria-label="归档任务"
                    onClick={() =>
                      void act(async () => {
                        await unwrap(api.updateConversation({ id: selected.id, archived: true }))
                        create()
                      })
                    }
                  >
                    <Archive size={16} />
                  </button>
                </div>
              )}
              {latest?.state === 'running' && (
                <button
                  className="button secondary"
                  onClick={() =>
                    void act(() =>
                      snapshot.proactive?.taskId === latest.id
                        ? unwrap(api.stopProactiveTask())
                        : unwrap(api.cancelTask(latest.id)),
                    )
                  }
                >
                  <Square size={13} />
                  停止当前任务
                </button>
              )}
            </header>
            {activeOwner && activeOwner.id !== selectedId && (
              <div className="conversation-banner">
                <span>正在执行「{activeOwner.title}」</span>
                <button onClick={() => select(activeOwner.id)}>查看当前任务</button>
              </div>
            )}
            {editingTitle && selected && (
              <form
                className="inline-title-editor"
                onSubmit={(event) => {
                  event.preventDefault()
                  void act(async () => {
                    await unwrap(api.updateConversation({ id: selected.id, title }))
                    setEditingTitle(false)
                  })
                }}
              >
                <input
                  aria-label="任务标题"
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  autoFocus
                  maxLength={120}
                />
                <button className="button">保存</button>
                <button
                  type="button"
                  className="text-button"
                  onClick={() => setEditingTitle(false)}
                >
                  取消
                </button>
              </form>
            )}
            {state?.blockedReason && (
              <div className="conversation-banner" role="status">
                {state.blockedReason}
                <button onClick={onConfigure}>前往配置</button>
              </div>
            )}
            {state?.paused && (
              <div className="conversation-banner">
                执行队列已暂停
                <button onClick={() => void act(() => unwrap(api.pauseQueue(false)))}>
                  继续队列
                </button>
              </div>
            )}
            {latest?.state === 'queued' && (
              <div className="conversation-banner">
                等待执行 · 第 {(state?.queue.indexOf(latest.id) ?? 0) + 1} 项
                <button onClick={() => void act(() => unwrap(api.cancelQueuedTask(latest.id)))}>
                  取消排队
                </button>
              </div>
            )}
            <div
              className="conversation-messages"
              ref={scroll}
              onScroll={() => {
                if (restoreScroll.current) return
                const element = scroll.current!
                stickToBottom.current =
                  element.scrollHeight - element.scrollTop - element.clientHeight < 60
                if (stickToBottom.current) setNewMessages(false)
                if (selectedId) {
                  clearTimeout(scrollTimer.current)
                  const id = selectedId,
                    scrollTop = element.scrollTop
                  const position = { scrollTop, followingLatest: stickToBottom.current }
                  readPositions.current.set(id, position)
                  scrollTimer.current = setTimeout(
                    () =>
                      void api.updateConversation({
                        id,
                        scrollTop,
                        followingLatest: position.followingLatest,
                      }),
                    400,
                  )
                }
              }}
            >
              {!events.length && (
                <div className="conversation-empty">
                  <h2>今天想完成什么？</h2>
                  <p>每个任务都保留在这里，随时继续。</p>
                </div>
              )}
              {events.length > messageLimit && (
                <button
                  className="text-button"
                  onClick={() => {
                    olderHeight.current = scroll.current?.scrollHeight
                    setMessageLimit(messageLimit + 50)
                    if (selectedId)
                      void api.updateConversation({
                        id: selectedId,
                        visibleMessages: messageLimit + 50,
                      })
                  }}
                >
                  加载更早的消息
                </button>
              )}
              {events.slice(-messageLimit).map(({ id, entry, at, run, delivery, error }) => (
                <article
                  key={id}
                  data-run-id={run?.id}
                  className={`chat-message ${entry.kind === 'user' ? 'from-user' : 'from-agent'}`}
                >
                  {entry.kind === 'tool_call' || entry.kind === 'tool_result' ? (
                    <details
                      open={expandedDetails.includes(id)}
                      onToggle={(event) => {
                        const open = event.currentTarget.open
                        if (open === expandedDetails.includes(id)) return
                        const next = open
                          ? [...expandedDetails, id]
                          : expandedDetails.filter((value) => value !== id)
                        setExpandedDetails(next)
                        if (selectedId)
                          void api.updateConversation({ id: selectedId, expandedDetails: next })
                      }}
                    >
                      <summary>
                        {entry.kind === 'tool_call'
                          ? '调用工具'
                          : entry.error
                            ? '工具返回错误'
                            : '工具返回'}{' '}
                        · {entry.name}
                      </summary>
                      <pre>{entry.text}</pre>
                    </details>
                  ) : (
                    <>
                      <div className="chat-message-meta">
                        <strong>{entry.kind === 'user' ? '你' : 'Coloop'}</strong>
                        <time>{clock(at)}</time>
                        {entry.kind !== 'user' && run?.task?.model && <span>{run.task.model}</span>}
                      </div>
                      <div className="chat-message-text">{entry.text}</div>
                      {delivery === 'queued' && <small>等待受理</small>}
                      {delivery === 'failed' && (
                        <p className="inline-error">{error ?? '消息未被受理'}</p>
                      )}
                    </>
                  )}
                </article>
              ))}
              {latest?.state === 'running' && (
                <p role="status" className="chat-progress">
                  {snapshot.proactive?.taskId === latest.id
                    ? (proactivePhaseLabels[snapshot.proactive.phase] ?? snapshot.proactive.phase)
                    : (latest.task?.stage ?? '正在准备任务')}
                </p>
              )}
              {latest && ['failed', 'interrupted', 'cancelled'].includes(latest.state) && (
                <section className="chat-attention">
                  <strong>{runLabels[latest.state]}</strong>
                  <p>{latest.error ?? latest.task?.error ?? '执行记录已保留，可以继续处理。'}</p>
                  <button
                    className="button"
                    onClick={() =>
                      void act(() =>
                        unwrap(
                          api.resumeConversation({
                            conversationId: selected!.id,
                            runId: latest.id,
                          }),
                        ),
                      )
                    }
                  >
                    继续未完成部分
                  </button>
                  {latest.state === 'interrupted' && (
                    <button
                      className="text-button"
                      onClick={() => void act(() => unwrap(api.cancelQueuedTask(latest.id)))}
                    >
                      取消此任务
                    </button>
                  )}
                </section>
              )}
              {question && (
                <section className="chat-attention" aria-label="待你处理">
                  <strong>{question.kind === 'approval' ? '需要你批准操作' : '需要你处理'}</strong>
                  <p>{String(question.question)}</p>
                  {question.kind === 'approval' && typeof question.details === 'string' && (
                    <details>
                      <summary>查看本次操作</summary>
                      <pre>{question.details}</pre>
                    </details>
                  )}
                  <div className="question-choices">
                    {(Array.isArray(question.options) ? question.options : []).map((choice) => (
                      <button
                        className="button"
                        key={String(choice)}
                        disabled={busy}
                        onClick={() => void answer(String(choice))}
                      >
                        {String(choice)}
                      </button>
                    ))}
                  </div>
                </section>
              )}
            </div>
            {newMessages && (
              <button
                className="new-messages"
                onClick={() => {
                  stickToBottom.current = true
                  scroll.current?.scrollTo({ top: scroll.current.scrollHeight })
                  setNewMessages(false)
                }}
              >
                有新消息 · 回到最新
              </button>
            )}
            <footer className="conversation-composer">
              {(error || historyError || state?.error) && (
                <p role="alert" className="inline-error">
                  {error || historyError || state?.error}
                </p>
              )}
              {reference && (
                <div className="attachment-preview">
                  {reference.image && <img src={reference.image} alt="附加图片预览" />}
                  <span>{reference.name}</span>
                  <button aria-label="移除附件" onClick={() => setReference(undefined)}>
                    <X size={15} />
                  </button>
                </div>
              )}
              <textarea
                ref={input}
                aria-describedby="composer-shortcuts"
                aria-label={question ? '回答当前问题' : '任务消息'}
                placeholder={
                  question
                    ? '回答当前问题…'
                    : latest?.state === 'running'
                      ? '补充这项任务的要求…'
                      : selected?.messages.length
                        ? '继续这个任务…'
                        : '描述你希望完成的事情…'
                }
                value={draft}
                onChange={(event) => changeDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (
                    event.key === 'Enter' &&
                    !event.shiftKey &&
                    !event.nativeEvent.isComposing &&
                    event.keyCode !== 229
                  ) {
                    event.preventDefault()
                    send()
                  }
                }}
                rows={3}
              />
              {optionsOpen && (
                <label className="composer-options">
                  工作目录
                  <input
                    value={workspace}
                    onChange={(event) => setWorkspace(event.target.value)}
                    placeholder="使用配置中的默认目录"
                  />
                </label>
              )}
              <div className="composer-toolbar">
                <div
                  className="composer-permission"
                  ref={permissionControl}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                      setPermissionOpen(false)
                      permissionButton.current?.focus()
                    }
                  }}
                >
                  <button
                    ref={permissionButton}
                    className="text-button permission-trigger"
                    data-mode={permissionMode}
                    aria-label={`权限设置，${permission.label}`}
                    aria-expanded={permissionOpen}
                    aria-controls="task-permission-options"
                    onClick={() => setPermissionOpen(!permissionOpen)}
                  >
                    <permission.icon size={17} />
                    {permission.label}
                  </button>
                  {permissionOpen && (
                    <div
                      className="permission-popover"
                      id="task-permission-options"
                      role="group"
                      aria-label="任务权限设置"
                    >
                      <p>应如何批准 Coloop 操作？</p>
                      {permissionOptions.map((option) => (
                        <button
                          key={option.value}
                          className="permission-option"
                          data-mode={option.value}
                          aria-pressed={permissionMode === option.value}
                          disabled={busy}
                          onClick={() =>
                            void act(async () => {
                              if (selected)
                                await unwrap(
                                  api.updateConversation({
                                    id: selected.id,
                                    permissionMode: option.value,
                                  }),
                                )
                              else setNewPermission(option.value)
                              setPermissionOpen(false)
                              permissionButton.current?.focus()
                            })
                          }
                        >
                          <option.icon size={20} />
                          <span>
                            <strong>{option.label}</strong>
                            <small>{option.description}</small>
                          </span>
                          {permissionMode === option.value && <Check size={18} />}
                        </button>
                      ))}
                      {latest && ['running', 'queued', 'interrupted'].includes(latest.state) && (
                        <small className="permission-scope">
                          下一轮执行生效。当前轮次使用
                          {
                            permissionOptions.find(
                              (option) => option.value === (latest.policy.permissionMode ?? 'full'),
                            )?.label
                          }
                          。
                        </small>
                      )}
                    </div>
                  )}
                </div>
                <button className="text-button" disabled={busy} onClick={() => attach(false)}>
                  <Paperclip size={16} />
                  图片
                </button>
                <button className="text-button" disabled={busy} onClick={() => attach(true)}>
                  <ScanLine size={16} />
                  截图
                </button>
                <button
                  className="text-button"
                  aria-expanded={optionsOpen}
                  onClick={() => setOptionsOpen(!optionsOpen)}
                >
                  任务选项
                </button>
                <button
                  className="button primary send-message"
                  disabled={!draft.trim() || busy}
                  onClick={send}
                  aria-label="发送消息"
                >
                  <ArrowUp size={18} />
                </button>
              </div>
              <p className="composer-shortcuts" id="composer-shortcuts">
                Enter 发送 · Shift+Enter 换行
              </p>
            </footer>
          </>
        )}
        {selected?.runs.flatMap((run) =>
          (detail?.history[run.id]?.artifacts ?? []).map((artifact) => (
            <div className="chat-artifact" key={`${run.id}-${artifact.id}`}>
              <span>{artifact.path}</span>
              <button
                className="button"
                onClick={() =>
                  void act(() =>
                    unwrap(api.openTaskArtifact({ taskId: run.id, artifactId: artifact.id })),
                  )
                }
              >
                打开文件
              </button>
            </div>
          )),
        )}
      </section>
    </div>
  )
}
