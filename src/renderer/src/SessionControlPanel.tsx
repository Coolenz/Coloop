import { useState } from 'react'
import { Eye, Monitor, RotateCcw, Send, Square, Unplug } from 'lucide-react'
import type { AppSnapshot } from '../../shared/contracts'
import { api, unwrap } from './api'
import './session-control.css'

const states: Record<string, string> = {
  idle: '空闲',
  running: '运行中',
  awaiting_input: '等待输入',
  error: '会话错误',
  closed: '已关闭',
}
const receipts: Record<string, string> = {
  queued: '等待发送',
  dispatched: '已下发，等待回执',
  accepted: '源会话已接受',
  confirmed: '源会话已确认',
  failed: '执行失败',
  unknown: '结果未确认',
  cancelled: '已撤销',
  expired: '已过期',
}

export function SessionControlPanel({ snapshot }: { snapshot: AppSnapshot }) {
  const control = snapshot.sessionControl
  const [selected, setSelected] = useState('')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const sessions = control?.sessions ?? []
  const windows = sessions.filter((item) => item.host === 'windows')
  const current = windows.find((item) => item.handle === selected) ?? windows[0]
  const pending = control?.commands.some(
    (item) =>
      item.sessionHandle === current?.handle &&
      !item.controlResolved &&
      ['queued', 'dispatched', 'accepted', 'unknown'].includes(item.status),
  )
  async function perform(action: () => Promise<unknown>, success?: string) {
    if (busy) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await action()
      if (success) setNotice(success)
    } catch (reason) {
      setError((reason as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const pluginRoot = snapshot.settings.ocrWorkspace.replace(/\\/g, '/').replace(/\/$/, '')
  const plugin = `file:///${pluginRoot}/rk-opencode/plugins/coloop-hook.mjs`
  const connection = snapshot.coordinator?.connectionPath ?? ''
  return (
    <section className="coordination-section session-control" aria-label="电脑会话控制">
      <div className="section-bar session-control-heading">
        <div>
          <h2>
            <Monitor size={18} aria-hidden="true" />
            电脑会话控制
          </h2>
          <p>向指定 AI 会话发送要求，并确认源会话的执行回执。</p>
        </div>
        <button
          className="button secondary"
          disabled={busy}
          onClick={() => void perform(() => unwrap(api.previewControlIndicator()))}
        >
          <Eye size={15} aria-hidden="true" />
          预览顶部提示
        </button>
      </div>
      {control?.stopped && (
        <div className="session-control-paused" role="status">
          <p>控制已停止。待发要求已撤销，重新允许后也不会补发旧指令。</p>
          <button
            className="button secondary"
            disabled={busy || !!control.unconfirmedCount}
            onClick={() =>
              void perform(() => unwrap(api.resumeSessionControl()), '已重新允许新的控制指令')
            }
          >
            <RotateCcw size={15} aria-hidden="true" />
            重新允许控制
          </button>
        </div>
      )}
      {!!control?.unconfirmedCount && (
        <p className="session-control-warning" role="status">
          有控制结果尚未确认，请检查源会话。不会自动重新发送要求。
        </p>
      )}
      {!!control?.journalError && (
        <p className="session-control-warning" role="alert">
          控制记录不可用，已阻止新的控制指令：{control.journalError}
        </p>
      )}
      {sessions.length ? (
        <div className="session-control-sessions" aria-label="已接入会话">
          {sessions.map((item) => (
            <div className="session-control-session" key={item.handle}>
              <div>
                <strong>{item.title || 'OpenCode 会话'}</strong>
                <span title={item.workspace}>{item.workspace}</span>
              </div>
              <span>
                {item.host === 'windows' ? '这台电脑' : item.host === 'rk' ? 'RK 设备' : '其他设备'}
              </span>
              <span className="session-control-state">
                {!item.connected ? (
                  <>
                    <Unplug size={13} aria-hidden="true" />
                    已离线
                  </>
                ) : item.stopping ? (
                  '等待停止确认'
                ) : item.controlActive ? (
                  'Coloop 正在控制'
                ) : (
                  (states[item.state] ?? item.state)
                )}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <p className="coordination-empty">
          尚未接入可控会话。连接带 Coloop 插件的 Windows OpenCode 后，会话会自动出现在这里。
        </p>
      )}
      {!!windows.length && (
        <form
          className="session-control-composer"
          onSubmit={(event) => {
            event.preventDefault()
            if (!current || !text.trim()) return
            void perform(async () => {
              await unwrap(
                api.controlSession({
                  commandId: crypto.randomUUID(),
                  sessionHandle: current.handle,
                  action: 'send_message',
                  text: text.trim(),
                }),
              )
              setText('')
            }, '要求已加入控制队列，等待源会话确认')
          }}
        >
          <label htmlFor="session-control-target">目标会话</label>
          <select
            id="session-control-target"
            value={current?.handle ?? ''}
            onChange={(event) => setSelected(event.target.value)}
            disabled={busy}
          >
            {windows.map((item) => (
              <option key={item.handle} value={item.handle}>
                {item.title || 'OpenCode 会话'}
                {item.connected ? '' : '（离线）'}
              </option>
            ))}
          </select>
          <label htmlFor="session-control-message">追加要求</label>
          <textarea
            id="session-control-message"
            rows={3}
            maxLength={2700}
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="例如：先完成修复并运行测试，暂时不要提交。"
            disabled={busy || control?.stopped}
          />
          <div className="session-control-actions">
            <span>控制期间，屏幕顶部会持续显示提示。</span>
            <button
              className="button secondary"
              type="button"
              disabled={busy || !control?.controlActive}
              onClick={() =>
                void perform(() => unwrap(api.stopSessionControl()), '已请求停止，等待源会话回执')
              }
            >
              <Square size={14} aria-hidden="true" />
              停止全部控制
            </button>
            <button
              className="button primary"
              type="submit"
              disabled={
                busy ||
                !text.trim() ||
                !current?.connected ||
                current.state !== 'idle' ||
                current.controlActive ||
                !current.capabilities.includes('send_message') ||
                control?.stopped ||
                pending
              }
            >
              <Send size={15} aria-hidden="true" />
              发送要求
            </button>
          </div>
        </form>
      )}
      {error && (
        <p className="session-control-feedback" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="session-control-feedback" role="status">
          {notice}
        </p>
      )}
      {!!control?.commands.length && (
        <div className="session-control-receipts" aria-label="最近控制回执">
          {control.commands.slice(0, 5).map((item) => (
            <div key={item.commandId}>
              <span>{item.action === 'send_message' ? '追加要求' : '停止当前执行'}</span>
              <strong>{receipts[item.status] ?? item.status}</strong>
              <time dateTime={item.updatedAt}>
                {new Date(item.updatedAt).toLocaleTimeString('zh-CN', { hour12: false })}
              </time>
            </div>
          ))}
          <p>消息确认表示要求已进入源会话；任务是否完成，仍以源执行结果为准。</p>
        </div>
      )}
      <details className="session-control-setup">
        <summary>接入 Windows OpenCode 1.19.5</summary>
        <p>在项目的 OpenCode 配置中加入以下插件路径，保留已有配置：</p>
        <pre>
          <code>{JSON.stringify({ plugin: [encodeURI(plugin)] }, null, 2)}</code>
        </pre>
        <p>在启动 OpenCode 的 PowerShell 终端设置连接文件，再启动该项目的会话：</p>
        <pre>
          <code>{`$env:COLOOP_HOOK_CONNECTION = '${connection.replace(/'/g, "''")}'\nopencode`}</code>
        </pre>
        <p>
          连接文件只供当前 Windows 用户使用。当前可信工作区为 {snapshot.settings.ocrWorkspace} 及
          Coloop 项目目录；其他工作区需要先在模型连接中配置。RK 会话目前仅供观察。
        </p>
      </details>
      <p className="session-control-residency">
        关闭主窗口后，Coloop 会在系统托盘驻留。右键托盘图标可以停止控制或退出。
      </p>
    </section>
  )
}
