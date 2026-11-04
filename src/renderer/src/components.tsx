import {
  Check,
  CheckCircle2,
  CircleDashed,
  Copy,
  LoaderCircle,
  Square,
  XCircle,
  ArrowUpRight,
  Cpu,
  Cable,
  ScanText,
  Cloud,
  ShieldCheck,
  Monitor,
  ChevronRight,
} from 'lucide-react'
import type { DeviceState, Task } from '../../shared/contracts'
import { api, unwrap } from './api'
import brandMark from '../../../resources/brand.svg'
import { HardwareArt } from './HardwareArt'

export const time = (value: string) =>
  new Date(value).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
export function Logo({ small = false }: { small?: boolean }) {
  return (
    <div className={`brand ${small ? 'small' : ''}`} aria-label="Coloop">
      <img className="brand-mark" src={brandMark} alt="" />
      <span className="brand-lockup">
        <span className="brand-wordmark">Coloop</span>
      </span>
    </div>
  )
}
export function BrandMark() {
  return <img className="inline-brand-mark" src={brandMark} alt="" />
}
export function Status({ task }: { task: Task }) {
  const Icon =
    task.status === 'completed'
      ? CheckCircle2
      : task.status === 'running'
        ? LoaderCircle
        : task.status === 'failed'
          ? XCircle
          : CircleDashed
  return (
    <span className={`status ${task.status}`}>
      <Icon size={13} className={task.status === 'running' ? 'spin' : ''} />
      {task.stage}
    </span>
  )
}
export function TaskResult({
  task,
  notify,
}: {
  task: Task
  notify: (message: string, error?: boolean) => void
}) {
  return (
    <section className="result-panel">
      <div className="section-bar">
        <div className="result-title">
          <span className="assistant-symbol">
            <BrandMark />
          </span>
          <strong>Coloop</strong>
          <span className="muted">{task.model}</span>
        </div>
        <Status task={task} />
      </div>
      {task.answer ? (
        <div className="answer">{task.answer}</div>
      ) : task.status === 'running' ? (
        <div className="answer waiting">
          <LoaderCircle size={16} className="spin" />
          {task.stage}…
        </div>
      ) : null}
      {task.error && (
        <div role="alert" className="inline-error">
          <XCircle size={16} />
          <span>{task.error}</span>
        </div>
      )}
      {task.status === 'running' && (
        <p className="muted">回答完成后返回。停止只结束上位机等待，不会终止板端共享推理。</p>
      )}
      <div className="result-footer">
        <span>
          {time(task.createdAt)}
          {task.finishedAt &&
            ` · ${Math.max(1, Math.round((Date.parse(task.finishedAt) - Date.parse(task.createdAt)) / 1000))} 秒`}
        </span>
        <div className="row">
          {task.answer && (
            <button
              className="text-button"
              onClick={() =>
                void unwrap(api.copyText(task.answer))
                  .then(() => notify('回答已复制'))
                  .catch((e) => notify(e.message, true))
              }
            >
              <Copy size={14} />
              复制回答
            </button>
          )}
          {task.status === 'running' && (
            <button
              className="text-button danger"
              onClick={() =>
                void unwrap(api.cancelTask(task.id))
                  .then(() => {
                    notify('已停止等待，板端共享推理可能仍在运行')
                  })
                  .catch((e) => notify(e.message, true))
              }
              title="停止等待，板端共享推理可能仍在运行"
            >
              <Square size={12} />
              停止等待
            </button>
          )}
        </div>
      </div>
    </section>
  )
}
export function BoardIllustration() {
  return <HardwareArt />
}
export function DeviceRail({
  device,
  hasKey,
  onDevice,
  onModels,
}: {
  device: DeviceState
  hasKey: boolean
  onDevice: () => void
  onModels: () => void
}) {
  const connected = device.status === 'connected'
  return (
    <aside className="inspector">
      <section className="inspector-section">
        <h3>连接概览</h3>
        <div className="connection-map" aria-label="本机通过 Coloop 连接 RK 设备">
          <div>
            <span>
              <Monitor size={21} />
            </span>
            <small>本机</small>
          </div>
          <i />
          <div>
            <BrandMark />
            <small>Coloop</small>
          </div>
          <i className={connected ? 'connected' : ''} />
          <div>
            <span className={connected ? 'connected' : ''}>
              <Cpu size={21} />
            </span>
            <small>RK 设备</small>
          </div>
        </div>
        <div className="section-bar">
          <h3>RK 设备</h3>
          <span className={`connection-pill ${connected ? 'online' : ''}`}>
            <i />
            {connected
              ? '已连接'
              : device.status === 'connecting'
                ? '连接中'
                : device.status === 'error'
                  ? '连接失败'
                  : '未连接'}
          </span>
        </div>
        <div className="device-identity">
          <div>
            <h3>LubanCat 4</h3>
            <p>RK3588 · USB 网络</p>
          </div>
        </div>
        <div className="device-detail">
          <div>
            <span>设备名称</span>
            <strong>{device.hostname || '等待连接'}</strong>
          </div>
          <div>
            <span>可用内存</span>
            <strong>
              {connected ? `${((device.memoryAvailableMb || 0) / 1024).toFixed(1)} GB` : '—'}
            </strong>
          </div>
          <div>
            <span>设备温度</span>
            <strong>{connected ? `${device.temperatureC?.toFixed(1) ?? '—'} °C` : '—'}</strong>
          </div>
        </div>
        <button className="button secondary full" onClick={onDevice}>
          <Cable size={15} />
          {connected ? '管理设备' : '连接设备'}
          <ChevronRight size={14} />
        </button>
      </section>
      <section className="inspector-section">
        <h3>能力状态</h3>
        <div className="capability">
          <span className="capability-icon">
            <ScanText size={18} />
          </span>
          <div>
            <strong>本地 OCR</strong>
            <p>中英文文字与坐标</p>
          </div>
          <span className="capability-state green">已接入</span>
        </div>
        <button className="capability capability-button" onClick={onModels}>
          <span className="capability-icon">
            <Cloud size={18} />
          </span>
          <div>
            <strong>云端模型</strong>
            <p>{hasKey ? '已保存访问凭据' : '配置模型访问凭据'}</p>
          </div>
          <span className={`capability-state ${hasKey ? 'green' : ''}`}>
            {hasKey ? '已配置' : '待配置'}
            <ChevronRight size={12} />
          </span>
        </button>
        <div className="capability">
          <span className="capability-icon">
            <Cpu size={18} />
          </span>
          <div>
            <strong>端侧模型</strong>
            <p>{device.model || 'Qwen3.5-4B'}</p>
          </div>
          <span className={`capability-state ${connected && device.qwenReady ? 'green' : ''}`}>
            {connected
              ? device.qwenReady
                ? '已就绪'
                : device.modelServiceStatus === 'error'
                  ? '异常'
                  : '待启动'
              : '待连接'}
          </span>
        </div>
      </section>
      <div className="local-note">
        <ShieldCheck size={16} />
        <div>
          <strong>本地优先</strong>
          <p>图像在本机识别。协作模式由 RK 先检查，复杂任务仅发送必要的脱敏摘要。</p>
        </div>
      </div>
    </aside>
  )
}
