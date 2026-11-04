import { useState, type FormEvent } from 'react'
import { LoaderCircle, ShieldCheck } from 'lucide-react'
import './credentials.css'

export function PrivateMemoryEntry() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState<string>()
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy || saved) return
    const form = event.currentTarget
    const values = new FormData(form)
    const input = {
      origin: String(values.get('origin') ?? ''),
      username: String(values.get('username') ?? ''),
      password: String(values.get('password') ?? ''),
    }
    form.reset()
    setBusy(true)
    setError('')
    try {
      const result = await window.coloopPrivateEntry!.save(input)
      if (!result.ok) throw new Error('保存未完成，请检查 RK 连接和网站格式后重新填写。')
      setSaved(
        result.indexed
          ? '私密记忆已保存，统一目录已同步。'
          : '凭据已保存，目录暂未同步。请刷新目录核对，勿重复保存。',
      )
    } catch {
      setError('保存未完成，请检查 RK 连接和网站格式后重新填写。')
    } finally {
      setBusy(false)
    }
  }
  async function close() {
    try {
      await window.coloopPrivateEntry!.close()
    } catch {
      setError('窗口未能关闭，请使用标题栏关闭按钮。')
    }
  }
  return (
    <main className="private-entry-content credentials-content">
      <h1>新建私密记忆</h1>
      <p className="credential-protection">
        <ShieldCheck size={16} /> 账号密码仅保存在 RK。填写期间 Coloop 截图、OCR 与模型任务已暂停。
      </p>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      {saved ? (
        <p role="status">{saved}</p>
      ) : (
        <form onSubmit={(event) => void save(event)} autoComplete="off">
          <fieldset disabled={busy}>
            <div className="form-grid">
              <label className="span-two">
                允许的网站
                <input
                  aria-label="允许的网站"
                  name="origin"
                  type="url"
                  required
                  maxLength={500}
                  placeholder="https://example.com"
                />
                <small>填写 HTTPS 网站源，不含 /login 等路径。</small>
              </label>
              <label>
                账号
                <input
                  aria-label="账号"
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
                  aria-label="密码"
                  name="password"
                  type="password"
                  required
                  maxLength={64}
                  pattern="[ -~]+"
                  autoComplete="new-password"
                />
              </label>
            </div>
            <p className="muted credential-footnote">
              每字段支持 1–64 个英文、数字与键盘符号。保存后清空输入；目录仅保留网站与记录编号。
            </p>
          </fieldset>
          <div className="credential-form-footer">
            <button className="button" type="button" onClick={() => void close()}>
              关闭填写窗口
            </button>
            <button className="button primary" type="submit" disabled={busy}>
              {busy && <LoaderCircle size={15} className="spin" />}保存私密记忆
            </button>
          </div>
        </form>
      )}
      {saved && (
        <button className="button primary" onClick={() => void close()}>
          完成并关闭
        </button>
      )}
    </main>
  )
}
