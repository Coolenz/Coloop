import { useEffect, useRef, useState } from 'react'
import {
  ArrowDownToLine,
  ArrowRight,
  ArrowUp,
  ArrowUpRight,
  Cable,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Clock3,
  Cloud,
  Command,
  Copy,
  Cpu,
  FileImage,
  History,
  LayoutDashboard,
  KeyRound,
  LoaderCircle,
  Monitor,
  MousePointer2,
  Plus,
  ScanLine,
  ScanText,
  Search,
  ShieldCheck,
  Sparkles,
  Square,
  Trash2,
  Workflow,
  X,
  Zap,
  type LucideIcon,
} from 'lucide-react'
import type { AppSnapshot, Capture, OcrResult, Task } from '../../shared/contracts'
import { api, unwrap } from './api'
import { BrandMark, DeviceRail, Logo, Status, TaskResult, time } from './components'
import { DevicePage, ModelsPage } from './Settings'
import { OcrPreview, OcrCoordinates } from './OcrPreview'
import { CoordinatorPage } from './CoordinatorPage'
import { MemoryPage } from './MemoryPage'
import { DesktopPage } from './DesktopPage'
import { ComputerAgentStatus } from './ComputerAgentStatus'
import { proactivePhaseLabels } from '../../shared/proactive'

type Page =
  | 'workspace'
  | 'desktop'
  | 'screen'
  | 'workflows'
  | 'coordinator'
  | 'credentials'
  | 'models'
  | 'device'
  | 'history'
const navigation: { id: Page; name: string; icon: LucideIcon }[] = [
  { id: 'workspace', name: '工作台', icon: LayoutDashboard },
  { id: 'desktop', name: '电脑操作', icon: MousePointer2 },
  { id: 'screen', name: '屏幕理解', icon: ScanLine },
  { id: 'workflows', name: '工作流', icon: Workflow },
  { id: 'coordinator', name: 'Agent 协调', icon: ShieldCheck },
  { id: 'credentials', name: '记忆', icon: KeyRound },
  { id: 'models', name: '模型连接', icon: Cloud },
  { id: 'device', name: '设备管理', icon: Cable },
  { id: 'history', name: '运行历史', icon: History },
]
const workflows = [
  {
    icon: ScanText,
    title: '读懂当前屏幕',
    subtitle: '提取重点，整理信息',
    tag: '屏幕 + AI',
    prompt: '请总结当前屏幕的主要内容，提炼关键结论和需要关注的信息。',
    color: 'blue',
  },
  {
    icon: FileImage,
    title: '识别与提取文字',
    subtitle: '让图片里的文字可编辑',
    tag: '本地 OCR',
    prompt: '',
    color: 'teal',
  },
  {
    icon: Sparkles,
    title: '翻译屏幕内容',
    subtitle: '自然表达，保留原意',
    tag: '屏幕 + AI',
    prompt:
      '请把当前屏幕中的外语内容翻译成简体中文；保留专有名词与结构。如果内容已经是中文，请提炼摘要。',
    color: 'violet',
  },
]

