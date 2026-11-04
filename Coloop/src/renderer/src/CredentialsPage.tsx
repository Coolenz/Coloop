import { useEffect, useState, type FormEvent } from 'react'
import { KeyRound, LoaderCircle, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react'
import type { AppSnapshot } from '../../shared/contracts'
import type { CredentialRecord } from '../../shared/credentials'
import { api, unwrap } from './api'
import './credentials.css'

export function CredentialsPage({ snapshot }: { snapshot: AppSnapshot }) {
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [records, setRecords] = useState<CredentialRecord[]>([])
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [deleting, setDeleting] = useState<string>()
  const connected = snapshot.device.status === 'connected'
  async function refresh() {
    setRecords(await unwrap(api!.listCredentials()))
  }
  useEffect(() => {
    let alive = true
    void unwrap(api!.protectCredentials(true))
      .then(async () => {
        if (!alive) return
        setReady(true)
        try {
          if (connected) await refresh()
        } catch (e) {
          if (alive) setError((e as Error).message)
        }
      })
      .catch((e) => {
        if (alive) setError(e.message)
      })
    return () => {
      alive = false
      void api!.protectCredentials(false)
    }
  }, [])
  async function action(work: () => Promise<void>) {
    if (busy) return
    setBusy(true)
    setError('')
    setMessage('')
    try {
      await work()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const data = new FormData(form)
    const input = {
      origin: String(data.get('origin')),
      username: String(data.get('username')),
      password: String(data.get('password')),
    }
    form.reset()
    await action(async () => {
      await unwrap(api!.createCredential(input))
      await refresh()
      setMessage('已保存到 RK。账号和密码不会显示在列表中。')
    })
  }
  return (
    <div className="page-content credentials-content">
      <div className="page-title-row">
        <div>
          <h1>私密凭据</h1>
          <p>保存在 RK，在专用窗口中填入登录信息。</p>
        </div>
        <span className="badge">
          <ShieldCheck size={14} />
          {ready ? '截图与 OCR 已暂停' : '正在准备保护'}
        </span>
      </div>
      <p className="credential-protection">
        账号密码不进入对话、自动记忆或云端 AI。登录网站会接收你提交的登录信息。
      </p>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="credential-message">
          {message}
        </p>
      )}
      {!connected && (
        <p className="inline-warning">
          请先在「设备管理」连接 RK，再返回此页。凭据服务不需要启动模型。
        </p>
      )}
      <section className="panel settings-panel">
        <div className="section-bar">
          <div>
            <h2>保存一组凭据</h2>
            <p className="muted">账号和密码仅支持 1–64 个英文、数字和键盘符号，按原样保存。</p>
          </div>
          <KeyRound size={20} />
        </div>
        <form onSubmit={(event) => void save(event)} autoComplete="off">
          <fieldset disabled={!ready || !connected || busy || snapshot.credentials?.loginOpen}>
            <div className="form-grid">
              <label className="span-two">
                允许的网站
                <input
                  name="origin"
                aria-label="允许的网站"
                  type="url"
                  required
                  maxLength={500}
                  placeholder="https://example.com"
                  autoComplete="off"
                />
                <small>填写 HTTPS 网站源，不含 /login 等路径。其他网站无法使用这条记录。</small>
              </label>
              <label>
                账号
                <input
                  name="username"
                  required
                  maxLength={64}
                  pattern="[ -~]+"
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
              <label>
                密码
                <input
                  name="password"
                  type="password"
                  required
                  maxLength={64}
                  pattern="[ -~]+"
                  autoComplete="new-password"
                />
              </label>
            </div>
            <div className="credential-form-footer">
              <span className="muted">保存后清空输入，列表只显示网站与记录编号。</span>
              <button className="button primary" type="submit">
                {busy && <LoaderCircle className="spin" size={15} />}保存到 RK
              </button>
            </div>
          </fieldset>
        </form>
      </section>
      <section className="credential-records" aria-label="凭据记录">
        <div className="section-bar">
          <h2>已保存的凭据</h2>
          <button
            className="button"
            disabled={!ready || !connected || busy}
            onClick={() => void action(refresh)}
          >
            <RefreshCw size={14} />
            刷新列表
          </button>
        </div>
        {!records.length ? (
          <div className="credential-empty">
            <KeyRound size={23} />
            <h3>{connected ? '还没有凭据记录' : '连接 RK 后查看记录'}</h3>
            <p>在上方保存一组账号密码，然后打开专用登录窗口。</p>
          </div>
        ) : (
          <ul className="credential-list">
            {records.map((record) => (
              <li key={record.id}>
                <div className="credential-record-label">
                  <strong>{record.origin}</strong>
                  <span>记录编号：{record.id}</span>
                </div>
                <div className="credential-row-actions">
                  {deleting === record.id ? (
                    <>
                      <span>删除这条记录？</span>
                      <button
                        className="button"
                        disabled={busy}
                        onClick={() => setDeleting(undefined)}
                      >
                        取消
                      </button>
                      <button
                        className="button"
                        disabled={busy}
                        onClick={() =>
                          void action(async () => {
                            await unwrap(api!.deleteCredential(record.id))
                            setDeleting(undefined)
                            await refresh()
                          })
                        }
                      >
                        确认删除
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        className="button primary"
                        disabled={!ready || !connected || busy || snapshot.credentials?.loginOpen}
                        onClick={() =>
                          void action(async () => {
                            await unwrap(api!.openCredentialLogin(record.id))
                          })
                        }
                      >
                        打开登录窗口
                      </button>
                      <button
                        className="icon-button"
                        aria-label={`删除 ${record.id}`}
                        disabled={busy || snapshot.credentials?.loginOpen}
                        onClick={() => setDeleting(record.id)}
                      >
                        <Trash2 size={16} />
                      </button>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
      <p className="muted credential-footnote">
        专用窗口只允许该网站的同源 HTTPS
        请求。跨域跳转、外部弹窗与第三方资源暂不支持。关闭窗口并离开此页后恢复 Coloop 截图。
      </p>
    </div>
  )
}
