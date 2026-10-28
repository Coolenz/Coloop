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
    <div className={`brand ${small ? 'small' : ''}`} aria-label="Coloop by coolen">
      <img className="brand-mark" src={brandMark} alt="" />
      <span className="brand-lockup">
        <span className="brand-wordmark">
          coloop<span className="brand-dot">.</span>
        </span>
        <small>by coolen</small>
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
                void unwrap(api.cancelTask(task.id)).catch((e) => notify(e.message, true))
              }
            >
              <Square size={12} />
              停止
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
      <div className="section-bar">
        <h3>我的设备</h3>
        <span className={`connection-pill ${connected ? 'online' : ''}`}>
          <i />
          {connected ? '已连接' : device.status === 'connecting' ? '连接中' : '未连接'}
        </span>
      </div>
      <div className="device-showcase">
        <BoardIllustration />
        <div className="hardware-caption">
          <span>端侧计算单元</span>
          <span>USB / RK3588</span>
        </div>
      </div>
      <h3 className="device-name">
        LubanCat 4 <span>RK3588</span>
      </h3>
      <p className="muted center">与桌面协同的独立算力</p>
      <div className="device-detail">
        <div>
          <span>连接方式</span>
          <strong>
            <Cable size={13} /> USB 网络
          </strong>
        </div>
        <div>
          <span>设备名称</span>
          <strong>{device.hostname || '等待连接'}</strong>
        </div>
        <div>
          <span>设备内存</span>
          <strong>
            {connected ? `${((device.memoryTotalMb || 0) / 1024).toFixed(1)} GB` : '—'}
          </strong>
        </div>
        {connected && (
          <>
            <div>
              <span>可用内存</span>
              <strong>{((device.memoryAvailableMb || 0) / 1024).toFixed(1)} GB</strong>
            </div>
            <div>
              <span>设备温度</span>
              <strong>{device.temperatureC?.toFixed(1) ?? '—'} °C</strong>
            </div>
          </>
        )}
      </div>
      <button className="button secondary full" onClick={onDevice}>
        {connected ? '管理设备' : '连接设备'}
        <ArrowUpRight size={14} />
      </button>
      <div className="rail-divider" />
      <h3>连接的能力</h3>
      <div className="capability">
        <span className="capability-icon blue">
          <ScanText size={17} />
        </span>
        <div>
          <strong>本地文字识别</strong>
          <p>RapidOCR · 中英文与坐标</p>
        </div>
        <Check size={14} className="green" />
      </div>
      <button className="capability capability-button" onClick={onModels}>
        <span className="capability-icon violet">
          <Cloud size={17} />
        </span>
        <div>
          <strong>云端模型</strong>
          <p>{hasKey ? '已保存模型凭据' : '添加你的 API Key'}</p>
        </div>
        <span className={hasKey ? 'green' : 'muted'}>
          {hasKey ? <Check size={14} /> : <ArrowUpRight size={14} />}
        </span>
      </button>
      <div className="capability">
        <span className="capability-icon teal">
          <Cpu size={17} />
        </span>
        <div>
          <strong>端侧推理</strong>
          <p>
            {connected
              ? device.qwenReady
                ? 'Qwen3.5-9B · 已部署'
                : '等待板端模型部署'
              : '连接设备后检查'}
          </p>
        </div>
      </div>
      <div className="local-note">
        <ShieldCheck size={18} />
        <div>
          <strong>数据留在你的桌面</strong>
          <p>图片在本机识别。只有主动运行云端任务时，相关文字才发送到所选模型。</p>
        </div>
      </div>
    </aside>
  )
}
