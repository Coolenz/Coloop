import { Cable, CheckCircle2, Clock3, Cpu, LockKeyhole, ShieldCheck, XCircle } from 'lucide-react'
import type { AppSnapshot } from '../../shared/contracts'
import { time } from './components'
import './coordinator.css'
import { HookStatus } from './HookStatus'
import { SessionControlPanel } from './SessionControlPanel'
import { MobileRemotePanel } from './MobileRemotePanel'

const decisions = { allow: '允许一次', deny: '拒绝', select: '选择安全项', defer: '暂缓处理' }

export function CoordinatorPage({ snapshot }: { snapshot: AppSnapshot }) {
  const state = snapshot.coordinator
  const listening = state?.status !== 'stopped' && !!state?.url
  const ready = listening && snapshot.device.qwenReady && snapshot.device.modelPrivacyReady
  const command =
    'D:\\RK\\.venv\\Scripts\\python.exe D:\\RK\\tools\\coloop_agent.py opencode --url http://127.0.0.1:4096 --directory D:\\RK'
  return (
    <div className="page-content coordination-page">
      <div className="page-title-row">
        <div>
          <h1>Agent 协调</h1>
          <p>管理电脑 AI 会话，并连接安卓手机。</p>
        </div>
        <span className="badge">
          <LockKeyhole size={14} />
          {snapshot.mobile?.tunnel.status === 'online' ? '手机加密通道已开启' : '本地会话通道'}
        </span>
      </div>
      <MobileRemotePanel snapshot={snapshot} />
      <section className="coordination-status" aria-label="协调状态">
        <ShieldCheck size={27} aria-hidden="true" />
        <div>
          <h2>
            {state?.reviewing
              ? 'RK 正在分析审批请求'
              : ready
                ? '可以接收 Agent 请求'
                : '协调通道等待就绪'}
          </h2>
          <p role="status">
            {state?.error ||
              (!listening
                ? '本地服务尚未启动，请重启 Coloop。'
                : !snapshot.device.qwenReady
                  ? '请在设备管理连接 RK，并启动已有模型服务。'
                  : !snapshot.device.modelPrivacyReady
                    ? '板端服务需要启用审批日志隐私保护，再刷新设备状态。'
                    : '原请求复查 · 隐私规则约束 · 安全选项自动回复')}
          </p>
        </div>
      </section>
      <dl className="coordination-facts">
        <div>
          <dt>
            <Cable size={15} />
            事件接收
          </dt>
          <dd>{listening ? state?.url : '未监听'}</dd>
        </div>
        <div>
          <dt>
            <Cpu size={15} />
            分析模型
          </dt>
          <dd>{snapshot.device.qwenReady ? 'RK · Qwen3.5-4B' : 'RK 未就绪'}</dd>
        </div>
        <div>
          <dt>
            <LockKeyhole size={15} />
            数据路径
          </dt>
          <dd>本机 → 固定指纹 SSH → RK</dd>
        </div>
      </dl>
      <SessionControlPanel snapshot={snapshot} />
      <HookStatus snapshot={snapshot} />
      <section className="coordination-section">
        <h2>兼容旧版轮询适配器</h2>
        <p>
          原生 Hook 直接推送事件。已有本机 OpenCode 服务也可继续使用轮询适配器：先启动 OpenCode
          服务，再运行适配器；它会复查待处理请求并返回本次选择。旧版适配器的读取许可仍保留建议。
          上方受控启动器支持 RK 审批后的单次快照读取，使用独立的本地模型和权限配置。
        </p>
        <pre className="coordination-command">
          <code>{command}</code>
        </pre>
        <p className="muted">
          连接凭据保存在当前 Windows 用户专属目录，界面不展示令牌。其他 Agent
          可通过同一鉴权接口接入；当前尚未接入 Codex 桌面原生审批。
        </p>
      </section>
      <section className="coordination-section">
        <h2>自动选择的边界</h2>
        <ul className="coordination-rules">
          <li>
            <CheckCircle2 size={17} />
            <span>
              受控读取先扫描并冻结快照，经 RK
              审批后仅释放本次内容；也可自动选择明确的离线或取消选项。
            </span>
          </li>
          <li>
            <XCircle size={17} />
            <span>规则拦截检测到的凭据、个人信息和危险操作。审批正文不进入普通任务历史。</span>
          </li>
          <li>
            <Clock3 size={17} />
            <span>
              受控读取无法确认安全时自动拒绝；普通接口可保留等待。许可限本次使用，不签发永久授权。
            </span>
          </li>
        </ul>
      </section>
      <section className="coordination-section" aria-label="审批审计">
        <div className="section-bar">
          <h2>最近判断</h2>
          <span className="muted">仅保存摘要、结果与原因码</span>
        </div>
        {state?.audit.length ? (
          <div className="coordination-audit">
            {state.audit.map((entry, index) => (
              <div className="coordination-audit-row" key={`${entry.requestHash}-${index}`}>
                <div>
                  <strong>{decisions[entry.decision]}</strong>
                  <span>
                    {entry.kind === 'permission' ? '权限请求' : '选项判断'} ·{' '}
                    {entry.source === 'rk' ? 'RK 分析' : '本地策略'}
                  </span>
                </div>
                <code title={entry.reasonCode}>{entry.reasonCode}</code>
                <time dateTime={entry.at}>{time(entry.at)}</time>
              </div>
            ))}
          </div>
        ) : (
          <p className="coordination-empty">
            尚无审批请求。接入 Agent 后，这里会显示每次判断的结果，不展示原始内容。
          </p>
        )}
      </section>
    </div>
  )
}
