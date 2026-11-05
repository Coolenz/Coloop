import { useRef, useState } from 'react'
import {
  CheckCircle2,
  Cpu,
  LoaderCircle,
  MousePointer2,
  Play,
  RefreshCw,
  Square,
} from 'lucide-react'
import type { AppSnapshot } from '../../shared/contracts'
import type { DesktopPhase } from '../../shared/desktop'
import { api, unwrap } from './api'
import './desktop.css'
import { ComputerAgentStatus } from './ComputerAgentStatus'
import { proactivePhaseLabels } from '../../shared/proactive'

const phases: Record<DesktopPhase, string> = {
  idle: '等待新任务',
  preparing: '正在准备，请切到目标窗口',
  observing: '正在观察目标窗口',
  planning: '正在规划下一步',
  validating: '正在核对目标与焦点',
  executing: '正在连续执行本页动作',
  verifying: '正在统一检查执行结果',
  stopping: '正在等待 RK 停止确认',
  completed: '已在屏幕确认预期结果',
  cancelled: '已停止操作',
  failed: '任务未完成，已停止操作',
  unconfirmed: '设备停止状态未确认',
}

export function DesktopPage({ snapshot }: { snapshot: AppSnapshot }) {
  const [goal, setGoal] = useState('')
  const [scheduledAt, setScheduledAt] = useState('')
  const [target, setTarget] = useState<'hybrid' | 'rk' | 'cloud'>('hybrid')
  const [identifierFields, setIdentifierFields] = useState('')
  const [numberFields, setNumberFields] = useState('')
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const [authorized, setAuthorized] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [voiceBusy, setVoiceBusy] = useState(false)
  const [voiceInfo, setVoiceInfo] = useState('')
  const voiceGeneration = useRef(0)
  const busy =
    !!snapshot.proactive?.active ||
    !!snapshot.desktop?.active ||
    !!snapshot.violoop?.active ||
    snapshot.tasks.some((task) => task.status === 'running')
  const connected = snapshot.device.status === 'connected'
  const providerReady =
    target === 'cloud'
      ? snapshot.settings.provider.hasKey && snapshot.settings.provider.protocol === 'openai'
      : snapshot.device.qwenReady && snapshot.device.modelPrivacyReady
  const unknown = snapshot.proactive?.phase === 'input_unknown'
  async function importVoice(file: File) {
    if (voiceBusy || busy) return
    const generation = ++voiceGeneration.current
    setVoiceBusy(true)
    setError('')
    setVoiceInfo('')
    try {
      if (file.size > 5 * 1024 * 1024) throw new Error('语音文件最大为5 MB。')
      const audio = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result).split(',')[1])
        reader.onerror = () => reject(new Error('语音文件读取失败。'))
        reader.readAsDataURL(file)
      })
      if (generation !== voiceGeneration.current) return
      const transcript = await unwrap(api.transcribeVoice(audio))
      if (generation !== voiceGeneration.current) return
      setGoal(transcript.text)
      setVoiceInfo(
        `本机离线识别，置信度 ${Math.round(transcript.confidence * 100)}%。${transcript.rejected_segments ? `有 ${transcript.rejected_segments} 段未识别。` : ''}请核对指令文字。`,
      )
    } catch (failure) {
      if (generation === voiceGeneration.current) setError((failure as Error).message)
    } finally {
      if (generation === voiceGeneration.current) setVoiceBusy(false)
    }
  }
  async function start(event: React.FormEvent) {
    event.preventDefault()
    if (submitting || busy || voiceBusy) return
    setSubmitting(true)
    setError('')
    try {
      const request = {
        prompt: goal,
        target,
        context: '',
        source: 'text' as const,
        intent: 'execute' as const,
        cloudFields:
          target === 'hybrid'
            ? [
                ...identifierFields
                  .split(/[,，]/)
                  .map((name) => name.trim())
                  .filter(Boolean)
                  .map((name) => ({ name, type: 'identifier' as const })),
                ...numberFields
                  .split(/[,，]/)
                  .map((name) => name.trim())
                  .filter(Boolean)
                  .map((name) => ({ name, type: 'number' as const })),
              ]
            : undefined,
      }
      if (scheduledAt)
        await unwrap(
          api.scheduleTask({ runAt: new Date(scheduledAt).toISOString(), timezone, request }),
        )
      else await unwrap(api.dispatchTask(request))
      setGoal('')
      setScheduledAt('')
      setAuthorized(false)
    } catch (failure) {
      setError((failure as Error).message)
    } finally {
      setSubmitting(false)
    }
  }
  return (
    <div className="page-content desktop-page">
      <div className="page-title-row">
        <div>
          <h1>电脑操作</h1>
          <p>模型规划任务，RK 执行键鼠操作，独立回读实际结果。</p>
        </div>
        <span className="badge">
          <MousePointer2 size={14} />
          {snapshot.proactive?.runtime === 'harness' ? 'DeepSeek Harness' : 'Agent TARS'}
        </span>
      </div>
      <form className="desktop-form" onSubmit={(event) => void start(event)}>
        <fieldset disabled={submitting || busy || voiceBusy}>
          <div className="desktop-field">
            <label htmlFor="voice-command">导入 WAV 语音指令</label>
            <input
              id="voice-command"
              type="file"
              accept=".wav,audio/wav"
              onChange={(event) => {
                const file = event.target.files?.[0]
                event.target.value = ''
                if (file) void importVoice(file)
              }}
            />
            <p>
              中文离线识别，支持16 kHz、单声道、16位PCM WAV，最长120秒。核对识别文字后开始任务。
            </p>
            {voiceInfo && <p role="status">{voiceInfo}</p>}
          </div>
          <div className="desktop-field">
            <label htmlFor="computer-goal">让电脑完成什么</label>
            <textarea
              id="computer-goal"
              value={goal}
              onChange={(event) => setGoal(event.target.value)}
              placeholder="例如：保留当前文档的标题，在末尾补充三条简短中文大纲。"
              rows={4}
              maxLength={24000}
              required
            />
            <p>先打开目标应用，再回到 Coloop 提交。开始后主窗口收起，由小窗显示进度。</p>
          </div>
          <div className="desktop-field">
            <label htmlFor="computer-model-route">任务模型</label>
            <select
              id="computer-model-route"
              value={target}
              onChange={(event) => setTarget(event.target.value as typeof target)}
            >
              <option value="hybrid">本地执行与最小云端分析</option>
              <option value="rk">本地执行</option>
              <option value="cloud">云端任务规划</option>
            </select>
            {target === 'cloud' ? (
              <p>云端任务规划使用本次目标及工具读回的原文上下文。</p>
            ) : (
              <p>本地模型处理原始资料。协作分析采用固定问题和明确批准的字段。</p>
            )}
          </div>
          {target === 'hybrid' && (
            <div className="desktop-field">
              <label htmlFor="cloud-identifier-fields">
                允许云端分析的编号字段（逗号分隔，可留空）
              </label>
              <input
                id="cloud-identifier-fields"
                value={identifierFields}
                onChange={(event) => setIdentifierFields(event.target.value)}
                placeholder="例如 订单号"
              />
              <label htmlFor="cloud-number-fields">
                允许云端分析的数值字段（逗号分隔，可留空）
              </label>
              <input
                id="cloud-number-fields"
                value={numberFields}
                onChange={(event) => setNumberFields(event.target.value)}
                placeholder="例如 金额"
              />
              <p>宿主从实际来源提取所选字段。留空时，云端仅接收通用步骤问题。</p>
            </div>
          )}
          <div className="desktop-field">
            <label htmlFor="computer-scheduled-at">定时执行（{timezone}，留空立即执行）</label>
            <input
              id="computer-scheduled-at"
              type="datetime-local"
              value={scheduledAt}
              onChange={(event) => setScheduledAt(event.target.value)}
            />
            <p>到时读取最新来源。设备暂不可用时保留排队，执行编号提前登记。</p>
          </div>
          <div className="desktop-field">
            <button
              type="button"
              className="button"
              onClick={() => {
                void unwrap(api.chooseTaskWorkspace()).catch((failure) =>
                  setError((failure as Error).message),
                )
              }}
            >
              选择任务文件目录
            </button>
            <p>
              {snapshot.settings.taskWorkspace ??
                '选择目录后，允许任务读取源文件并创建 WPS 工作簿。'}
            </p>
          </div>
          <label className="desktop-authorize">
            <input
              type="checkbox"
              checked={authorized}
              onChange={(event) => setAuthorized(event.target.checked)}
            />
            允许本次任务在目标应用发送键鼠输入
          </label>
        </fieldset>
        <div className="desktop-actions">
          {voiceBusy && (
            <button
              type="button"
              className="button"
              onClick={() => {
                const generation = ++voiceGeneration.current
                setVoiceInfo('正在取消语音识别。')
                void unwrap(api.cancelVoiceTranscription())
                  .then(() => setVoiceInfo('语音识别已取消。'))
                  .catch((failure) => setError((failure as Error).message))
                  .finally(() => {
                    if (generation === voiceGeneration.current) setVoiceBusy(false)
                  })
              }}
            >
              <LoaderCircle size={15} className="spin" />
              取消语音识别
            </button>
          )}
          <p>
            {!connected
              ? '请先在「设备管理」连接 RK。'
              : !providerReady
                ? '请在「模型连接」配置 OpenAI 兼容模型与访问凭据。'
                : unknown
                  ? '请先检查上次输入结果，并恢复控制。'
                  : '单步执行后读取新观察，结束前核验结果。记忆由 RK 在后台整理。'}
          </p>
          <button
            type="submit"
            className="button primary"
            disabled={
              submitting ||
              voiceBusy ||
              busy ||
              !connected ||
              !providerReady ||
              unknown ||
              !authorized ||
              !goal.trim()
            }
          >
            {submitting ? <LoaderCircle size={15} className="spin" /> : <Play size={15} />}
            {scheduledAt ? '登记定时任务' : '开始电脑操作'}
          </button>
        </div>
        {error && (
          <p className="desktop-error" role="alert">
            {error}
          </p>
        )}
      </form>
      {!!snapshot.proactive?.recoverable?.length && (
        <section className="desktop-form" aria-label="可恢复任务">
          <h2>可恢复任务</h2>
          <p>沿用原目标和文件目录，重新检查实际结果后继续。结果不明的提交需要先核对。</p>
          {snapshot.proactive.recoverable.map((entry) => (
            <div key={entry.taskId} className="desktop-field">
              <p>{entry.goal}</p>
              <small>
                {proactivePhaseLabels[entry.phase] ?? entry.phase} ·{' '}
                {new Date(entry.updatedAt).toLocaleString('zh-CN')}
              </small>
              {entry.workspace && <p>{entry.workspace}</p>}
              <button
                type="button"
                className="button"
                disabled={busy || submitting || voiceBusy || !connected || unknown}
                onClick={() => {
                  setSubmitting(true)
                  setError('')
                  void unwrap(api.resumeProactiveTask(entry.taskId))
                    .catch((failure) => setError((failure as Error).message))
                    .finally(() => setSubmitting(false))
                }}
              >
                恢复任务
              </button>
            </div>
          ))}
        </section>
      )}
      {!!snapshot.schedules?.entries.length && (
        <section className="desktop-form">
          <h2>定时任务</h2>
          {snapshot.schedules.entries.map((entry) => (
            <div key={entry.id}>
              <p>
                {new Date(entry.runAt).toLocaleString('zh-CN', { timeZone: entry.timezone })}{' '}
                {entry.timezone} · {entry.status}
              </p>
              <p>{entry.request.prompt}</p>
              <small>
                执行编号 {entry.taskId}
                {entry.error ? ` · ${entry.error}` : ''}
              </small>
              {['pending', 'waiting'].includes(entry.status) && (
                <button
                  type="button"
                  className="button"
                  onClick={() =>
                    void unwrap(api.cancelScheduledTask(entry.id)).catch((failure) =>
                      setError((failure as Error).message),
                    )
                  }
                >
                  取消定时任务
                </button>
              )}
            </div>
          ))}
        </section>
      )}
      {snapshot.schedules?.error && <p role="alert">{snapshot.schedules.error}</p>}
      <ComputerAgentStatus snapshot={snapshot} />
      <details className="desktop-legacy" open={snapshot.desktop?.active || undefined}>
        <summary>其他操作模式</summary>
        <LegacyDesktopPage snapshot={snapshot} />
      </details>
    </div>
  )
}