export function App() {
  const [snapshot, setSnapshot] = useState<AppSnapshot>()
  const [fatal, setFatal] = useState('')
  const [page, setPage] = useState<Page>('workspace')
  const [toast, setToast] = useState<{ message: string; error: boolean }>()
  const [help, setHelp] = useState(false)
  const [prompt, setPrompt] = useState('')
  const target = 'cloud' as const
  const [useScreen, setUseScreen] = useState(false)
  const [context, setContext] = useState('')
  const [selectedTaskId, setSelectedTaskId] = useState<string>()
  const [submitting, setSubmitting] = useState(false)
  const [capture, setCapture] = useState<Capture>()
  const [ocrResult, setOcrResult] = useState<OcrResult>()
  const [capturing, setCapturing] = useState(false)
  const [recognizing, setRecognizing] = useState(false)
  const [displayId, setDisplayId] = useState('')
  const [displays, setDisplays] = useState<{ id: string; name: string }[]>([])
  const [historyQuery, setHistoryQuery] = useState('')
  const [historyFilter, setHistoryFilter] = useState('all')
  const [clearConfirm, setClearConfirm] = useState(false)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const notify = (message: string, error = false) => {
    clearTimeout(toastTimer.current)
    setToast({ message, error })
    toastTimer.current = setTimeout(() => setToast(undefined), error ? 8000 : 4000)
  }
  useEffect(() => {
    if (!api) {
      setFatal('请通过 Windows 桌面应用打开 Coloop。浏览器预览不具备设备连接和屏幕捕获能力。')
      return
    }
    void unwrap(api.snapshot())
      .then(setSnapshot)
      .catch((error) => setFatal(error.message))
    void unwrap(api.listDisplays())
      .then(setDisplays)
      .catch(() => {})
    return api.onSnapshot(setSnapshot)
  }, [])
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.key === 'n') {
        event.preventDefault()
        setPage('workspace')
        setPrompt('')
        setSelectedTaskId(undefined)
        setTimeout(() => textarea.current?.focus(), 0)
      }
      if (event.key === 'Escape') {
        setHelp(false)
        setToast(undefined)
      }
    }
    window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
  }, [])
  if (fatal)
    return (
      <main className="startup">
        <Logo />
        <h1>打开 Coloop 桌面工作台</h1>
        <p>{fatal}</p>
      </main>
    )
  if (!snapshot)
    return (
      <main className="startup">
        <Logo />
        <LoaderCircle className="spin" />
        <p>正在准备本地工作区…</p>
      </main>
    )
  const active = snapshot.tasks.find((task) => task.status === 'running')
  const selectedTask = snapshot.tasks.find((task) => task.id === selectedTaskId) || active
  const connected = snapshot.device.status === 'connected'
  const computerBusy =
    !!snapshot.proactive?.active || !!snapshot.desktop?.active || !!snapshot.violoop?.active
  const showComputerStatus =
    snapshot.proactive &&
    (snapshot.proactive.active ||
      snapshot.proactive.suggestion ||
      snapshot.proactive.phase === 'input_unknown' ||
      (snapshot.proactive.taskId &&
        (!selectedTask || selectedTask.id === snapshot.proactive.taskId)))
  const rkUnavailable = !connected ? '请先在「设备管理」连接 RK 设备' : ''
  async function run(text = prompt, source = useScreen ? ('screen' as const) : ('text' as const)) {
    if (submitting || active || computerBusy) return
    if (rkUnavailable) {
      notify(rkUnavailable, true)
      return
    }
    if (!text.trim()) {
      textarea.current?.focus()
      return
    }
    setSubmitting(true)
    try {
      const result = await unwrap(api.dispatchTask({ prompt: text, target, context, source }))
      setSelectedTaskId(result.id)
      setPage('workspace')
      setPrompt('')
    } catch (error) {
      notify((error as Error).message, true)
    } finally {
      setSubmitting(false)
    }
  }
  async function getCapture(fromFile = false) {
    setCapturing(true)
    try {
      const value = await unwrap(
        fromFile ? api.openImage() : api.captureScreen(displayId || undefined),
      )
      if (value) {
        setCapture(value)
        setOcrResult(undefined)
      }
    } catch (error) {
      notify((error as Error).message, true)
    } finally {
      setCapturing(false)
    }
  }
  async function recognize() {
    if (!capture) return
    setRecognizing(true)
    try {
      const result = await unwrap(api.recognize(capture.id))
      setOcrResult(result)
      if (!result.text) notify('没有识别到文字，请尝试更清晰的图片')
    } catch (error) {
      notify((error as Error).message, true)
    } finally {
      setRecognizing(false)
    }
  }
  const newTask = () => {
    setPage('workspace')
    setPrompt('')
    setSelectedTaskId(undefined)
    setTimeout(() => textarea.current?.focus(), 0)
  }
  const openTask = (task: Task) => {
    setSelectedTaskId(task.id)
    setPage('workspace')
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Logo />
        <button className="new-task" onClick={newTask}>
          <Plus size={16} />
          新建任务<span>Ctrl N</span>
        </button>
        <div className="nav-group-label">工作空间</div>
        <nav aria-label="主导航">
          {navigation.map(({ id, name, icon: Icon }) => (
            <button
              key={id}
              className={`nav-item ${page === id ? 'selected' : ''}`}
              aria-current={page === id ? 'page' : undefined}
              title={name}
              onClick={() => setPage(id)}
            >
              <Icon size={18} />
              <span>{name}</span>
              {id === 'history' && snapshot.tasks.length > 0 && (
                <small>{snapshot.tasks.length}</small>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="local-workspace">
            <span className="workspace-avatar">
              <Monitor size={16} />
            </span>
            <div>
              <strong>本地工作区</strong>
              <small>Windows 桌面端</small>
            </div>
            <ShieldCheck size={14} />
          </div>
          <button className="help-button" onClick={() => setHelp(true)}>
            <CircleHelp size={16} />
            使用指南<span>v{snapshot.version}</span>
          </button>
        </div>
      </aside>
      <div className="app-main">
        <header className="topbar">
          <div className="breadcrumb">
            工作区
            <ChevronRight size={13} />
            <strong>{navigation.find((item) => item.id === page)?.name}</strong>
          </div>
          <div className="topbar-right">
            <span>
              <ShieldCheck size={14} />
              本地优先
            </span>
            <i />
            <button onClick={() => setPage('device')}>
              <span className={`tiny-dot ${connected ? 'online' : ''}`} />
              {connected ? snapshot.device.hostname : '设备未连接'}
              <ChevronDown size={12} />
            </button>
          </div>
        </header>
        <div
          className={`content-shell ${['workspace', 'workflows'].includes(page) ? 'with-inspector' : ''}`}
        >
          <main className="main-scroll">
            {page === 'workspace' && (
              <div className="workspace-content">
                <div className="page-heading">
                  <div>
                    <h1>工作台</h1>
                    <p>从屏幕里的信息，开始下一步。</p>
                  </div>
                  <span className="page-context">
                    <ShieldCheck size={14} />
                    本地工作区
                  </span>
                </div>
                <section className="composer" aria-label="任务输入">
                  <div className="composer-head">
                    <label className="composer-title" htmlFor="task-prompt">
                      想让 Coloop 帮你处理什么？
                    </label>
                    <span className="quiet-tag">云端理解 · RK 执行</span>
                  </div>
                  <textarea
                    id="task-prompt"
                    ref={textarea}
                    aria-label="任务内容"
                    placeholder="描述你的任务，也可以附加当前屏幕…"
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    maxLength={24000}
                    onKeyDown={(e) => {
                      if (e.ctrlKey && e.key === 'Enter') {
                        e.preventDefault()
                        void run()
                      }
                    }}
                  />
                  {context && (
                    <div className="context-chip">
                      <ScanText size={13} />
                      <span>已附加识别文本 · {context.length} 字</span>
                      <button aria-label="移除上下文" onClick={() => setContext('')}>
                        <X size={13} />
                      </button>
                    </div>
                  )}
                  <div className="composer-toolbar">
                    <button
                      className={`context-toggle ${useScreen ? 'enabled' : ''}`}
                      aria-pressed={useScreen}
                      onClick={() => setUseScreen(!useScreen)}
                    >
                      <Monitor size={15} />
                      {useScreen ? '将读取当前屏幕' : '附加当前屏幕'}
                      {useScreen ? <Check size={13} /> : <Plus size={13} />}
                    </button>
                    <div className="row">
                      <select aria-label="选择推理位置" value={target} disabled>
                        <option value="cloud">云端理解 · RK 执行</option>
                      </select>
                      <button
                        className="run-button"
                        disabled={
                          !prompt.trim() ||
                          submitting ||
                          !!active ||
                          computerBusy ||
                          !!rkUnavailable
                        }
                        onClick={() => void run()}
                        aria-label="运行任务"
                      >
                        {submitting ? (
                          <LoaderCircle className="spin" size={16} />
                        ) : (
                          <ArrowUpRight size={17} />
                        )}
                        <span>开始运行</span>
                      </button>
                    </div>
                  </div>
                </section>
                <div className="composer-caption">
                  <span>
                    <ShieldCheck size={12} />
                    问题与附加 OCR 交给云端理解，RK 负责执行和后台记忆整理
                  </span>
                  <span>Ctrl + Enter 运行</span>
                </div>
                <div className="info-line" role="status">
                  <Cpu size={15} />
                  <span>
                    {rkUnavailable || '云端直接回答问题；需要操作时，由 RK 执行并核验实际结果。'}
                  </span>
                  {rkUnavailable && (
                    <button className="text-button" onClick={() => setPage('device')}>
                      管理设备
                      <ChevronRight size={14} />
                    </button>
                  )}
                </div>
                {selectedTask && <TaskResult task={selectedTask} notify={notify} />}
                {showComputerStatus && <ComputerAgentStatus snapshot={snapshot} />}
                <div className="section-bar section-space">
                  <h2>快捷操作</h2>
                  <button className="text-button" onClick={() => setPage('workflows')}>
                    全部工作流
                    <ArrowRight size={14} />
                  </button>
                </div>
                <div className="workflow-grid">
                  {workflows.map(({ icon: Icon, title, subtitle, tag, prompt: text, color }) => (
                    <button
                      className="workflow-card"
                      key={title}
                      onClick={() => {
                        if (!text) setPage('screen')
                        else {
                          setPrompt(text)
                          setUseScreen(true)
                          textarea.current?.focus()
                        }
                      }}
                    >
                      <span className={`workflow-icon ${color}`}>
                        <Icon size={22} />
                      </span>
                      <strong>{title}</strong>
                      <p>{subtitle}</p>
                      <div>
                        <span>{tag}</span>
                        <ArrowUpRight size={15} />
                      </div>
                    </button>
                  ))}
                </div>
                <div className="section-bar section-space">
                  <h2>
                    最近任务 <span>{snapshot.tasks.length}</span>
                  </h2>
                  <button className="text-button" onClick={() => setPage('history')}>
                    查看全部
                    <ChevronRight size={14} />
                  </button>
                </div>
                {snapshot.tasks.length === 0 ? (
                  <div className="empty-history">
                    <span className="empty-icon">
                      <Clock3 size={20} />
                    </span>
                    <div>
                      <strong>还没有任务记录</strong>
                      <p>运行后的任务和结果会保存在这里。</p>
                    </div>
                    <button className="text-button empty-create" onClick={newTask}>
                      创建第一个任务
                      <ArrowRight size={14} />
                    </button>
                  </div>
                ) : (
                  <div className="task-list">
                    {snapshot.tasks.slice(0, 4).map((task) => (
                      <button className="task-row" key={task.id} onClick={() => openTask(task)}>
                        <span className="task-icon">
                          {task.source === 'screen' ? (
                            <ScanText size={17} />
                          ) : (
                            <Sparkles size={17} />
                          )}
                        </span>
                        <div>
                          <strong>{task.prompt}</strong>
                          <small>
                            {time(task.createdAt)} ·{' '}
                            {task.target === 'rk'
                              ? 'RK 端侧'
                              : task.target === 'hybrid'
                                ? 'RK + 云端协作'
                                : task.execution === 'desktop'
                                  ? 'TARS 电脑操作'
                                  : '云端理解'}
                          </small>
                        </div>
                        <Status task={task} />
                        <ChevronRight size={14} />
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {page === 'screen' && (
              <div className="page-content">
                <div className="page-title-row">
                  <div>
                    <h1>屏幕理解</h1>
                    <p>在本机提取屏幕与图片中的文字，让信息继续流动。</p>
                  </div>
                  <span className="badge green">
                    <ShieldCheck size={13} />
                    本地 OCR
                  </span>
                </div>
                <div className="screen-toolbar">
                  <div className="row">
                    <select
                      aria-label="选择显示器"
                      value={displayId}
                      onChange={(e) => setDisplayId(e.target.value)}
                    >
                      <option value="">主显示器</option>
                      {displays.map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.name}
                        </option>
                      ))}
                    </select>
                    <button
                      className="button primary"
                      disabled={capturing}
                      onClick={() => void getCapture()}
                    >
                      <Monitor size={16} />
                      {capturing ? '正在获取…' : '截取屏幕'}
                    </button>
                    <button
                      className="button secondary"
                      disabled={capturing}
                      onClick={() => void getCapture(true)}
                    >
                      <FileImage size={16} />
                      导入图片
                    </button>
                  </div>
                  <span className="muted">PNG / JPG / BMP / WebP · 最大 20 MB</span>
                </div>
                <div className="ocr-layout">
                  <section className="panel image-panel">
                    <div className="section-bar">
                      <h3>{capture?.name || '图像预览'}</h3>
                      {capture && (
                        <span className="muted">
                          {capture.width} × {capture.height}
                        </span>
                      )}
                    </div>
                    <div className={`image-preview ${capture ? 'has-image' : ''}`}>
                      {capture ? (
                        <OcrPreview capture={capture} result={ocrResult} />
                      ) : (
                        <div className="empty-state">
                          <span className="large-icon">
                            <ScanLine size={34} />
                          </span>
                          <h3>把屏幕变成可用的信息</h3>
                          <p>
                            截取当前屏幕，或导入一张图片。
                            <br />
                            图像与识别过程都保留在本机。
                          </p>
                          <button
                            className="button secondary"
                            onClick={() => void getCapture(true)}
                          >
                            <Plus size={15} />
                            选择图片
                          </button>
                        </div>
                      )}
                    </div>
                    <div className="image-panel-footer">
                      <span>{capture ? '准备就绪' : '等待图像'}</span>
                      <button
                        className="button primary"
                        disabled={!capture || snapshot.ocrBusy || recognizing}
                        onClick={() => void recognize()}
                      >
                        {recognizing ? (
                          <LoaderCircle size={15} className="spin" />
                        ) : (
                          <ScanText size={15} />
                        )}
                        {recognizing ? '正在识别…' : '识别文字'}
                      </button>
                    </div>
                  </section>
                  <section className="panel text-panel">
                    <div className="section-bar">
                      <h3>识别文本</h3>
                      {ocrResult && (
                        <span className="muted">置信度 {ocrResult.confidence.toFixed(0)}%</span>
                      )}
                    </div>
                    <textarea
                      aria-label="识别文本，可编辑"
                      placeholder="识别后的文字会显示在这里，你也可以直接编辑。"
                      value={ocrResult?.text || ''}
                      onChange={(e) =>
                        setOcrResult({
                          ...(ocrResult || {
                            confidence: 0,
                            durationMs: 0,
                            language: 'chi_sim+eng',
                            items: [],
                            coordinateSpace: 'image_pixels',
                            engine: 'RapidOCR',
                          }),
                          text: e.target.value,
                        })
                      }
                    />
                    <OcrCoordinates result={ocrResult} notify={notify} />
                    <div className="text-panel-footer">
                      <span className="muted">
                        {ocrResult
                          ? `${ocrResult.text.length} 字 · ${(ocrResult.durationMs / 1000).toFixed(1)} 秒`
                          : '支持简体中文与英文'}
                      </span>
                      <div className="row">
                        <button
                          className="icon-button"
                          title="复制识别文本"
                          aria-label="复制识别文本"
                          disabled={!ocrResult?.text}
                          onClick={() =>
                            void unwrap(api.copyText(ocrResult!.text))
                              .then(() => notify('识别文本已复制'))
                              .catch((e) => notify(e.message, true))
                          }
                        >
                          <Copy size={15} />
                        </button>
                        <button
                          className="button secondary"
                          disabled={!ocrResult?.text}
                          onClick={() => {
                            setContext(ocrResult!.text)
                            setUseScreen(false)
                            setPage('workspace')
                            notify('识别文本已附加到新任务')
                          }}
                        >
                          用于任务
                          <ArrowRight size={14} />
                        </button>
                      </div>
                    </div>
                  </section>
                </div>
                <div className="info-line">
                  <CircleHelp size={15} />
                  <span>截图时工作台会短暂隐藏。OCR 是文字识别，不会自动点击或操作其他应用。</span>
                </div>
              </div>
            )}

            {page === 'workflows' && (
              <div className="page-content">
                <div className="page-title-row">
                  <div>
                    <h1>工作流</h1>
                    <p>把经常做的事，变成一个明确的起点。</p>
                  </div>
                  <span className="badge">3 个内置流程</span>
                </div>
                <div className="workflow-catalog">
                  {workflows.map(({ icon: Icon, title, subtitle, tag, prompt: text, color }) => (
                    <section className="panel catalog-card" key={title}>
                      <span className={`workflow-icon ${color}`}>
                        <Icon size={25} />
                      </span>
                      <h2>{title}</h2>
                      <p>{subtitle}</p>
                      <div className="pipeline">
                        <span>获取屏幕</span>
                        <ChevronRight size={12} />
                        <span>本地识别</span>
                        {text && (
                          <>
                            <ChevronRight size={12} />
                            <span>模型理解</span>
                          </>
                        )}
                      </div>
                      <div className="catalog-footer">
                        <span className="muted">{tag}</span>
                        <button
                          className="button secondary"
                          onClick={() => {
                            if (!text) {
                              setPage('screen')
                              return
                            }
                            setPrompt(text)
                            setUseScreen(true)
                            setPage('workspace')
                          }}
                        >
                          使用流程
                          <ArrowRight size={14} />
                        </button>
                      </div>
                    </section>
                  ))}
                </div>
                <section className="workflow-guide">
                  <Workflow size={26} />
                  <div>
                    <h3>从理解，到下一步</h3>
                    <p>
                      当前流程可完成「截屏 → OCR → 模型分析 →
                      保存结果」。跨应用点击与键盘控制需要下位机提供相应协议，后续可通过设备适配层扩展。
                    </p>
                  </div>
                </section>
              </div>
            )}

            {page === 'desktop' && <DesktopPage snapshot={snapshot} />}
            {page === 'coordinator' && <CoordinatorPage snapshot={snapshot} />}
            {page === 'credentials' && <MemoryPage snapshot={snapshot} />}
            {page === 'models' && (
              <ModelsPage
                snapshot={snapshot}
                notify={notify}
                onSaved={(settings) => setSnapshot((s) => s && { ...s, settings })}
              />
            )}
            {page === 'device' && (
              <DevicePage
                snapshot={snapshot}
                notify={notify}
                onSaved={(settings) => setSnapshot((s) => s && { ...s, settings })}
              />
            )}
            {page === 'history' && (
              <div className="page-content">
                <div className="page-title-row">
                  <div>
                    <h1>运行历史</h1>
                    <p>每一次尝试都有记录，随时回到你的思考现场。</p>
                  </div>
                  <div className="row">
                    <button
                      className="button secondary"
                      onClick={() =>
                        void unwrap(api.exportHistory())
                          .then((saved) => saved && notify('历史已导出'))
                          .catch((e) => notify(e.message, true))
                      }
                    >
                      <ArrowDownToLine size={15} />
                      导出记录
                    </button>
                    <button
                      className="icon-button"
                      disabled={!!active || !snapshot.tasks.length}
                      title="清空历史"
                      aria-label="清空历史"
                      onClick={() => setClearConfirm(true)}
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                </div>
                <div className="history-toolbar">
                  <div className="search-field">
                    <Search size={16} />
                    <input
                      aria-label="搜索任务"
                      placeholder="搜索任务内容或结果…"
                      value={historyQuery}
                      onChange={(e) => setHistoryQuery(e.target.value)}
                    />
                  </div>
                  <select
                    aria-label="筛选运行状态"
                    value={historyFilter}
                    onChange={(e) => setHistoryFilter(e.target.value)}
                  >
                    <option value="all">全部状态</option>
                    <option value="completed">已完成</option>
                    <option value="running">运行中</option>
                    <option value="failed">失败</option>
                    <option value="cancelled">已停止</option>
                  </select>
                </div>
                <div className="panel history-list">
                  {snapshot.tasks
                    .filter(
                      (t) =>
                        (historyFilter === 'all' || t.status === historyFilter) &&
                        `${t.prompt}${t.answer}`.toLowerCase().includes(historyQuery.toLowerCase()),
                    )
                    .map((task) => (
                      <button className="task-row" key={task.id} onClick={() => openTask(task)}>
                        <span className="task-icon">
                          <Sparkles size={18} />
                        </span>
                        <div>
                          <strong>{task.prompt}</strong>
                          <small>
                            {time(task.createdAt)} · {task.model}
                          </small>
                        </div>
                        <Status task={task} />
                        <ChevronRight size={15} />
                      </button>
                    ))}
                  {!snapshot.tasks.some(
                    (t) =>
                      (historyFilter === 'all' || t.status === historyFilter) &&
                      `${t.prompt}${t.answer}`.toLowerCase().includes(historyQuery.toLowerCase()),
                  ) && (
                    <div className="empty-state">
                      <History size={32} />
                      <h3>{snapshot.tasks.length ? '没有匹配的任务' : '你的任务足迹会留在这里'}</h3>
                      <p>
                        {snapshot.tasks.length
                          ? '试试其他关键词或筛选条件。'
                          : '从工作台发起第一个任务。'}
                      </p>
                      <button className="button secondary" onClick={newTask}>
                        新建任务
                        <Plus size={15} />
                      </button>
                    </div>
                  )}
                </div>
                <p className="history-note">
                  <ShieldCheck size={13} />
                  历史仅保存在本机，最多保留 200 条任务。导出文件包含任务文本与回答。
                </p>
              </div>
            )}
          </main>
          {['workspace', 'workflows'].includes(page) && (
            <DeviceRail
              device={snapshot.device}
              hasKey={snapshot.settings.provider.hasKey}
              onDevice={() => setPage('device')}
              onModels={() => setPage('models')}
            />
          )}
        </div>
        <footer className="statusbar">
          <span>
            <i className={`tiny-dot ${active || computerBusy ? 'busy' : 'online'}`} />
            {active?.stage ||
              (computerBusy
                ? proactivePhaseLabels[snapshot.proactive?.phase ?? ''] || '电脑操作进行中'
                : snapshot.proactive?.phase === 'input_unknown'
                  ? proactivePhaseLabels.input_unknown
                  : '工作区已就绪')}
          </span>
          <span>
            {snapshot.ocrBusy ? 'OCR 正在运行' : 'RapidOCR 已接入'}
            <i />
            {snapshot.settings.provider.model}
            <i />
            Coloop {snapshot.version}
          </span>
        </footer>
      </div>
      {toast && (
        <div
          role={toast.error ? 'alert' : 'status'}
          className={`toast ${toast.error ? 'error' : ''}`}
        >
          {toast.error ? <CircleHelp size={17} /> : <CheckCircle2 size={17} />}
          <span>{toast.message}</span>
          <button aria-label="关闭消息" onClick={() => setToast(undefined)}>
            <X size={15} />
          </button>
        </div>
      )}
      {help && (
        <div className="modal-backdrop" onClick={() => setHelp(false)}>
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="help-title"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="modal-close icon-button"
              aria-label="关闭指南"
              onClick={() => setHelp(false)}
            >
              <X size={18} />
            </button>
            <Logo small />
            <h2 id="help-title">连接你的第一个工作流</h2>
            <ol className="help-steps">
              <li>
                <strong>配置模型</strong>
                <p>
                  在「模型连接」填写服务地址、模型名称与 API Key，保存并测试连接。也可以使用 RK
                  端侧模型。
                </p>
              </li>
              <li>
                <strong>连接 RK 设备</strong>
                <p>使用 USB 数据线连接 OTG 接口，在「设备管理」导入 RK 配置，输入设备 SSH 密码。</p>
              </li>
              <li>
                <strong>识别与分析</strong>
                <p>
                  在「屏幕理解」截屏并识别文字，再点击「用于任务」，或直接在工作台附加屏幕并运行。
                </p>
              </li>
            </ol>
            <div className="info-line">
              <ShieldCheck size={16} />
              <span>
                API Key 使用 Windows 加密存储；设备密码只用于当前连接。「电脑操作」已接入 RK
                HID，同页动作一次规划、统一验证。首版限单屏、单窗口和英文数字输入。
              </span>
            </div>
            <button
              className="button primary full"
              onClick={() => {
                setHelp(false)
                setPage('models')
              }}
            >
              开始配置
              <ArrowRight size={15} />
            </button>
          </section>
        </div>
      )}
      {clearConfirm && (
        <div className="modal-backdrop">
          <section
            className="modal compact"
            role="dialog"
            aria-modal="true"
            aria-labelledby="clear-title"
          >
            <h2 id="clear-title">清空所有运行历史？</h2>
            <p>这会删除本机保存的 {snapshot.tasks.length} 条任务记录。可先导出备份。</p>
            <div className="row end">
              <button className="button secondary" onClick={() => setClearConfirm(false)}>
                保留历史
              </button>
              <button
                className="button destructive"
                onClick={() =>
                  void unwrap(api.clearHistory())
                    .then(() => {
                      setClearConfirm(false)
                      setSelectedTaskId(undefined)
                      notify('运行历史已清空')
                    })
                    .catch((e) => notify(e.message, true))
                }
              >
                清空历史
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  )
}
