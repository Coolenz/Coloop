import { useEffect, useState } from 'react'
import { ArrowLeft, ChevronRight, Copy, Play, Square } from 'lucide-react'
import type { AppSnapshot } from '../../shared/contracts'
import type { ModelDebugRun, ModelDiagnostic, RoutePreview } from '../../shared/model-debug'
import { api, unwrap } from './api'
import { cloudModelCapacity } from '../../shared/model-capacity'
import { modelLimitMode } from '../../shared/model-usage'
import { legacyLocalCapacity } from '../../shared/local-model'

export function ModelDebugPage({
  snapshot,
  onDraft,
  diagnosticTask,
  onRecord,
}: {
  snapshot: AppSnapshot
  onDraft(text: string): void
  diagnosticTask?: string
  onRecord(id: string): void
}) {
  const [page, setPage] = useState<'overview' | 'reply' | 'route' | 'diagnostics'>(
    diagnosticTask ? 'diagnostics' : 'overview',
  )
  const [mode, setMode] = useState(
    snapshot.settings.executionMode ?? snapshot.settings.autoTaskRouting ?? 'cloud',
  )
  const [fallback, setFallback] = useState(snapshot.settings.allowCloudFallback !== false)
  const [limitMode, setLimitMode] = useState(modelLimitMode(snapshot.settings.modelLimits ?? {}))
  const cloudCapacity = cloudModelCapacity(snapshot.settings.provider)
  const localCapacity = snapshot.device.localModelCapacity ?? legacyLocalCapacity
  const [target, setTarget] = useState<'local' | 'cloud'>('local')
  const [prompt, setPrompt] = useState('请只回复“连接正常”。')
  const [system, setSystem] = useState('')
  const [tokens, setTokens] = useState('')
  useEffect(() => {
    setTokens('')
  }, [target])
  const [timeout, setTimeoutValue] = useState(120)
  const [jobId, setJobId] = useState<string>()
  const [job, setJob] = useState<ModelDebugRun>()
  const [routePrompt, setRoutePrompt] = useState('')
  const [route, setRoute] = useState<RoutePreview>()
  const [diagnostics, setDiagnostics] = useState<ModelDiagnostic[]>([])
  const [filterTask, setFilterTask] = useState(diagnosticTask ?? '')
  const [filterModel, setFilterModel] = useState('')
  const [since, setSince] = useState('')
  const [exportPath, setExportPath] = useState('')
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let active = true
    void unwrap(api.currentModelDebug())
      .then((value) => {
        if (active && value) {
          setJob(value)
          setJobId(value.id)
        }
      })
      .catch((error) => {
        if (active) setError(error.message)
      })
    return () => {
      active = false
    }
  }, [])
  const act = async (action: () => Promise<unknown>) => {
    setBusy(true)
    setError('')
    setStatus('')
    try {
      await action()
    } catch (failure) {
      setError((failure as Error).message)
    } finally {
      setBusy(false)
    }
  }
  useEffect(() => {
    if (!jobId) return
    let active = true
    let timer: ReturnType<typeof setTimeout>
    const read = async () => {
      try {
        const value = await unwrap(api.getModelDebug(jobId))
        if (active) {
          setJob(value)
          if (['waiting', 'running'].includes(value.state))
            timer = setTimeout(() => void read(), 500)
        }
      } catch (failure) {
        if (active) setError((failure as Error).message)
      }
    }
    void read()
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [jobId])
  const loadDiagnostics = () =>
    act(async () =>
      setDiagnostics(
        await unwrap(
          api.modelDiagnostics({
            taskId: filterTask || undefined,
            model: filterModel || undefined,
            since: since ? Date.parse(since) : undefined,
          }),
        ),
      ),
    )
  useEffect(() => {
    if (diagnosticTask) void loadDiagnostics()
  }, [diagnosticTask])
  return (
    <div className="model-debug-page">
      {page !== 'overview' && (
        <button className="text-button" onClick={() => setPage('overview')}>
          <ArrowLeft size={16} />
          返回模型运行与调试
        </button>
      )}
      <h1>
        {
          {
            overview: '模型运行与调试',
            reply: '测试模型回复',
            route: '预览任务分配',
            diagnostics: '运行诊断',
          }[page]
        }
      </h1>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      {status && (
        <p className="settings-feedback" role="status">
          {status}
        </p>
      )}
      {page === 'overview' && (
        <>
          <section className="configuration-section">
            <h2>任务执行模式</h2>
            {(
              [
                ['cloud', '云端执行', '全部新任务交给云端模型'],
                ['local', '本地执行', '全部新任务交给 RK 本地模型'],
                ['local-auto', '本地判断', '本地模型判断任务由谁执行'],
              ] as const
            ).map(([value, label, description]) => (
              <label className="routing-option" key={value}>
                <input
                  type="radio"
                  name="execution-mode"
                  value={value}
                  checked={mode === value}
                  onChange={() => setMode(value)}
                />
                <span>
                  <strong>{label}</strong>
                  <small>{description}</small>
                </span>
              </label>
            ))}
            <label className="setting-toggle">
              <input
                type="checkbox"
                checked={fallback}
                onChange={(event) => setFallback(event.target.checked)}
              />
              本地模型异常时允许云端接管
            </label>
            <p className="muted">
              保存后用于新提交的执行轮次，排队及运行中的任务沿用受理时的策略。
            </p>
            <button
              className="button primary"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  await unwrap(
                    api.updatePreferences({
                      executionMode: mode,
                      allowCloudFallback: fallback,
                      modelLimitMode: limitMode,
                    }),
                  )
                  setStatus('执行策略已保存')
                })
              }
            >
              保存设置
            </button>
          </section>
          <section className="configuration-section">
            <h2>模型调用限额</h2>
            {(['unlimited', 'custom'] as const).map((value) => (
              <label className="routing-option" key={value}>
                <input
                  type="radio"
                  name="model-limit-mode"
                  checked={limitMode === value}
                  onChange={() => setLimitMode(value)}
                />
                <span>
                  <strong>{value === 'unlimited' ? '不限额' : '自定义限额'}</strong>
                  <small>
                    {value === 'unlimited'
                      ? '按模型容量运行，持续记录调用与费用'
                      : '使用云端模型页设置的调用、输入输出和费用上限'}
                  </small>
                </span>
              </label>
            ))}
            <p className="muted">选择后点击上方“保存设置”，用于后续执行及中断任务的继续执行。</p>
          </section>
          <section className="configuration-section">
            <h2>模型运行状态</h2>
            <div className="model-status-row">
              <div>
                <strong>{snapshot.device.model ?? 'RK 本地模型'}</strong>
                <p className="muted">本地模型使用 RK 独立上下文与请求字节预算。</p>
                <p>
                  {snapshot.device.status !== 'connected'
                    ? '设备未连接'
                    : snapshot.device.qwenReady
                      ? '服务就绪'
                      : '模型服务未就绪'}
                </p>
              </div>
              <button
                className="button"
                disabled={busy || snapshot.device.status !== 'connected'}
                onClick={() => void act(() => unwrap(api.startRkService()))}
              >
                启动服务
              </button>
              <button
                className="button"
                onClick={() => {
                  setTarget('local')
                  setPage('reply')
                }}
              >
                测试回复
              </button>
            </div>
            <div className="model-status-row">
              <div>
                <strong>{snapshot.settings.provider.model}</strong>
                <p>{snapshot.settings.provider.hasKey ? '云端连接已配置' : '等待配置 API Key'}</p>
                <p className="muted">
                  上下文 {cloudCapacity.contextWindow.toLocaleString()} tokens · 默认输出{' '}
                  {cloudCapacity.maxOutputTokens.toLocaleString()} tokens
                </p>
                {cloudCapacity.officialDeepSeek && <p className="muted">DSH 原生自动压缩与续跑</p>}
              </div>
              <button
                className="button"
                disabled={busy}
                onClick={() => void act(async () => setStatus(await unwrap(api.testProvider())))}
              >
                测试连接
              </button>
              <button
                className="button"
                onClick={() => {
                  setTarget('cloud')
                  setPage('reply')
                }}
              >
                测试回复
              </button>
            </div>
          </section>
          <section className="configuration-section">
            <h2>调试工具</h2>
            {(
              [
                ['reply', '测试模型回复'],
                ['route', '预览任务分配'],
                ['diagnostics', '查看运行诊断'],
              ] as const
            ).map(([value, label]) => (
              <button
                className="configuration-link"
                key={value}
                onClick={() => {
                  setPage(value)
                  if (value === 'diagnostics') void loadDiagnostics()
                }}
              >
                <span>{label}</span>
                <ChevronRight size={17} />
              </button>
            ))}
          </section>
        </>
      )}
      {page === 'reply' && (
        <section className="configuration-section debug-form">
          <label>
            测试目标
            <select
              value={target}
              onChange={(event) => setTarget(event.target.value as 'local' | 'cloud')}
            >
              <option value="local">本地模型</option>
              <option value="cloud">云端模型</option>
            </select>
          </label>
          <p className="muted">
            {target === 'local' ? snapshot.device.model : snapshot.settings.provider.model} ·
            纯文本模型调用
          </p>
          <label>
            输入
            <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={5} />
          </label>
          <details>
            <summary>高级参数</summary>
            <label>
              系统提示
              <textarea
                value={system}
                onChange={(event) => setSystem(event.target.value)}
                rows={3}
              />
            </label>
            <label>
              输出预算（留空使用默认）
              <input
                type="number"
                min={1}
                max={
                  target === 'local'
                    ? localCapacity.maximumOutputTokens
                    : cloudCapacity.maximumOutputTokens
                }
                placeholder={String(
                  target === 'local'
                    ? (snapshot.settings.localModel?.outputTokens ??
                        localCapacity.defaultOutputTokens)
                    : cloudCapacity.maxOutputTokens,
                )}
                value={tokens}
                onChange={(event) => setTokens(event.target.value)}
              />
            </label>
            <label>
              超时（秒）
              <input
                type="number"
                min={1}
                max={300}
                value={timeout}
                onChange={(event) => setTimeoutValue(Number(event.target.value))}
              />
            </label>
          </details>
          <div className="form-actions">
            <button
              className="button"
              disabled={!job || !['waiting', 'running'].includes(job.state)}
              onClick={() => jobId && void act(() => unwrap(api.cancelModelDebug(jobId)))}
            >
              <Square size={14} />
              停止测试
            </button>
            <button
              className="button primary"
              disabled={
                busy || !prompt.trim() || (!!job && ['waiting', 'running'].includes(job.state))
              }
              onClick={() =>
                void act(async () => {
                  setJob(undefined)
                  setJobId(
                    await unwrap(
                      api.startModelDebug({
                        target,
                        prompt,
                        system: system || undefined,
                        maxTokens: tokens ? Number(tokens) : undefined,
                        timeoutMs: timeout * 1000,
                      }),
                    ),
                  )
                })
              }
            >
              <Play size={14} />
              开始测试
            </button>
          </div>
          {job && (
            <section className="debug-result" aria-live="polite">
              <h2>返回内容</h2>
              <p>
                {
                  {
                    waiting: '等待本地推理资源',
                    running: '正在测试',
                    completed: '测试完成',
                    failed: '测试失败',
                    cancelled: '已停止',
                  }[job.state]
                }
              </p>
              <pre>{job.text || job.error || '等待模型回复…'}</pre>
              {job.state === 'waiting' && (
                <p>
                  占用任务 ·{' '}
                  {snapshot.tasks.find((task) => task.status === 'running')?.prompt ??
                    snapshot.proactive?.taskId ??
                    'RK 当前调用'}
                </p>
              )}
              <dl>
                <dt>实际输出预算</dt>
                <dd>
                  {job.requestedOutputTokens ?? '未提供'} tokens · {job.budgetSource ?? '未提供'}
                </dd>
                <dt>结束原因</dt>
                <dd>{job.finishReason ?? '未提供'}</dd>
                <dt>总耗时</dt>
                <dd>{job.elapsedMs === undefined ? '进行中' : `${job.elapsedMs} ms`}</dd>
                <dt>首字延迟</dt>
                <dd>{job.firstTextMs === undefined ? '未提供' : `${job.firstTextMs} ms`}</dd>
                <dt>输入／输出</dt>
                <dd>
                  {job.inputBytes}／{job.outputBytes ?? '未提供'} 字节
                </dd>
                <dt>Token／费用</dt>
                <dd>未提供，可在模型用量账本中核对可用数据</dd>
              </dl>
              <button
                className="text-button"
                onClick={() => void act(() => unwrap(api.copyText(job.text || job.error || '')))}
              >
                <Copy size={14} />
                复制结果
              </button>
            </section>
          )}
        </section>
      )}
      {page === 'route' && (
        <section className="configuration-section debug-form">
          <label>
            输入任务
            <textarea
              value={routePrompt}
              onChange={(event) => setRoutePrompt(event.target.value)}
              rows={5}
            />
          </label>
          <button
            className="button primary"
            disabled={busy || !routePrompt.trim()}
            onClick={() =>
              void act(async () => setRoute(await unwrap(api.previewTaskRoute(routePrompt))))
            }
          >
            分析分配
          </button>
          {route && (
            <div className="debug-result">
              <dl>
                <dt>分配结果</dt>
                <dd>{route.route === 'cloud' ? '云端执行' : '本地执行'}</dd>
                <dt>判断模型</dt>
                <dd>{snapshot.device.model ?? 'RK 本地模型'}</dd>
                <dt>耗时</dt>
                <dd>{route.elapsedMs} ms</dd>
                <dt>结果来源</dt>
                <dd>
                  {
                    {
                      model: '本地模型判断',
                      timeout: '判断超时，默认云端',
                      invalid: '无效输出，默认云端',
                      oversize: '输入超出分类预算，默认云端',
                      unavailable: '本地模型不可用，默认云端',
                    }[route.source]
                  }
                </dd>
              </dl>
              <details>
                <summary>判断原始结果</summary>
                <pre>{route.raw ?? '未提供'}</pre>
              </details>
              <button className="button" onClick={() => onDraft(routePrompt)}>
                带入首页新任务
              </button>
            </div>
          )}
        </section>
      )}
      {page === 'diagnostics' && (
        <section className="configuration-section">
          <div className="record-filters">
            <input
              aria-label="按任务 ID 筛选"
              placeholder="任务 ID"
              value={filterTask}
              onChange={(event) => setFilterTask(event.target.value)}
            />
            <input
              aria-label="按模型筛选"
              placeholder="模型"
              value={filterModel}
              onChange={(event) => setFilterModel(event.target.value)}
            />
            <input
              type="datetime-local"
              aria-label="开始时间"
              value={since}
              onChange={(event) => setSince(event.target.value)}
            />
            <button className="button" onClick={() => void loadDiagnostics()}>
              查询
            </button>
          </div>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>时间</th>
                  <th>模型／来源</th>
                  <th>事件</th>
                  <th>耗时</th>
                  <th>详情</th>
                </tr>
              </thead>
              <tbody>
                {diagnostics.map((item, index) => (
                  <tr key={`${item.id}-${index}`}>
                    <td>{new Date(item.at).toLocaleString()}</td>
                    <td>{item.model ?? item.source}</td>
                    <td>{item.event}</td>
                    <td>{item.elapsedMs === undefined ? '未提供' : `${item.elapsedMs} ms`}</td>
                    <td>
                      <details>
                        <summary>查看</summary>
                        <pre>{JSON.stringify(item, null, 2)}</pre>
                      </details>
                      {item.taskId && (
                        <button className="text-button" onClick={() => onRecord(item.taskId!)}>
                          查看任务记录
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!diagnostics.length && <p className="empty-copy">当前筛选范围没有诊断记录</p>}
          <label className="export-path">
            报告完整路径
            <input
              value={exportPath}
              onChange={(event) => setExportPath(event.target.value)}
              placeholder="D:\Coloop\诊断报告.json"
            />
          </label>
          <button
            className="button"
            disabled={!exportPath || busy}
            onClick={() =>
              void act(async () => {
                await unwrap(
                  api.modelDiagnostics({
                    taskId: filterTask || undefined,
                    model: filterModel || undefined,
                    since: since ? Date.parse(since) : undefined,
                    path: exportPath,
                  }),
                )
                setStatus('诊断报告已导出')
              })
            }
          >
            导出诊断
          </button>
        </section>
      )}
    </div>
  )
}