function LegacyDesktopPage({ snapshot }: { snapshot: AppSnapshot }) {
  const [windows, setWindows] = useState<string[]>([])
  const [windowTitle, setWindowTitle] = useState('')
  const [goal, setGoal] = useState('')
  const [expectedText, setExpectedText] = useState('')
  const [planner, setPlanner] = useState<'rk' | 'hybrid' | 'cloud-hid'>('rk')
  const [browserTask, setBrowserTask] = useState<'home' | 'video-triple'>('home')
  const [authorized, setAuthorized] = useState(false)
  const [busy, setBusy] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const state = snapshot.desktop
  const browserMode = planner === 'cloud-hid'
  const browserGoal =
    browserTask === 'home' ? '打开 Bilibili' : '打开bilibili，点击主页的一个任意视频，然后三连点赞'
  const active = !!state?.active
  const otherActive =
    !!snapshot.proactive?.active || snapshot.tasks.some((task) => task.status === 'running')
  const connected =
    snapshot.device.status === 'connected' &&
    snapshot.device.qwenReady &&
    snapshot.device.modelPrivacyReady
  const unavailable = !connected ? '请先在设备管理连接 RK，并确认模型与隐私服务就绪。' : ''
  async function refresh() {
    setRefreshing(true)
    setError('')
    try {
      setWindows(await unwrap(api.listDesktopWindows()))
    } catch (failure) {
      setError((failure as Error).message)
    } finally {
      setRefreshing(false)
    }
  }
  async function start(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      await unwrap(
        api.startDesktopTask({
          goal: browserMode ? browserGoal : goal,
          windowTitle: browserMode ? 'Chrome → Bilibili' : windowTitle,
          expectedText: browserMode ? 'bilibili.com' : expectedText,
          planner,
          authorizeInput: true,
          maxSteps: browserMode ? (browserTask === 'home' ? 4 : 16) : 8,
          ...(browserMode ? { browserTask } : {}),
        }),
      )
    } catch (failure) {
      setError((failure as Error).message)
    } finally {
      setBusy(false)
    }
  }
  async function stop() {
    setBusy(true)
    try {
      await unwrap(api.stopDesktopTask())
    } catch (failure) {
      setError((failure as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="page-content desktop-page">
      <div className="page-title-row">
        <div>
          <h2>其他操作模式</h2>
          <p>描述目标，让 RK 操作窗口，并回读实际结果。</p>
        </div>
        <span className="badge">
          <Cpu size={14} />
          RK USB HID
        </span>
      </div>
      <form onSubmit={(event) => void start(event)} className="desktop-form">
        <fieldset disabled={active || busy || otherActive}>
          <div className="desktop-field">
            <div className="desktop-label-row">
              <label htmlFor="desktop-window">操作哪个窗口</label>
              <button
                type="button"
                className="button secondary small"
                onClick={() => void refresh()}
                disabled={refreshing}
              >
                <RefreshCw size={14} className={refreshing ? 'spin' : ''} />
                {refreshing ? '正在读取' : '刷新窗口'}
              </button>
            </div>
            <input
              id="desktop-window"
              list="desktop-windows"
              value={browserMode ? 'Chrome → Bilibili' : windowTitle}
              readOnly={browserMode}
              onChange={(event) => setWindowTitle(event.target.value)}
              placeholder="选择或输入完整窗口标题"
              required
              maxLength={250}
              autoComplete="off"
            />
            <datalist id="desktop-windows">
              {windows.map((title) => (
                <option key={title} value={title} />
              ))}
            </datalist>
            <p>
              {browserMode
                ? '请先打开 Chrome，并保留同一窗口内的 Bilibili 首页标签。RK 会用鼠标切回浏览器。'
                : '开始后请切到这个窗口，并保持它在前台。标题需唯一。'}
            </p>
          </div>
          <div className="desktop-field">
            <label htmlFor="desktop-goal">让电脑完成什么</label>
            {browserMode && (
              <select
                aria-label="Bilibili任务"
                value={browserTask}
                onChange={(event) => setBrowserTask(event.target.value as 'home' | 'video-triple')}
              >
                <option value="home">打开 Bilibili 首页</option>
                <option value="video-triple">主页选一个视频，点赞、投一枚币、收藏</option>
              </select>
            )}
            <textarea
              id="desktop-goal"
              value={browserMode ? browserGoal : goal}
              readOnly={browserMode}
              onChange={(event) => setGoal(event.target.value)}
              placeholder="例如：读取窗口中的 Code，把它输入 Input，再点击 Apply。"
              required
              maxLength={2000}
              rows={3}
            />
          </div>
          <div className="desktop-fields-row">
            <div className="desktop-field">
              <label htmlFor="desktop-result">完成时应出现的文字</label>
              <input
                id="desktop-result"
                value={browserMode ? 'bilibili.com' : expectedText}
                readOnly={browserMode}
                onChange={(event) => setExpectedText(event.target.value)}
                placeholder="例如：Applied:"
                required
                maxLength={128}
              />
              <p>
                {browserMode
                  ? '首页会核对网址与页面；三连另核对点赞、投币和收藏的实际状态。'
                  : '在窗口里读到这段文字，才会确认完成。'}
              </p>
            </div>
            <div className="desktop-field">
              <label htmlFor="desktop-planner">如何规划动作</label>
              <select
                id="desktop-planner"
                value={planner}
                onChange={(event) =>
                  setPlanner(event.target.value as 'rk' | 'hybrid' | 'cloud-hid')
                }
              >
                <option value="rk">RK 本地模型</option>
                <option value="hybrid">RK + 云端隐私协作</option>
                <option value="cloud-hid">RK Agent · 云端规划 / USB 鼠标</option>
              </select>
              <p>执行与结果核查始终由 RK 调度。</p>
            </div>
          </div>
          <label className="desktop-authorize">
            <input
              type="checkbox"
              checked={authorized}
              onChange={(event) => setAuthorized(event.target.checked)}
            />
            允许本次任务在指定窗口发送键鼠输入
          </label>
        </fieldset>
        <div className="desktop-actions">
          <p>
            {unavailable ||
              (browserMode
                ? '仅支持以上 Bilibili 任务。浏览器操作由 RK USB 执行；普通页面内容可发至云端。'
                : '同页动作一次规划并连续执行；每组最多 8 个动作，完成后统一验证。')}
          </p>
          {active ? (
            <button
              type="button"
              className="button primary"
              onClick={() => void stop()}
              disabled={busy || state?.phase === 'stopping' || state?.phase === 'unconfirmed'}
            >
              <Square size={15} />
              {state?.phase === 'stopping' ? '正在停止' : '停止操作'}
            </button>
          ) : (
            <button
              className="button primary"
              type="submit"
              disabled={
                busy ||
                otherActive ||
                !connected ||
                !authorized ||
                (!browserMode && (!goal.trim() || !windowTitle.trim() || !expectedText.trim()))
              }
            >
              {busy ? <LoaderCircle size={15} className="spin" /> : <Play size={15} />}开始操作
            </button>
          )}
        </div>
      </form>
      {(error || state?.error) && (
        <p className="desktop-error" role="alert">
          {error || state?.error}
        </p>
      )}
      <section className="desktop-progress" aria-label="操作进度">
        <div className="desktop-status" role="status" aria-live="polite">
          {state?.phase === 'completed' ? (
            <CheckCircle2 size={22} />
          ) : active ? (
            <LoaderCircle size={22} className="spin" />
          ) : (
            <MousePointer2 size={22} />
          )}
          <div>
            <h2>{phases[state?.phase ?? 'idle']}</h2>
            <p>
              {state?.windowTitle || '选择窗口并填写任务后开始。'}
              {state?.taskId && ` · 执行轮次 ${state.steps} / ${state.maxSteps}`}
              {state?.agentLocation === 'rk' && ' · Agent 运行于 RK'}
            </p>
          </div>
        </div>
        {!!state?.events.length && (
          <ol className="desktop-events">
            {state.events.slice(-8).map((event, index) => (
              <li key={`${event.at}-${index}`}>
                <span>{phases[event.phase]}</span>
                <time dateTime={event.at}>{new Date(event.at).toLocaleTimeString('zh-CN')}</time>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  )
}
