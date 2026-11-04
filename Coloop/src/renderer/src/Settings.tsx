import { useState } from 'react'
import {
  ArrowDownToLine,
  Cable,
  CheckCircle2,
  ChevronRight,
  Cloud,
  Cpu,
  Eye,
  EyeOff,
  Fingerprint,
  KeyRound,
  LoaderCircle,
  Plug,
  RefreshCw,
  Save,
  ShieldCheck,
  Unplug,
  Wifi,
  Zap,
  Network,
  BrainCircuit,
  Sparkle,
  type LucideIcon,
} from 'lucide-react'
import type { AppSnapshot, ProviderConfig, Settings, SettingsInput } from '../../shared/contracts'
import { BoardIllustration } from './components'
import { api, unwrap } from './api'

interface Props {
  snapshot: AppSnapshot
  notify: (message: string, error?: boolean) => void
  onSaved: (settings: Settings) => void
}
function initialForm(settings: Settings): SettingsInput {
  const { hasKey: _key, ...provider } = settings.provider
  return { ...settings, provider }
}
const presets: {
  protocol: ProviderConfig['protocol']
  name: string
  baseUrl: string
  model: string
  description: string
  mark: LucideIcon
}[] = [
  {
    protocol: 'openai',
    name: 'OpenAI 兼容服务',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4.1-mini',
    description: 'OpenAI、DeepSeek、Qwen 等',
    mark: Network,
  },
  {
    protocol: 'anthropic',
    name: 'Anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    model: 'claude-sonnet-4-5',
    description: 'Claude Messages API',
    mark: BrainCircuit,
  },
  {
    protocol: 'gemini',
    name: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    model: 'gemini-2.5-flash',
    description: 'Gemini GenerateContent API',
    mark: Sparkle,
  },
]
export function ModelsPage({ snapshot, notify, onSaved }: Props) {
  const [form, setForm] = useState(() => initialForm(snapshot.settings))
  const [key, setKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [dirty, setDirty] = useState(false)
  const changeProvider = (patch: Partial<ProviderConfig>) => {
    setForm((v) => ({ ...v, provider: { ...v.provider, ...patch } }))
    setDirty(true)
  }
  async function save() {
    setSaving(true)
    try {
      const result = await unwrap(
        api.saveSettings({ ...form, provider: { ...form.provider, apiKey: key || undefined } }),
      )
      onSaved(result)
      setForm(initialForm(result))
      setKey('')
      setDirty(false)
      notify('模型配置已保存')
    } catch (error) {
      notify((error as Error).message, true)
    } finally {
      setSaving(false)
    }
  }
  return (
    <div className="page-content settings-content">
      <div className="page-title-row">
        <div>
          <h1>模型连接</h1>
          <p>配置服务地址、模型和访问凭据。</p>
        </div>
        <span className={`badge ${snapshot.settings.provider.hasKey ? 'green' : ''}`}>
          <KeyRound size={13} />
          {snapshot.settings.provider.hasKey ? '凭据已加密' : '等待配置'}
        </span>
      </div>
      <div className="provider-grid">
        {presets.map((preset) => (
          <button
            key={preset.protocol}
            className={`provider-card ${form.provider.protocol === preset.protocol ? 'selected' : ''}`}
            onClick={() => {
              changeProvider({
                protocol: preset.protocol,
                name: preset.name,
                baseUrl: preset.baseUrl,
                model: preset.model,
              })
              setKey('')
            }}
          >
            <span className={`provider-mark ${preset.protocol}`}>
              <preset.mark size={22} />
            </span>
            <strong>{preset.name}</strong>
            <small>{preset.description}</small>
            {form.provider.protocol === preset.protocol && (
              <CheckCircle2 className="provider-check" size={17} />
            )}
          </button>
        ))}
      </div>
      <section className="panel settings-panel">
        <div className="section-bar">
          <div>
            <h2>服务配置</h2>
            <p className="muted">支持自定义地址与模型，不绑定服务商。</p>
          </div>
          <span className="quiet-tag">
            {form.provider.protocol === 'openai'
              ? 'Chat Completions'
              : form.provider.protocol === 'anthropic'
                ? 'Messages'
                : 'GenerateContent'}
          </span>
        </div>
        <div className="form-grid">
          <label>
            连接名称
            <input
              value={form.provider.name}
              onChange={(e) => changeProvider({ name: e.target.value })}
              maxLength={80}
            />
          </label>
          <label>
            模型名称
            <input
              value={form.provider.model}
              onChange={(e) => changeProvider({ model: e.target.value })}
              maxLength={120}
              placeholder="填写服务商支持的模型 ID"
            />
          </label>
          <label className="span-two">
            服务地址
            <input
              aria-label="服务地址"
              value={form.provider.baseUrl}
              onChange={(e) => changeProvider({ baseUrl: e.target.value })}
              maxLength={500}
              spellCheck={false}
            />
            <small>
              填写到版本前缀，例如 https://api.deepseek.com/v1；本地 Ollama 可填
              http://localhost:11434/v1。
            </small>
          </label>
          <label className="span-two">
            API Key
            <div className="secret-input">
              <input
                autoComplete="off"
                type={showKey ? 'text' : 'password'}
                placeholder={
                  snapshot.settings.provider.hasKey
                    ? '已保存加密凭据，留空保留'
                    : '粘贴你的 API Key'
                }
                value={key}
                onChange={(e) => {
                  setKey(e.target.value)
                  setDirty(true)
                }}
                maxLength={2048}
              />
              <button
                className="icon-button"
                onClick={() => setShowKey(!showKey)}
                aria-label={showKey ? '隐藏密钥' : '显示密钥'}
              >
                {showKey ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
            <small>
              更换服务地址或协议时，需要重新输入 Key。Key 不会返回到界面或写入运行历史。
            </small>
          </label>
        </div>
        <div className="settings-actions">
          <span>{dirty ? '有未保存的更改' : '配置已同步'}</span>
          <div className="row">
            <button
              className="button secondary"
              disabled={testing || dirty || saving}
              onClick={() => {
                setTesting(true)
                void unwrap(api.testProvider())
                  .then((result) => notify(result))
                  .catch((e) => notify(e.message, true))
                  .finally(() => setTesting(false))
              }}
            >
              {testing ? <LoaderCircle size={15} className="spin" /> : <Zap size={15} />}测试连接
            </button>
            <button
              className="button primary"
              disabled={saving || testing}
              onClick={() => void save()}
            >
              {saving ? <LoaderCircle size={15} className="spin" /> : <Save size={15} />}保存配置
            </button>
          </div>
        </div>
      </section>
      <section className="settings-note">
        <ShieldCheck size={22} />
        <div>
          <h3>自己的模型，自己的数据</h3>
          <p>
            API Key 使用 Windows 凭据加密。请求直接发往你配置的服务地址；任务内容与相关 OCR
            文本会交给该服务处理。Coloop 不设中转服务器。
          </p>
          <p>当前每个工作区使用一个云端连接。模型名称是可编辑示例，实际可用性以服务商账户为准。</p>
          {snapshot.settings.provider.hasKey && (
            <button
              className="text-button danger"
              disabled={saving || dirty}
              onClick={() => {
                setSaving(true)
                void unwrap(
                  api.saveSettings({ ...form, provider: { ...form.provider, clearKey: true } }),
                )
                  .then((result) => {
                    onSaved(result)
                    notify('保存的 API Key 已移除')
                  })
                  .catch((e) => notify(e.message, true))
                  .finally(() => setSaving(false))
              }}
            >
              移除已保存的 Key
            </button>
          )}
        </div>
      </section>
      <section className="panel ocr-settings">
        <div>
          <h3>本地 OCR 环境</h3>
          <p>复用已安装的 RapidOCR + PP-OCRv5，返回中英文文字与坐标。修改后点击上方保存配置。</p>
        </div>
        <input
          aria-label="RK 项目路径"
          value={form.ocrWorkspace}
          onChange={(e) => {
            setForm((v) => ({ ...v, ocrWorkspace: e.target.value }))
            setDirty(true)
          }}
        />
      </section>
    </div>
  )
}

export function DevicePage({ snapshot, notify, onSaved }: Props) {
  const [form, setForm] = useState(() => initialForm(snapshot.settings))
  const [password, setPassword] = useState('')
  const [saving, setSaving] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [startingService, setStartingService] = useState(false)
  const [dirty, setDirty] = useState(false)
  const device = snapshot.device
  const connected = device.status === 'connected'
  const busy = connecting || device.status === 'connecting' || startingService
  const rkRunning = snapshot.tasks.some((task) => task.status === 'running')
  async function save() {
    setSaving(true)
    try {
      const result = await unwrap(api.saveSettings(form))
      onSaved(result)
      setDirty(false)
      notify('设备配置已保存')
    } catch (error) {
      notify((error as Error).message, true)
    } finally {
      setSaving(false)
    }
  }
  return (
    <div className="page-content settings-content">
      <div className="page-title-row">
        <div>
          <h1>设备管理</h1>
          <p>通过 USB 网络连接开发板，查看状态与端侧能力。</p>
        </div>
        <button
          className="button secondary"
          disabled={saving || busy || rkRunning}
          onClick={() => {
            setSaving(true)
            void unwrap(api.importRk())
              .then((settings) => {
                setForm(initialForm(settings))
                onSaved(settings)
                setDirty(false)
                notify('已导入 D:\\RK 的设备连接配置')
              })
              .catch((e) => notify(e.message, true))
              .finally(() => setSaving(false))
          }}
        >
          <ArrowDownToLine size={15} />
          导入 RK 配置
        </button>
      </div>
      <section className="device-overview panel">
        <div className="device-overview-art">
          <BoardIllustration />
        </div>
        <div className="device-overview-info">
          <span className={`connection-pill ${connected ? 'online' : ''}`}>
            <i />
            {connected ? '设备已连接' : busy ? '正在连接' : '设备未连接'}
          </span>
          <h2>LubanCat 4</h2>
          <p>Rockchip RK3588 · USB RNDIS 网络</p>
          <div className="device-tags">
            <span>
              <Cpu size={13} />
              端侧 NPU
            </span>
            <span>
              <Cable size={13} />
              SSH 加密通道
            </span>
            <span>
              <Fingerprint size={13} />
              固定设备指纹
            </span>
          </div>
        </div>
        <div className="device-metrics">
          <div>
            <span>
              {connected ? ((device.memoryTotalMb || 0) / 1024).toFixed(1) : '—'}
              <small>GB</small>
            </span>
            <p>总内存</p>
          </div>
          <div>
            <span>
              {connected ? device.temperatureC?.toFixed(1) || '—' : '—'}
              <small>°C</small>
            </span>
            <p>设备温度</p>
          </div>
        </div>
      </section>
      {device.error && (
        <div className="inline-error device-error" role="alert">
          {device.error}
        </div>
      )}
      <section className="panel settings-panel">
        <div className="section-bar">
          <div>
            <h2>USB 连接设置</h2>
            <p className="muted">连接一次后自动重连，登录凭据由 Windows 加密保存在本机。</p>
          </div>
          <Cable size={21} className="muted" />
        </div>
        <div className="form-grid">
          <label>
            设备地址
            <input
              disabled={busy || rkRunning}
              value={form.board.host}
              onChange={(e) => {
                setForm((v) => ({ ...v, board: { ...v.board, host: e.target.value } }))
                setDirty(true)
              }}
            />
          </label>
          <div className="split-fields">
            <label>
              SSH 端口
              <input
                disabled={busy || rkRunning}
                type="number"
                min={1}
                max={65535}
                value={form.board.port}
                onChange={(e) => {
                  setForm((v) => ({ ...v, board: { ...v.board, port: Number(e.target.value) } }))
                  setDirty(true)
                }}
              />
            </label>
            <label>
              用户名
              <input
                disabled={busy || rkRunning}
                value={form.board.username}
                onChange={(e) => {
                  setForm((v) => ({ ...v, board: { ...v.board, username: e.target.value } }))
                  setDirty(true)
                }}
              />
            </label>
          </div>
          <label className="span-two">
            端侧服务目录
            <input
              disabled={busy || rkRunning}
              value={form.board.serviceDirectory ?? '~/rk-opencode'}
              onChange={(e) => {
                setForm((v) => ({
                  ...v,
                  board: { ...v.board, serviceDirectory: e.target.value },
                }))
                setDirty(true)
              }}
              spellCheck={false}
            />
            <small>开发板上已部署的 RK 模型服务目录。</small>
          </label>
          <label>
            端侧服务端口
            <input
              disabled={busy || rkRunning}
              type="number"
              min={1}
              max={65535}
              value={form.board.servicePort ?? 8088}
              onChange={(e) => {
                setForm((v) => ({
                  ...v,
                  board: { ...v.board, servicePort: Number(e.target.value) },
                }))
                setDirty(true)
              }}
            />
            <small>经当前 SSH 连接访问开发板本机服务。</small>
          </label>
          <label className="span-two">
            设备 SHA256 指纹
            <input
              className="mono"
              disabled={busy || rkRunning}
              value={form.board.fingerprint}
              onChange={(e) => {
                setForm((v) => ({ ...v, board: { ...v.board, fingerprint: e.target.value } }))
                setDirty(true)
              }}
              spellCheck={false}
            />
            <small>从 RK 项目已验证的连接配置导入。设备身份不匹配时会拒绝连接。</small>
          </label>
          <label className="span-two">
            SSH 密码
            <input
              type="password"
              disabled={busy || rkRunning}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="off"
              placeholder="输入开发板的 SSH 登录密码"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !dirty && !busy && !connected && !saving && !rkRunning) {
                  setConnecting(true)
                  const value = password
                  setPassword('')
                  void unwrap(api.connect(value))
                    .then(() => notify('RK 设备已连接'))
                    .catch((error) => notify(error.message, true))
                    .finally(() => setConnecting(false))
                }
              }}
            />
            <small>连接成功后由 Windows 加密保存，用于启动自动连接和断线重连。</small>
          </label>
        </div>
        <div className="settings-actions">
          <span>
            {dirty
              ? '请先保存修改，再连接设备'
              : connected
                ? `最近更新：${device.updatedAt ? new Date(device.updatedAt).toLocaleTimeString('zh-CN') : '—'}`
                : (snapshot.autoConnection?.message ?? '需要设备正常供电，USB 线连接 OTG 口')}
          </span>
          <div className="row">
            {!connected && snapshot.autoConnection?.hasCredential && (
              <button
                className="button secondary"
                disabled={busy || saving || rkRunning}
                onClick={() =>
                  void unwrap(api.retryRkConnection()).catch((error) => notify(error.message, true))
                }
              >
                自动重新连接
              </button>
            )}
            {dirty && (
              <button
                className="button secondary"
                disabled={saving || busy || rkRunning}
                onClick={() => void save()}
              >
                <Save size={15} />
                保存设置
              </button>
            )}
            {connected ? (
              <>
                <button
                  className="icon-button"
                  aria-label="刷新设备状态"
                  disabled={refreshing || busy}
                  onClick={() => {
                    setRefreshing(true)
                    void unwrap(api.refreshDevice())
                      .catch((e) => notify(e.message, true))
                      .finally(() => setRefreshing(false))
                  }}
                >
                  <RefreshCw size={16} className={refreshing ? 'spin' : ''} />
                </button>
                <button
                  className="button secondary"
                  disabled={busy || rkRunning}
                  onClick={() =>
                    void unwrap(api.disconnect())
                      .then(() => notify('设备已断开'))
                      .catch((e) => notify(e.message, true))
                  }
                >
                  <Unplug size={15} />
                  断开连接
                </button>
              </>
            ) : (
              <button
                className="button primary"
                disabled={busy || dirty || saving || rkRunning}
                onClick={() => {
                  setConnecting(true)
                  const value = password
                  setPassword('')
                  void unwrap(api.connect(value))
                    .then(() => notify('RK 设备已连接'))
                    .catch((e) => notify(e.message, true))
                    .finally(() => setConnecting(false))
                }}
              >
                {busy ? <LoaderCircle size={15} className="spin" /> : <Plug size={15} />}连接设备
              </button>
            )}
          </div>
        </div>
      </section>
      <div className="device-bottom-grid">
        <section className="panel">
          <h3>端侧能力</h3>
          <div className="device-cap-row">
            <Cpu size={19} />
            <div>
              <strong>{device.model || 'Qwen3.5-4B'}</strong>
              <p>
                {connected
                  ? device.qwenReady
                    ? '端侧服务已就绪，可在工作台选择 RK 端侧模型'
                    : device.modelServiceStatus === 'error'
                      ? '端侧服务异常，请检查下方提示后重试'
                      : 'SSH 已连接，端侧服务尚未启动'
                  : '连接设备后自动检查端侧服务'}
              </p>
              {connected && (device.modelContext || device.modelRuntime) && (
                <p className="muted">
                  {[
                    device.modelContext ? `上下文 ${device.modelContext} tokens` : '',
                    device.modelRuntime ? `运行库 ${device.modelRuntime}` : '',
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
              )}
            </div>
          </div>
          {connected && device.modelServiceError && (
            <div className="inline-error" role="alert">
              {device.modelServiceError}
            </div>
          )}
          {connected && !device.qwenReady && (
            <button
              className="button primary"
              disabled={busy || dirty || saving || rkRunning}
              onClick={() => {
                setStartingService(true)
                void unwrap(api.startRkService())
                  .then((result) => {
                    if (!result.qwenReady)
                      throw new Error(result.modelServiceError || '端侧服务尚未就绪，请刷新后重试')
                    notify('端侧服务已就绪')
                  })
                  .catch((error) => notify(error.message, true))
                  .finally(() => setStartingService(false))
              }}
            >
              {startingService ? <LoaderCircle size={15} className="spin" /> : <Cpu size={15} />}
              {startingService ? '正在启动端侧服务' : '启动端侧服务'}
            </button>
          )}
          <p className="muted">模型回答完成后返回。停止等待不会终止板端共享推理。</p>
        </section>
        <section className="panel">
          <h3>连接检查</h3>
          <ol className="connection-checks">
            <li>
              <span>1</span>使用数据线连接开发板 OTG 接口
            </li>
            <li>
              <span>2</span>确认 Windows 出现 RNDIS 网络适配器
            </li>
            <li>
              <span>3</span>导入配置并输入开发板 SSH 密码
            </li>
          </ol>
          <p className="muted">正常开机不按 MR 键。当前不需要串口或刷机模式。</p>
        </section>
      </div>
    </div>
  )
}
