import { useEffect, useRef, useState } from 'react'
import { MessageSquare, Settings2, History, Database, LoaderCircle } from 'lucide-react'
import type { AppSnapshot, Settings } from '../../shared/contracts'
import { api, unwrap } from './api'
import { BrandMark } from './components'
import { ConversationHome } from './ConversationHome'
import { ConfigurationPage } from './ConfigurationPage'
import { RecordsPage } from './RecordsPage'
import { MemoryPage } from './MemoryPage'
import './workspace.css'

type Page = 'home' | 'configuration' | 'records' | 'memory'
const navigation = [
  { id: 'home' as const, label: '首页', icon: MessageSquare },
  { id: 'configuration' as const, label: '配置', icon: Settings2 },
  { id: 'records' as const, label: '记录', icon: History },
  { id: 'memory' as const, label: '记忆', icon: Database },
]
export function App() {
  const [snapshot, setSnapshot] = useState<AppSnapshot>()
  const [page, setPage] = useState<Page>('home')
  const [selectedId, setSelectedId] = useState<string>()
  const [fatal, setFatal] = useState('')
  const [startupAttempt, setStartupAttempt] = useState(0)
  const [requestedTask, setRequestedTask] = useState<string>()
  const [externalTask, setExternalTask] = useState<string>()
  const [diagnosticTask, setDiagnosticTask] = useState<string>()
  const [recordTask, setRecordTask] = useState<string>()
  const [focusedRun, setFocusedRun] = useState<string>()
  const [toast, setToast] = useState<{ text: string; error?: boolean }>()
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const notify = (text: string, error = false) => {
    clearTimeout(toastTimer.current)
    setToast({ text, error })
    toastTimer.current = setTimeout(() => setToast(undefined), error ? 8000 : 4000)
  }
  useEffect(() => {
    if (!api) {
      setFatal('请从 Coloop 桌面应用打开工作区')
      return
    }
    let active = true
    let receivedSnapshot = false
    const unsubscribe = api.onSnapshot((value) => {
      if (!active) return
      receivedSnapshot = true
      setSnapshot(value)
      setFatal('')
    })
    const unsubscribeTask = api.onOpenTask((id) => {
      if (!active) return
      setRequestedTask(id)
      setPage('home')
    })
    const readSnapshot = async () => {
      try {
        const value = await unwrap(api.snapshot())
        if (!active || receivedSnapshot) return
        setSnapshot(value)
        setFatal('')
      } catch (error) {
        if (!active || receivedSnapshot) return
        setFatal(error instanceof Error ? error.message : '工作区读取失败，请重试')
      }
    }
    void readSnapshot()
    return () => {
      active = false
      unsubscribe()
      unsubscribeTask()
      clearTimeout(toastTimer.current)
    }
  }, [startupAttempt])
  useEffect(() => {
    if (!requestedTask) return
    const owner = snapshot?.conversations?.conversations.find((entry) =>
      entry.runs.some((run) => run.id === requestedTask),
    )
    if (owner) {
      if (owner.archived) void api.updateConversation({ id: owner.id, archived: false })
      setSelectedId(owner.id)
      setFocusedRun(requestedTask)
      setExternalTask(undefined)
      setRequestedTask(undefined)
    } else if (snapshot?.autoAgentWork?.tasks.some((task) => task.id === requestedTask)) {
      setExternalTask(requestedTask)
      setRequestedTask(undefined)
    }
  }, [requestedTask, snapshot?.conversations, snapshot?.autoAgentWork])
  useEffect(() => {
    if (!selectedId && snapshot?.conversations?.conversations.length)
      setSelectedId(snapshot.conversations.conversations.find((entry) => !entry.archived)?.id)
  }, [snapshot?.conversations, selectedId])
  const openConversation = (id: string) => {
    if (snapshot?.conversations?.conversations.find((entry) => entry.id === id)?.archived)
      void api.updateConversation({ id, archived: false }).then((result) => {
        if (!result.ok) notify(result.error, true)
      })
    setSelectedId(id)
    setExternalTask(undefined)
    setFocusedRun(undefined)
    setPage('home')
  }
  const createDraft = async (text = '') => {
    try {
      const id = await unwrap(api.createConversation({}))
      if (text) await unwrap(api.updateConversation({ id, draft: text }))
      openConversation(id)
    } catch (error) {
      notify((error as Error).message, true)
    }
  }
  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'n') {
        event.preventDefault()
        void createDraft()
      }
    }
    window.addEventListener('keydown', handle)
    return () => window.removeEventListener('keydown', handle)
  }, [])
  const workspaceReady = Boolean(snapshot || fatal)
  useEffect(() => {
    if (!workspaceReady) return
    let secondFrame = 0
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => api?.rendererReady?.())
    })
    return () => {
      cancelAnimationFrame(firstFrame)
      cancelAnimationFrame(secondFrame)
    }
  }, [workspaceReady])
  const onSaved = (settings: Settings) =>
    setSnapshot((current) => (current ? { ...current, settings } : current))
  if (fatal)
    return (
      <main className="startup">
        <BrandMark />
        <h1>工作区暂不可用</h1>
        <p role="alert">{fatal}</p>
        {api && (
          <button
            className="button primary"
            onClick={() => {
              setFatal('')
              setStartupAttempt((attempt) => attempt + 1)
            }}
          >
            重新读取工作区
          </button>
        )}
      </main>
    )
  if (!snapshot)
    return (
      <main className="startup">
        <LoaderCircle className="spin" aria-hidden="true" />
        <p role="status">正在读取工作区…</p>
      </main>
    )
  return (
    <div className="workspace-app">
      <aside className="workspace-navigation">
        <div className="workspace-brand" title="Coloop">
          <BrandMark />
          <span>Coloop</span>
        </div>
        <nav aria-label="主导航">
          {navigation.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              aria-current={page === id ? 'page' : undefined}
              onClick={() => {
                setPage(id)
                setDiagnosticTask(undefined)
                setRecordTask(undefined)
              }}
            >
              <Icon size={21} />
              <span>{label}</span>
            </button>
          ))}
        </nav>
        <small className="workspace-version">v{snapshot.version}</small>
      </aside>
      <main className="workspace-main">
        {page === 'home' && (
          <ConversationHome
            snapshot={snapshot}
            selectedId={selectedId}
            select={openConversation}
            externalTaskId={externalTask}
            focusedRunId={focusedRun}
            onConfigure={() => setPage('configuration')}
          />
        )}
        {page === 'configuration' && (
          <ConfigurationPage
            snapshot={snapshot}
            onSaved={onSaved}
            notify={notify}
            onDraft={(text) => void createDraft(text)}
            diagnosticTask={diagnosticTask}
            onRecord={(id) => {
              setRecordTask(id)
              setPage('records')
            }}
          />
        )}
        {page === 'records' && (
          <RecordsPage
            snapshot={snapshot}
            onConversation={openConversation}
            notify={notify}
            initialRunId={recordTask}
            onDiagnostic={(id) => {
              setDiagnosticTask(id)
              setPage('configuration')
            }}
          />
        )}
        {page === 'memory' && (
          <div className="workspace-page">
            <MemoryPage
              snapshot={snapshot}
              onConfigure={() => setPage('configuration')}
              onTask={(id) => {
                const owner = snapshot.conversations?.conversations.find((entry) =>
                  entry.runs.some((run) => run.id === id),
                )
                if (owner) openConversation(owner.id)
                else notify('来源任务未保存在当前工作区', true)
              }}
            />
          </div>
        )}
      </main>
      {toast && (
        <div
          className={`workspace-toast ${toast.error ? 'is-error' : ''}`}
          role={toast.error ? 'alert' : 'status'}
        >
          {toast.text}
        </div>
      )}
    </div>
  )
}
