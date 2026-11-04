import { useEffect, useState } from 'react'
import { KeyRound, LockKeyhole, ShieldCheck, X } from 'lucide-react'
import type { CredentialField, PrivateLoginState } from '../../shared/credentials'
import './credentials.css'

export function PrivateLogin() {
  const [state, setState] = useState<PrivateLoginState>()
  const [sending, setSending] = useState(false)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    const api = window.coloopPrivateLogin!
    void api
      .state()
      .then(setState)
      .catch(() => setFailed(true))
    return api.onChange(setState)
  }, [])
  async function fill(field: CredentialField) {
    if (sending || state?.busy) return
    setSending(true)
    try {
      setState(await window.coloopPrivateLogin!.fill(field))
    } catch {
      setFailed(true)
    } finally {
      setSending(false)
    }
  }
  return (
    <header className="private-login-toolbar">
      <div className="private-login-top">
        <div className="private-login-origin">
          <ShieldCheck size={20} />
          <div>
            <strong>{state?.origin ?? '正在准备私密登录…'}</strong>
            <small>Coloop 私密登录 · 截图与 OCR 已暂停</small>
          </div>
        </div>
        <div className="credential-row-actions">
          <button
            className="button"
            disabled={!state || sending || state.busy}
            onClick={() => void fill('username')}
          >
            <KeyRound size={15} />
            填入账号
          </button>
          <button
            className="button primary"
            disabled={!state || sending || state.busy}
            onClick={() => void fill('password')}
          >
            <LockKeyhole size={15} />
            填入密码
          </button>
          <button
            className="icon-button"
            aria-label="关闭登录窗口"
            onClick={() => void window.coloopPrivateLogin!.close()}
          >
            <X size={18} />
          </button>
        </div>
      </div>
      <p role="status">{failed ? '操作未完成，请关闭窗口后重新检查连接。' : state?.message}</p>
    </header>
  )
}
