import { Activity, Copy, LockKeyhole } from 'lucide-react'
import type { AppSnapshot } from '../../shared/contracts'
import { api, unwrap } from './api'

export function HookStatus({ snapshot }: { snapshot: AppSnapshot }) {
  const hooks = snapshot.hooks
  const samples = (hooks?.metrics ?? [])
    .filter((item) => item.state === 'approval.completed')
    .map((item) => item.hookToConsumedMs)
    .sort((a, b) => a - b)
  const p95 = samples.length ? samples[Math.ceil(samples.length * 0.95) - 1] : undefined
  const pending = (hooks?.metrics ?? []).filter(
    (item) => item.state !== 'approval.completed',
  ).length
  const command = snapshot.device.hookLauncher
    ? `bash '${snapshot.device.hookLauncher.replace(/'/g, `'\\''`)}'`
    : 'bash ~/rk-opencode/scripts/coloop-opencode.sh'
  return (
    <section className="coordination-section hook-status" aria-label="原生 Hook">
      <div className="section-bar">
        <h2>
          <Activity size={17} />
          原生 Hook
        </h2>
        <span className="muted">OpenCode 1.19.5 · 结构化事件</span>
      </div>
      <dl className="hook-facts">
        <div>
          <dt>已接收事件</dt>
          <dd>{hooks?.receivedEvents ?? 0}</dd>
        </div>
        <div>
          <dt>当前短期上下文</dt>
          <dd>
            {hooks?.sessionCount ?? 0} / 32 个任务 · {Math.ceil((hooks?.contextBytes ?? 0) / 1024)}{' '}
            KiB
          </dd>
        </div>
        <div>
          <dt>最近已消费审批 P95</dt>
          <dd>
            {p95 === undefined
              ? '尚无样本'
              : `${(p95 / 1000).toFixed(2)} 秒 · ${samples.length} 条${samples.length < 20 ? '（小样本）' : ''}`}
          </dd>
        </div>
        <div>
          <dt>事件校验</dt>
          <dd>
            {hooks?.duplicateEvents ?? 0} 条重复 · {hooks?.rejectedEvents ?? 0} 条拒绝
          </dd>
        </div>
      </dl>
      {!!hooks?.activityErrors && (
        <p role="alert" className="muted">
          前台租约登记失败 {hooks.activityErrors} 次；对应 RK 判断会保留等待，请检查设备连接。
        </p>
      )}
      {pending > 0 && (
        <p className="muted">另有 {pending} 条保留等待或失败回执；未计入已消费耗时。</p>
      )}
      <p className="muted">
        消息、工具结果和审批从 Agent 直接送达。按来源、会话和任务隔离；空闲五分钟过期，RK
        普通选择最多读取 192
        字节的任务状态投影。受控文件审批仅发送扫描结果；文件正文在许可通过后交给本地 Agent。
      </p>
      <div className="hook-memory-note">
        <LockKeyhole size={15} />
        <span>
          Hook
          内容只留内存，不自动写入长期记忆。审批前等待已开始的一次记忆整理结束，任务空闲后释放本次占用。
        </span>
      </div>
      {hooks?.sessions.length ? (
        <div className="hook-sessions">
          {hooks.sessions.slice(0, 4).map((item) => (
            <div className="hook-session" key={item.scopeId}>
              <div>
                <code>{item.taskIdHash.slice(0, 10)}</code>
                <span>
                  {item.state === 'busy' ? '运行中' : item.state === 'idle' ? '空闲' : item.state}
                </span>
                <span>
                  {item.contextEvents} 条 · {item.contextBytes} 字节
                </span>
              </div>
              <p>{item.excerpt || '已接收事件元数据'}</p>
            </div>
          ))}
        </div>
      ) : (
        <p className="coordination-empty">
          {hooks?.receivedEvents
            ? '当前没有活跃的 Hook 任务。已关闭任务的上下文不用于新审批。'
            : '尚未收到 Agent Hook。连接 RK 后，使用下方命令启动带 Hook 的开发会话。'}
        </p>
      )}
      <div className="hook-launch">
        <code>{command}</code>
        <button
          className="button secondary"
          disabled={!snapshot.device.hookRelayReady}
          onClick={() => {
            void unwrap(api.copyText(command)).catch(() => {})
          }}
          aria-label="复制 Hook 启动命令"
        >
          <Copy size={14} />
          复制命令
        </button>
      </div>
      <p className="muted">
        {snapshot.device.hookRelayReady
          ? '板端通道已就绪。在板端终端执行命令；正常退出会释放本会话的前台租约。'
          : '板端 Hook 通道尚未就绪。连接设备后检查插件源码与 SSH 转发。'}
      </p>
    </section>
  )
}
