import { useEffect, useRef, useState } from 'react'
import {
  Check,
  ChevronDown,
  Circle,
  CircleHelp,
  LoaderCircle,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Send,
  Square,
  ThumbsDown,
  ThumbsUp,
  Unplug,
} from 'lucide-react'
import type { AppSnapshot } from '../../shared/contracts'
import type {
  AutoAgentCapability,
  AutoAgentDecision,
  AutoAgentFeedbackInput,
  AutoAgentTask,
  AutoAgentSession,
} from '../../shared/auto-agent-work'
import { api, unwrap } from './api'
import { AutoAgentTimeline } from './AutoAgentTimeline'
import './auto-agent-work.css'

export const taskLabels: Record<AutoAgentTask['state'], string> = {
  watching: '正在跟进',
  deciding: '正在分析下一步',
  waiting_receipt: '等待执行回执',
  paused: '已暂停',
  needs_user: '需要你决定',
  completed: '已完成',
  unbound: '已解除绑定',
}
export function sessionName(session: AutoAgentSession) {
  const suffix = session.source === 'chatgpt-desktop' ? 'codex' : 'opencode'
  const title =
    session.title && session.title !== 'ChatGPT / Codex 原生会话（桌面未验收）'
      ? session.title
      : `未命名会话 ${session.sessionId.slice(-8)}`
  return `${title}.${suffix}`
}
const sessionLabels: Record<string, string> = {
  idle: '空闲',
  running: '运行中',
  awaiting_input: '等待输入',
  error: '出现错误',
  closed: '已关闭',
  unknown: '状态待核对',
}
const capabilityLabels: Record<AutoAgentCapability, string> = {
  unknown: '待探测',
  unsupported: '不可用',
  available: '可用，待验收',
  verified: '已验证',
}
const decisionLabels: Record<AutoAgentDecision['action'], string> = {
  wait: '继续等待',
  reply: '回答问题',
  continue: '推进下一步',
  verify: '核验结果',
  ask_user: '请你决定',
  complete: '确认完成',
}
const actionLabels: Record<string, string> = {
  prepared: '准备发送',
  dispatching: '正在发送',
  accepted: '已接受，待确认',
  confirmed: '已确认送达',
  unknown: '结果待核对',
  failed: '发送失败',
  cancelled: '已撤销',
}
const memoryLabels = {
  explicit: '明确偏好',
  case: '相似任务',
  inferred: '习惯倾向',
  feedback: '个人评价',
}
const dateTime = (value: string) => {
  const date = new Date(value)
  return Number.isNaN(date.valueOf())
    ? '时间未知'
    : date.toLocaleString('zh-CN', {
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
}

type Perform = (action: () => Promise<unknown>, success?: string) => Promise<boolean>

export function AutoAgentWorkPage({
  snapshot,
  initialTaskId = '',
  configure = false,
  onCreated,
}: {
  snapshot: AppSnapshot
  initialTaskId?: string
  configure?: boolean
  onCreated?: (taskId: string) => void
}) {
  const state = snapshot.autoAgentWork
  const sessions = state?.sessions ?? []
  const tasks = state?.tasks ?? []
  const [sessionId, setSessionId] = useState('')
  const [taskId, setTaskId] = useState(initialTaskId)
  const [creating, setCreating] = useState(configure)
  const [goal, setGoal] = useState('')
  const [acceptance, setAcceptance] = useState('')
  const [authorization, setAuthorization] = useState(
    '在当前任务范围内推进、核验和回答业务选择；不扩大授权。',
  )
  const [workspace, setWorkspace] = useState(
    tasks[0]?.session.workspace ??
      state?.hooks.workspace ??
      snapshot.settings.taskWorkspace ??
      snapshot.settings.ocrWorkspace,
  )
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  useEffect(() => {
    if (!sessionId && sessions.length) setSessionId(sessions[0].id)
  }, [sessionId, sessions])
  const selectedSession = sessions.find((session) => session.id === sessionId)
  const current = tasks.find((task) => task.id === taskId) ?? tasks[0]
  useEffect(() => {
    const root = current?.session.workspace
    if (!root) return
    setWorkspace(root)
    void unwrap(api.refreshAutoAgentWork({ workspace: root })).catch(() => {})
  }, [current?.id, current?.session.workspace])
  const normalizeWorkspace = (path: string) =>
    path.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
  const checkedWorkspace =
    state?.hooks.workspace ?? state?.hooks.configPath?.replace(/[\\/]\.codex[\\/]hooks\.json$/i, '')
  const hooksMatch =
    !!checkedWorkspace &&
    normalizeWorkspace(checkedWorkspace) === normalizeWorkspace(workspace.trim())
  const selectedIsBound = tasks.some(
    (task) => task.session.id === sessionId && !['completed', 'unbound'].includes(task.state),
  )
  const canCreate =
    !!state &&
    !!selectedSession &&
    selectedSession.state !== 'closed' &&
    !selectedIsBound &&
    !state.journalError
  async function perform(action: () => Promise<unknown>, success?: string) {
    if (busyRef.current) return false
    busyRef.current = true
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await action()
      if (success) setNotice(success)
      return true
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '操作未完成，请重试。')
      return false
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }
  return (
    <div className="page-content auto-agent-work-page">
      <div className="page-title-row">
        <div>
          {configure ? <h2>Auto Agent Work</h2> : <h1>Auto Agent Work</h1>}
          <p>记住你的习惯，在任务需要选择或继续时帮你推进。</p>
        </div>
        <button
          className="button secondary"
          disabled={busy || !state}
          onClick={() =>
            void perform(() => unwrap(api.refreshAutoAgentWork({ workspace: workspace.trim() })))
          }
        >
          <RefreshCw size={15} aria-hidden="true" />
          刷新会话
        </button>
      </div>
      {!state && (
        <p className="aaw-message" role="status">
          Auto Agent Work 服务尚未就绪。请稍后刷新会话。
        </p>
      )}
      {state?.journalError && (
        <p className="aaw-message" role="alert">
          任务记录暂不可用，已停止推进：{state.journalError}
        </p>
      )}
      {error && (
        <p className="aaw-message" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="aaw-message" role="status">
          {notice}
        </p>
      )}

      {!!tasks.length && !configure && (
        <div className="aaw-task-picker">
          <label htmlFor="aaw-task">跟进任务</label>
          <select
            id="aaw-task"
            value={current?.id ?? ''}
            disabled={busy}
            onChange={(event) => {
              setTaskId(event.target.value)
              setCreating(false)
            }}
          >
            {tasks.map((task) => (
              <option key={task.id} value={task.id}>
                {sessionName(task.session)} · {taskLabels[task.state]}
              </option>
            ))}
          </select>
          <button
            className="button secondary"
            disabled={busy}
            onClick={() => setCreating(!creating)}
          >
            <Plus size={15} aria-hidden="true" />
            {creating ? '收起新任务' : '跟进新任务'}
          </button>
        </div>
      )}

      {(creating || !tasks.length) && (
        <form
          className="aaw-create"
          aria-label="开始跟进任务"
          onSubmit={(event) => {
            event.preventDefault()
            if (!canCreate || !goal.trim() || !acceptance.trim()) return
            void perform(async () => {
              const id = await unwrap(
                api.createAutoAgentWork({
                  sessionId,
                  goal: goal.trim(),
                  acceptance: acceptance
                    .split('\n')
                    .map((line) => line.trim())
                    .filter(Boolean),
                  authorization,
                }),
              )
              setTaskId(id)
              setCreating(false)
              setGoal('')
              setAcceptance('')
              onCreated?.(id)
            }, '任务已绑定，将在需要推进时介入。')
          }}
        >
          <div className="aaw-section-heading">
            <h2>选择要跟进的任务</h2>
            <p className="muted">选择已接入的会话，并写清楚做到什么程度。</p>
          </div>
          <label htmlFor="aaw-session">电脑上的 Agent 会话</label>
          <select
            id="aaw-session"
            value={sessionId}
            disabled={busy || !sessions.length}
            onChange={(event) => setSessionId(event.target.value)}
          >
            <option value="" disabled>
              选择会话
            </option>
            {sessionId && !selectedSession && (
              <option value={sessionId} disabled>
                原会话已不可用，请重新选择
              </option>
            )}
            {sessions.map((session) => (
              <option key={session.id} value={session.id} disabled={session.state === 'closed'}>
                {sessionName(session)} · {sessionLabels[session.state]}
              </option>
            ))}
          </select>
          {!sessions.length && (
            <p className="aaw-empty">
              还没有发现会话。请在下方接入 Hook，再让 Agent 产生新的任务事件。
            </p>
          )}
          {selectedSession && (
            <details className="aaw-details">
              <summary>会话详情</summary>
              <dl className="aaw-capabilities">
                <div>
                  <dt>会话标识</dt>
                  <dd>{selectedSession.sessionId}</dd>
                </div>
                <div>
                  <dt>工作目录</dt>
                  <dd>{selectedSession.workspace || '未提供'}</dd>
                </div>
                <div>
                  <dt>任务事件</dt>
                  <dd>{capabilityLabels[selectedSession.capabilities.events]}</dd>
                </div>
                <div>
                  <dt>原生续推</dt>
                  <dd>{capabilityLabels[selectedSession.capabilities.nativeContinue]}</dd>
                </div>
                <div>
                  <dt>回答问题</dt>
                  <dd>{capabilityLabels[selectedSession.capabilities.reply]}</dd>
                </div>
                <div>
                  <dt>界面回写</dt>
                  <dd>{capabilityLabels[selectedSession.capabilities.desktopWrite]}</dd>
                </div>
              </dl>
            </details>
          )}
          {selectedIsBound && (
            <p className="muted">这个会话已有跟进任务，请在上方选择该任务补充要求。</p>
          )}
          <label htmlFor="aaw-goal">任务目标</label>
          <textarea
            id="aaw-goal"
            rows={3}
            maxLength={24000}
            required
            value={goal}
            disabled={busy}
            onChange={(event) => setGoal(event.target.value)}
            placeholder="例如：完成导出功能修复，通过测试并更新本机安装版。"
          />
          <label htmlFor="aaw-acceptance">
            完成条件 <span className="muted">每行一项</span>
          </label>
          <textarea
            id="aaw-acceptance"
            rows={3}
            maxLength={24000}
            required
            value={acceptance}
            disabled={busy}
            onChange={(event) => setAcceptance(event.target.value)}
            placeholder={'相关测试通过\n实际安装版验收通过\n报告结果和仍存在的问题'}
          />
          <details className="aaw-details">
            <summary>
              任务范围
              <ChevronDown size={14} aria-hidden="true" />
            </summary>
            <label htmlFor="aaw-authorization">允许代为处理的事项</label>
            <textarea
              id="aaw-authorization"
              rows={3}
              maxLength={8000}
              value={authorization}
              disabled={busy}
              onChange={(event) => setAuthorization(event.target.value)}
            />
          </details>
          <div className="aaw-form-footer">
            <p className="muted">
              使用 {snapshot.settings.decisionProvider?.model ?? snapshot.settings.provider.model}{' '}
              判断下一步。按任务需要读取界面并调用模型。
            </p>
            <button
              className="button primary"
              type="submit"
              disabled={busy || !canCreate || !goal.trim() || !acceptance.trim()}
            >
              {busy ? (
                <LoaderCircle size={15} className="spin" aria-hidden="true" />
              ) : (
                <Play size={15} aria-hidden="true" />
              )}
              开始跟进
            </button>
          </div>
        </form>
      )}
      {current && !creating && (
        <TaskDetail key={current.id} task={current} busy={busy} perform={perform} />
      )}

      <details className="aaw-hook aaw-details" open={!sessions.length}>
        <summary>
          <span>
            Hook 接入{' '}
            <span className="muted">
              {!hooksMatch ? '尚未检查此工作区' : state?.hooks.installed ? '已安装' : '尚未安装'}
            </span>
          </span>
          <ChevronDown size={15} aria-hidden="true" />
        </summary>
        <p className="muted">
          通过原生任务事件跟进会话。安装后需由源应用加载配置，实际能力以会话状态为准。
        </p>
        <p className="aaw-trust" role="status">
          <CircleHelp size={15} aria-hidden="true" />
          {hooksMatch && state?.hooks.trust === 'observed'
            ? '已收到源端事件。'
            : hooksMatch && state?.hooks.trust === 'review_required'
              ? '源应用需要审阅 Hook 配置；请在源应用中完成信任设置。'
              : '尚未确认源应用是否加载并信任 Hook。'}
        </p>
        {state?.hooks.error && <p role="alert">{state.hooks.error}</p>}
        <label htmlFor="aaw-hook-workspace">Agent 工作区路径</label>
        <input
          id="aaw-hook-workspace"
          value={workspace}
          maxLength={2048}
          spellCheck={false}
          disabled={busy}
          onChange={(event) => setWorkspace(event.target.value)}
          onBlur={() => {
            if (workspace.trim())
              void unwrap(api.refreshAutoAgentWork({ workspace: workspace.trim() })).catch(
                (error) => setError(error instanceof Error ? error.message : String(error)),
              )
          }}
        />
        <div className="aaw-actions">
          <button
            className="button secondary"
            disabled={busy || !workspace.trim() || !state}
            onClick={() =>
              void perform(
                () => unwrap(api.installAutoAgentHooks({ workspace: workspace.trim() })),
                'Hook 配置已写入，请查看源应用的加载和信任状态。',
              )
            }
          >
            安装 Hook
          </button>
          <button
            className="text-button"
            disabled={busy || !workspace.trim() || !hooksMatch || !state?.hooks.installed}
            onClick={() =>
              void perform(
                () => unwrap(api.uninstallAutoAgentHooks({ workspace: workspace.trim() })),
                '已移除 Coloop 的 Hook 配置。',
              )
            }
          >
            卸载 Hook
          </button>
        </div>
        {hooksMatch && state?.hooks.configPath && (
          <p className="muted aaw-path">配置位置：{state.hooks.configPath}</p>
        )}
      </details>
      <div className="aaw-usage" aria-label="今日全部云端用量">
        <span>今日全部云端用量</span>
        <span>{snapshot.modelUsage?.requests ?? 0} 次请求</span>
        <span>{(snapshot.modelUsage?.tokenUnits ?? 0).toLocaleString('zh-CN')} 用量额度</span>
        <span>已定价估算 ¥{(snapshot.modelUsage?.estimatedCostYuan ?? 0).toFixed(4)}</span>
        {!!snapshot.modelUsage?.unpricedRequests && (
          <span>{snapshot.modelUsage.unpricedRequests} 次未定价</span>
        )}
      </div>
    </div>
  )
}

function TaskDetail({
  task,
  busy,
  perform,
}: {
  task: AutoAgentTask
  busy: boolean
  perform: Perform
}) {
  const [supplement, setSupplement] = useState('')
  const ended = ['completed', 'unbound'].includes(task.state)
  const decisions = [...task.decisions].reverse()
  const assessment = decisions.find(
    (decision) => decision.taskVersion === task.version && decision.acceptance,
  )?.acceptance
  const lastAction = task.actions.at(-1)
  const update = (action: 'pause' | 'resume' | 'unbind' | 'stop_agent') =>
    perform(() => unwrap(api.updateAutoAgentWork({ taskId: task.id, action })))
  return (
    <section className="aaw-task" aria-label="当前跟进任务">
      <div className="aaw-task-heading">
        <div>
          <h2>{task.goal}</h2>
          <span className="aaw-state" role="status">
            {taskLabels[task.state]}
          </span>
          <p className="muted">{sessionName(task.session)}</p>
        </div>
        {!ended && (
          <div className="aaw-actions">
            {['paused', 'needs_user'].includes(task.state) ? (
              <button
                className="button primary"
                disabled={busy}
                onClick={() => void update('resume')}
              >
                <Play size={15} aria-hidden="true" />
                恢复跟进
              </button>
            ) : (
              <button
                className="button secondary"
                disabled={busy}
                onClick={() => void update('pause')}
              >
                <Pause size={15} aria-hidden="true" />
                暂停跟进
              </button>
            )}
            <button
              className="button secondary"
              disabled={busy || !['available', 'verified'].includes(task.session.capabilities.stop)}
              title="请求源 Agent 停止，实际结果以回执为准"
              onClick={() => void update('stop_agent')}
            >
              <Square size={14} aria-hidden="true" />
              停止 Agent
            </button>
            <button className="text-button" disabled={busy} onClick={() => void update('unbind')}>
              <Unplug size={14} aria-hidden="true" />
              解除绑定
            </button>
          </div>
        )}
      </div>
      {(task.pauseReason || task.error) && (
        <p className="aaw-message" role={task.error ? 'alert' : 'status'}>
          {task.error || task.pauseReason}
        </p>
      )}
      {task.state === 'watching' && (
        <p className="muted">等待任务事件。Agent 正常运行时保持待命。</p>
      )}
      {lastAction && (
        <p className="aaw-receipt" role="status">
          最近回执：{actionLabels[lastAction.status] ?? lastAction.status}
          {lastAction.error ? ` · ${lastAction.error}` : ''}
        </p>
      )}

      <div className="aaw-progress-grid">
        <section className="aaw-section" aria-label="完成条件与缺口">
          <h3>完成条件</h3>
          <ul className="aaw-checklist">
            {task.acceptance.map((requirement, index) => {
              const proof = assessment?.requirements.find(
                (entry) => entry.requirement === requirement,
              )
              return (
                <li key={`${index}:${requirement}`}>
                  <span className="aaw-check-mark" aria-hidden="true">
                    {proof?.satisfied ? <Check size={15} /> : <Circle size={12} />}
                  </span>
                  <div>
                    <span>{requirement}</span>
                    {proof?.evidence && <p className="muted">{proof.evidence}</p>}
                  </div>
                  <span className="muted">{proof?.satisfied ? '已核验' : '待核验'}</span>
                </li>
              )
            })}
          </ul>
          {!!assessment?.gaps.length && (
            <>
              <h3>仍需完成</h3>
              <ul className="aaw-text-list">
                {assessment.gaps.map((gap, index) => (
                  <li key={index}>{gap}</li>
                ))}
              </ul>
            </>
          )}
          {!!assessment?.imperfections.length && (
            <>
              <h3>结果中的不足</h3>
              <ul className="aaw-text-list">
                {assessment.imperfections.map((item, index) => (
                  <li key={index}>{item}</li>
                ))}
              </ul>
            </>
          )}
        </section>
        <section className="aaw-section" aria-label="本次参考记忆">
          <h3>本次参考记忆</h3>
          {!task.memory && <p className="muted">在下一次需要判断时检索相关偏好和历史反馈。</p>}
          {task.memory?.status === 'unavailable' && (
            <p className="muted">记忆暂不可用，不能据此判断没有相关偏好。{task.memory.error}</p>
          )}
          {task.memory?.status === 'empty' && (
            <p className="muted">没有找到相关记忆，本次按任务要求判断。</p>
          )}
          {!!task.memory?.references.length && (
            <ul className="aaw-memory-list">
              {task.memory.references.map((memory) => (
                <li key={memory.id}>
                  <span className="muted">{memoryLabels[memory.kind]}</span>
                  <p>{memory.text}</p>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
      {!ended && (
        <form
          className="aaw-supplement"
          onSubmit={(event) => {
            event.preventDefault()
            if (!supplement.trim()) return
            void perform(async () => {
              await unwrap(
                api.updateAutoAgentWork({
                  taskId: task.id,
                  action: 'supplement',
                  text: supplement.trim(),
                }),
              )
              setSupplement('')
            }, '已更新任务要求，旧的待发决策已失效。')
          }}
        >
          <label htmlFor={`aaw-supplement-${task.id}`}>补充要求或回答</label>
          <textarea
            id={`aaw-supplement-${task.id}`}
            value={supplement}
            onChange={(event) => setSupplement(event.target.value)}
            rows={2}
            maxLength={8000}
            disabled={busy}
            placeholder="补充这次任务的要求，或纠正当前判断。"
          />
          <button className="button secondary" disabled={busy || !supplement.trim()} type="submit">
            <Send size={14} aria-hidden="true" />
            更新要求
          </button>
        </form>
      )}
      <section className="aaw-section aaw-decisions" aria-label="推进记录">
        <h3>执行过程与输出</h3>
        <AutoAgentTimeline key={task.id} task={task} />
        <h3>推进记录</h3>
        {!decisions.length && (
          <p className="muted">尚未代为作出决定。收到需要介入的事件后，判断和依据会显示在这里。</p>
        )}
        {decisions.map((decision, index) => (
          <details key={decision.id} className="aaw-decision" open={index === 0}>
            <summary>
              <span>{decisionLabels[decision.action]}</span>
              <span className="muted">
                {dateTime(decision.createdAt)} · {decision.model}
              </span>
              <ChevronDown size={14} aria-hidden="true" />
            </summary>
            <p>{decision.reason}</p>
            {decision.message && <blockquote>{decision.message}</blockquote>}
            {decision.expectedChange && (
              <p className="muted">预期变化：{decision.expectedChange}</p>
            )}
            {!!decision.memoryReferences.length && (
              <p className="muted">参考 {decision.memoryReferences.length} 条记忆</p>
            )}
          </details>
        ))}
      </section>
      {task.usage && (
        <div className="aaw-usage" aria-label="本任务模型用量">
          <span>本任务模型用量</span>
          <span>{task.usage.requests} 次请求</span>
          <span>{task.usage.tokenUnits.toLocaleString('zh-CN')} 用量额度</span>
          <span>已定价估算 ¥{task.usage.estimatedCostYuan.toFixed(4)}</span>
          {!!task.usage.unpricedRequests && <span>{task.usage.unpricedRequests} 次未定价</span>}
        </div>
      )}
      {task.state === 'completed' && <TaskFeedback task={task} busy={busy} perform={perform} />}
    </section>
  )
}

function TaskFeedback({
  task,
  busy,
  perform,
}: {
  task: AutoAgentTask
  busy: boolean
  perform: Perform
}) {
  const [rating, setRating] = useState<AutoAgentFeedbackInput['rating']>()
  const [reason, setReason] = useState('')
  const [scope, setScope] = useState<'task' | 'future'>('task')
  const [decisionId, setDecisionId] = useState('')
  const latest = task.feedback.at(-1)
  return (
    <section className="aaw-feedback aaw-section" aria-label="个人评价">
      <div className="section-bar">
        <h3>这次跟进符合你的习惯吗？</h3>
        <span className="muted">选填，不影响任务结果</span>
      </div>
      {latest && (
        <p className="muted" role="status">
          已收到{latest.rating === 'positive' ? '正面' : '负面'}评价。
          {latest.attribution === 'failed'
            ? '策略记录未保存，可重新提交。'
            : latest.attribution === 'pending'
              ? '正在整理评价依据。'
              : '评价依据已保存。'}
        </p>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault()
          if (!rating) return
          void perform(async () => {
            await unwrap(
              api.submitAutoAgentFeedback({
                taskId: task.id,
                rating,
                reason,
                scope,
                decisionId: decisionId || undefined,
              }),
            )
            setRating(undefined)
            setReason('')
            setScope('task')
            setDecisionId('')
          }, '评价已提交。你可以继续工作。')
        }}
      >
        <div className="aaw-actions" role="group" aria-label="满意程度">
          <button
            type="button"
            className={`button secondary ${rating === 'positive' ? 'selected' : ''}`}
            aria-pressed={rating === 'positive'}
            disabled={busy}
            onClick={() => setRating('positive')}
          >
            <ThumbsUp size={15} aria-hidden="true" />
            满意
          </button>
          <button
            type="button"
            className={`button secondary ${rating === 'negative' ? 'selected' : ''}`}
            aria-pressed={rating === 'negative'}
            disabled={busy}
            onClick={() => setRating('negative')}
          >
            <ThumbsDown size={15} aria-hidden="true" />
            需要改进
          </button>
        </div>
        {rating && (
          <>
            <label htmlFor={`aaw-feedback-reason-${task.id}`}>
              原因或希望怎样调整 <span className="muted">选填</span>
            </label>
            <textarea
              id={`aaw-feedback-reason-${task.id}`}
              rows={2}
              value={reason}
              maxLength={4000}
              disabled={busy}
              onChange={(event) => setReason(event.target.value)}
              placeholder="例如：结果符合要求，但类似的小修改以后直接处理。"
            />
            {!!task.decisions.length && (
              <label>
                评价对象
                <select
                  value={decisionId}
                  disabled={busy}
                  onChange={(event) => setDecisionId(event.target.value)}
                >
                  <option value="">整个任务</option>
                  {task.decisions.map((decision) => (
                    <option key={decision.id} value={decision.id}>
                      {decisionLabels[decision.action]} · {dateTime(decision.createdAt)}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <fieldset className="aaw-feedback-scope">
              <legend>适用范围</legend>
              <label>
                <input
                  type="radio"
                  name={`scope-${task.id}`}
                  value="task"
                  checked={scope === 'task'}
                  disabled={busy}
                  onChange={() => setScope('task')}
                />
                只针对这次任务
              </label>
              <label>
                <input
                  type="radio"
                  name={`scope-${task.id}`}
                  value="future"
                  checked={scope === 'future'}
                  disabled={busy}
                  onChange={() => setScope('future')}
                />
                用于以后类似任务
              </label>
            </fieldset>
            <button className="button primary" type="submit" disabled={busy}>
              提交评价
            </button>
          </>
        )}
      </form>
    </section>
  )
}
