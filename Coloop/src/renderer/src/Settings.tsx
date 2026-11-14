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
import { modelLimitsSchema, modelLimitMode } from '../../shared/model-usage'
import { cloudModelCapacity } from '../../shared/model-capacity'
import { legacyLocalCapacity, localCapacitySourceLabels } from '../../shared/local-model'
import './decision-model.css'

interface Props {
  snapshot: AppSnapshot
  notify: (message: string, error?: boolean) => void
  onSaved: (settings: Settings) => void
}
function initialForm(settings: Settings): SettingsInput {
  const { hasKey: _key, ...provider } = settings.provider
  const decisionProvider = settings.decisionProvider
    ? (({ hasKey: _decisionKey, ...value }) => value)(settings.decisionProvider)
    : undefined
  return { ...settings, provider, decisionProvider }
}
function imageCapability(provider: ProviderConfig, saved?: ProviderConfig) {
  const matches =
    saved &&
    (['protocol', 'baseUrl', 'model'] as const).every((field) => provider[field] === saved[field])
  return matches && saved.imageInput === 'supported'
    ? '图像探测通过'
    : matches && saved.imageInput === 'unsupported'
      ? '图像探测未通过'
      : '尚未探测'
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
function ModelCapacityFields({
  provider,
  onChange,
}: {
  provider: ProviderConfig
  onChange(patch: Partial<ProviderConfig>): void
}) {
  const capacity = cloudModelCapacity(provider)
  return (
    <div className="span-two">
      <p className="muted">
        上下文 {capacity.contextWindow.toLocaleString()} tokens · 默认输出{' '}
        {capacity.maxOutputTokens.toLocaleString()} tokens · {capacity.source}
      </p>
      {capacity.officialDeepSeek ? (
        <p className="muted">DeepSeek 使用 DSH 原生上下文计量、自动压缩、溢出恢复和检查点续跑。</p>
      ) : (
        <div className="form-grid">
          <label>
            服务商上下文容量（tokens）
            <input
              type="number"
              min={1024}
              max={10000000}
              placeholder={String(capacity.contextWindow)}
              value={provider.contextWindow ?? ''}
              onChange={(event) =>
                onChange({
                  contextWindow: event.target.value ? Number(event.target.value) : undefined,
                })
              }
            />
          </label>
          <label>
            服务商默认输出上限（tokens）
            <input
              type="number"
              min={1}
              max={capacity.maximumOutputTokens}
              placeholder={String(capacity.maxOutputTokens)}
              value={provider.maxOutputTokens ?? ''}
              onChange={(event) =>
                onChange({
                  maxOutputTokens: event.target.value ? Number(event.target.value) : undefined,
                })
              }
            />
          </label>
        </div>
      )}
    </div>
  )
}
export function ModelsPage({ snapshot, notify, onSaved }: Props) {
  const limits = modelLimitsSchema.parse(snapshot.settings.modelLimits ?? {})
  const [form, setForm] = useState(() => initialForm(snapshot.settings))
  const unlimited = modelLimitMode(form.modelLimits ?? limits) === 'unlimited'
  const [key, setKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [decisionKey, setDecisionKey] = useState('')
  const [showDecisionKey, setShowDecisionKey] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testingDecision, setTestingDecision] = useState(false)
  const [dirty, setDirty] = useState(false)
  const changeProvider = (patch: Partial<ProviderConfig>) => {
    setForm((v) => {
      const changed = (['model', 'baseUrl', 'protocol'] as const).some(
        (field) => patch[field] !== undefined && patch[field] !== v.provider[field],
      )
      return {
        ...v,
        provider: {
          ...v.provider,
          ...(changed ? { contextWindow: undefined, maxOutputTokens: undefined } : {}),
          ...patch,
        },
        modelLimits: changed
          ? {
              ...limits,
              ...v.modelLimits,
              inputYuanPerMillion: undefined,
              outputYuanPerMillion: undefined,
            }
          : v.modelLimits,
      }
    })
    setDirty(true)
  }
  const changeDecisionProvider = (patch: Partial<ProviderConfig>) => {
    setForm((previous) => {
      const provider = previous.decisionProvider ?? { ...previous.provider }
      const changed = (['model', 'baseUrl', 'protocol'] as const).some(
        (field) => patch[field] !== undefined && patch[field] !== provider[field],
      )
      return {
        ...previous,
        decisionProvider: {
          ...provider,
          ...(changed ? { contextWindow: undefined, maxOutputTokens: undefined } : {}),
          ...patch,
        },
        decisionPricing: changed ? undefined : previous.decisionPricing,
      }
    })
    setDirty(true)
  }
  async function save() {
    setSaving(true)
    try {
      const result = await unwrap(
        api.saveSettings({
          ...form,
          provider: { ...form.provider, apiKey: key || undefined },
          decisionProvider: form.decisionProvider
            ? { ...form.decisionProvider, apiKey: decisionKey || undefined }
            : undefined,
        }),
      )
      onSaved(result)
      setForm(initialForm(result))
      setKey('')
      setDecisionKey('')
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
          <ModelCapacityFields provider={form.provider} onChange={changeProvider} />
          <div className="image-capability">
            <span>图像输入能力</span>
            <output>{imageCapability(form.provider, snapshot.settings.provider)}</output>
            <small>由测试图验证。作为决策模型使用时，可在下方运行探测。</small>
          </div>
        </div>
        <div className="decision-model-section">
          <div className="section-bar">
            <div>
              <h3>Auto Agent Work 决策模型</h3>
              <p className="muted">用指定的强模型分析任务、参考记忆并决定下一步。</p>
            </div>
            <span className="quiet-tag">{form.decisionProvider ? '单独配置' : '复用日常模型'}</span>
          </div>
          <label className="decision-model-toggle">
            <input
              type="checkbox"
              checked={!!form.decisionProvider}
              onChange={(event) => {
                const enabled = event.target.checked
                setForm((previous) => ({
                  ...previous,
                  decisionProvider: enabled
                    ? (initialForm(snapshot.settings).decisionProvider ?? {
                        ...previous.provider,
                        name: 'Auto Agent Work 决策模型',
                        apiKey: undefined,
                        clearKey: undefined,
                      })
                    : undefined,
                  decisionPricing: enabled ? snapshot.settings.decisionPricing : undefined,
                }))
                setDecisionKey('')
                setDirty(true)
              }}
            />
            为 Auto Agent Work 单独指定模型
          </label>
          {form.decisionProvider ? (
            <div className="form-grid">
              <label>
                决策模型协议
                <select
                  value={form.decisionProvider.protocol}
                  onChange={(event) =>
                    changeDecisionProvider({
                      protocol: event.target.value as ProviderConfig['protocol'],
                    })
                  }
                >
                  <option value="openai">OpenAI 兼容</option>
                  <option value="anthropic">Anthropic</option>
                  <option value="gemini">Google Gemini</option>
                </select>
              </label>
              <label>
                决策连接名称
                <input
                  value={form.decisionProvider.name}
                  maxLength={80}
                  onChange={(event) => changeDecisionProvider({ name: event.target.value })}
                />
              </label>
              <label>
                决策模型名称
                <input
                  value={form.decisionProvider.model}
                  maxLength={120}
                  placeholder="填写强模型的模型 ID"
                  onChange={(event) => changeDecisionProvider({ model: event.target.value })}
                />
              </label>
              <div className="image-capability">
                <span>决策模型图像输入</span>
                <output>
                  {imageCapability(form.decisionProvider, snapshot.settings.decisionProvider)}
                </output>
                <small>保存后测试；仅发送无隐私的测试图。</small>
              </div>
              <label className="span-two">
                决策服务地址
                <input
                  value={form.decisionProvider.baseUrl}
                  maxLength={500}
                  spellCheck={false}
                  onChange={(event) => changeDecisionProvider({ baseUrl: event.target.value })}
                />
              </label>
              <label className="span-two">
                决策模型 API Key
                <div className="secret-input">
                  <input
                    aria-label="决策模型 API Key"
                    type={showDecisionKey ? 'text' : 'password'}
                    autoComplete="off"
                    value={decisionKey}
                    maxLength={2048}
                    placeholder={
                      snapshot.settings.decisionProvider?.hasKey
                        ? '已保存独立凭据，留空保留'
                        : '填写此连接的 API Key'
                    }
                    onChange={(event) => {
                      setDecisionKey(event.target.value)
                      setDirty(true)
                    }}
                  />
                  <button
                    className="icon-button"
                    onClick={() => setShowDecisionKey(!showDecisionKey)}
                    aria-label={showDecisionKey ? '隐藏决策模型密钥' : '显示决策模型密钥'}
                  >
                    {showDecisionKey ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
                <small>凭据单独加密保存。更换地址或协议后，需要重新输入。</small>
              </label>
              <ModelCapacityFields
                provider={form.decisionProvider}
                onChange={changeDecisionProvider}
              />
              {(['inputYuanPerMillion', 'outputYuanPerMillion'] as const).map((field) => (
                <label key={field}>
                  {field === 'inputYuanPerMillion'
                    ? '决策输入单价（元/百万 token）'
                    : '决策输出单价（元/百万 token）'}
                  <input
                    type="number"
                    min={0}
                    max={1000000}
                    step="any"
                    value={form.decisionPricing?.[field] ?? ''}
                    onChange={(event) => {
                      const value =
                        event.target.value === '' ? undefined : Number(event.target.value)
                      setForm((previous) => ({
                        ...previous,
                        decisionPricing: { ...previous.decisionPricing, [field]: value },
                      }))
                      setDirty(true)
                    }}
                  />
                </label>
              ))}
              <p className="span-two muted">
                单独统计此模型的费用；未填单价的请求显示为未定价，不计作免费。
              </p>
            </div>
          ) : (
            <p className="muted">
              Auto Agent Work 使用上方的日常模型，记忆检索和任务推进流程保持完整。
            </p>
          )}
          <div className="row decision-model-test">
            <button
              className="button secondary"
              disabled={testingDecision || testing || dirty || saving}
              onClick={() => {
                setTestingDecision(true)
                void unwrap(api.testDecisionProvider())
                  .then((result) => notify(result))
                  .catch((error) => notify(error.message, true))
                  .finally(() => setTestingDecision(false))
              }}
            >
              {testingDecision ? <LoaderCircle size={15} className="spin" /> : <Zap size={15} />}
              测试决策模型
            </button>
            {dirty && <span className="muted">先保存配置，再测试连接。</span>}
          </div>
        </div>
        <h3>模型调用限额</h3>
        <div className="row">
          {(['unlimited', 'custom'] as const).map((mode) => (
            <label key={mode}>
              <input
                type="radio"
                name="model-limit-mode"
                checked={modelLimitMode(form.modelLimits ?? limits) === mode}
                onChange={() => {
                  setForm((previous) => ({
                    ...previous,
                    modelLimits: { ...limits, ...previous.modelLimits, mode },
                  }))
                  setDirty(true)
                }}
              />
              {mode === 'unlimited' ? '不限额' : '自定义限额'}
            </label>
          ))}
        </div>
        <p className="muted">
          不限额模式按模型容量运行，持续记录调用与费用。DeepSeek 长任务由 DSH 自动压缩并继续执行。
        </p>
        <label>
          <span>本地模型默认输出（tokens，留空遵循模型）</span>
          <input
            type="number"
            min={1}
            max={(snapshot.device.localModelCapacity ?? legacyLocalCapacity).maximumOutputTokens}
            placeholder={String(
              (snapshot.device.localModelCapacity ?? legacyLocalCapacity).defaultOutputTokens,
            )}
            value={form.localModel?.outputTokens ?? ''}
            onChange={(event) => {
              setForm((previous) => ({
                ...previous,
                localModel: {
                  outputTokens: event.target.value ? Number(event.target.value) : undefined,
                },
              }))
              setDirty(true)
            }}
          />
        </label>
        <p className="muted">
          模型默认 {(snapshot.device.localModelCapacity ?? legacyLocalCapacity).defaultOutputTokens}
          ，最大 {
            (snapshot.device.localModelCapacity ?? legacyLocalCapacity).maximumOutputTokens
          }{' '}
          tokens ·{' '}
          {localCapacitySourceLabels[snapshot.device.localModelCapacity?.source ?? 'legacy']}
        </p>
        <div className="row">
          {(['usageBudgetEnabled', 'costLimitEnabled', 'inputLimitEnabled'] as const).map(
            (field) => (
              <label key={field}>
                <input
                  type="checkbox"
                  disabled={unlimited}
                  checked={form.modelLimits?.[field] ?? limits[field] ?? true}
                  onChange={(event) => {
                    setForm((previous) => ({
                      ...previous,
                      modelLimits: {
                        ...limits,
                        ...previous.modelLimits,
                        [field]: event.target.checked,
                      },
                    }))
                    setDirty(true)
                  }}
                />
                {field === 'costLimitEnabled'
                  ? '启用人民币消费上限'
                  : field === 'inputLimitEnabled'
                    ? '启用额外输入字节上限'
                    : '启用累计调用及用量预算'}
              </label>
            ),
          )}
        </div>
        <div className="form-grid">
          {(
            [
              ['maxRequestsPerTask', '单任务模型请求上限', 1, 256],
              ['maxRequestsPerDay', '每日最多云端请求', 1, 10000],
              ['maxTokenUnitsPerTask', '单任务用量额度', 1000, 10000000],
              ['maxTokenUnitsPerDay', '每日用量额度', 1000, 100000000],
              ['maxInputBytes', 'Coloop 额外输入上限（字节）', 1000, 1000000],
              ['maxOutputTokens', 'Coloop 额外输出上限（tokens）', 512, 1048576],
              ['minRequestIntervalMs', '云端请求最小间隔（毫秒）', 0, 60000],
              ['maxCostYuanPerTask', '单任务费用上限（元）', 0.01, 10000],
              ['maxCostYuanPerDay', '每日费用上限（元）', 0.01, 100000],
              ['maxCostYuanTotal', '累计费用上限（元，留空不限制）', 0.01, 100000],
              ['inputYuanPerMillion', '输入单价（元/百万 token）', 0, 1000000],
              ['outputYuanPerMillion', '输出单价（元/百万 token）', 0, 1000000],
            ] as const
          ).map(([field, label, min, max]) => (
            <label key={field}>
              <span>{label}</span>
              <input
                type="number"
                min={min}
                max={max}
                disabled={
                  (unlimited && !['inputYuanPerMillion', 'outputYuanPerMillion'].includes(field)) ||
                  (field === 'maxInputBytes' &&
                    !(form.modelLimits?.inputLimitEnabled ?? limits.inputLimitEnabled ?? true)) ||
                  ([
                    'maxRequestsPerTask',
                    'maxRequestsPerDay',
                    'maxTokenUnitsPerTask',
                    'maxTokenUnitsPerDay',
                  ].includes(field) &&
                    !(form.modelLimits?.usageBudgetEnabled ?? limits.usageBudgetEnabled)) ||
                  (['maxCostYuanPerTask', 'maxCostYuanPerDay', 'maxCostYuanTotal'].includes(
                    field,
                  ) &&
                    !(form.modelLimits?.costLimitEnabled ?? limits.costLimitEnabled))
                }
                step={field.includes('Yuan') ? 0.01 : 1}
                value={(form.modelLimits ? form.modelLimits[field] : limits[field]) ?? ''}
                onChange={(event) => {
                  const value =
                    event.target.value === '' &&
                    ['maxCostYuanTotal', 'inputYuanPerMillion', 'outputYuanPerMillion'].includes(
                      field,
                    )
                      ? undefined
                      : Number(event.target.value)
                  setForm((previous) => ({
                    ...previous,
                    modelLimits: { ...limits, ...previous.modelLimits, [field]: value },
                  }))
                  setDirty(true)
                }}
              />
            </label>
          ))}
        </div>
        <p className="muted">
          今日云端请求 {snapshot.modelUsage?.requests ?? 0} 次，用量额度已使用{' '}
          {snapshot.modelUsage?.tokenUnits ?? 0}。 完整响应按服务商报告的 token
          结算；缺少用量或响应中断时，保留输入字节数加最大输出的保守预留。金额以服务商账单为准。
        </p>
        <p className="muted">
          已定价请求估算 {snapshot.modelUsage?.estimatedCostYuan ?? 0} 元，未定价请求{' '}
          {snapshot.modelUsage?.unpricedRequests ?? 0} 次。
          开启费用保护后必须配置输入、输出单价。累计上限跨日和重启保留，包含本配置目录历史已计价用量；切换模型或连接后请重新配置单价。
        </p>
        {snapshot.modelUsage?.error && (
          <p role="alert">模型用量台账不可用，云端调用已停止。请检查本地磁盘及用量文件。</p>
        )}
        <div className="settings-actions">
          <span>{dirty ? '有未保存的更改' : '配置已同步'}</span>
          <div className="row">
            <button
              className="button secondary"
              disabled={testing || testingDecision || dirty || saving}
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
              disabled={saving || testing || testingDecision}
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
          <p>
            可单独配置 Auto Agent Work 决策模型。模型名称是可编辑示例，实际可用性以服务商账户为准。
          </p>
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
  const hasCredential = !!snapshot.autoConnection?.hasCredential
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
              placeholder={
                hasCredential ? '已保存；仅密码变更时需要填写' : '首次连接时输入，之后自动连接'
              }
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !dirty && !busy && !connected && !saving && !rkRunning) {
                  setConnecting(true)
                  const value = password
                  setPassword('')
                  if (!value && hasCredential) {
                    void unwrap(api.retryRkConnection())
                      .catch((error) => notify(error.message, true))
                      .finally(() => setConnecting(false))
                    return
                  }
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
                      .then(() => notify('本次运行已断开，下次启动将自动连接'))
                      .catch((e) => notify(e.message, true))
                  }
                >
                  <Unplug size={15} />
                  暂时断开
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
                  if (!value && hasCredential) {
                    void unwrap(api.retryRkConnection())
                      .catch((error) => notify(error.message, true))
                      .finally(() => setConnecting(false))
                    return
                  }
                  void unwrap(api.connect(value))
                    .then(() => notify('RK 设备已连接'))
                    .catch((e) => notify(e.message, true))
                    .finally(() => setConnecting(false))
                }}
              >
                {busy ? <LoaderCircle size={15} className="spin" /> : <Plug size={15} />}
                {busy
                  ? '正在连接'
                  : password
                    ? '连接并保存密码'
                    : hasCredential
                      ? '自动连接 RK'
                      : '首次连接 RK'}
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
          {connected && device.clockSyncError && (
            <div className="inline-error" role="alert">
              {device.clockSyncError}
            </div>
          )}
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
