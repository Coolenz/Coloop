import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { replaceFileSync } from './atomic-file'
import { executionPolicySchema } from '../../shared/conversations'
import type { DecisionModelRoute } from './model-role'
import {
  settingsSchema,
  type SettingsInput,
  type Settings,
  type Task,
} from '../../shared/contracts'

export interface SecretCodec {
  encrypt(value: string): string
  decrypt(value: string): string
}
const defaultSettings: SettingsInput = {
  provider: {
    protocol: 'openai',
    name: 'OpenAI 兼容服务',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4.1-mini',
  },
  board: {
    host: '169.254.207.141',
    port: 22,
    username: 'cat',
    fingerprint: '80g5a9IosBsdRKzq2QzobK+Q0mLvpKkdPHUJE2U8LnI',
  },
  ocrWorkspace: 'D:/RK',
}
const taskSchema = z.object({
  policy: executionPolicySchema.optional(),
  id: z.string(),
  prompt: z.string(),
  target: z.enum(['hybrid', 'cloud', 'rk']),
  source: z.enum(['text', 'screen']),
  status: z.enum(['running', 'completed', 'failed', 'cancelled']),
  createdAt: z.string(),
  finishedAt: z.string().optional(),
  answer: z.string(),
  error: z.string().optional(),
  stage: z.string(),
  model: z.string(),
  execution: z.literal('desktop').optional(),
})
export class AppStore {
  private settings: SettingsInput = structuredClone(defaultSettings)
  private encryptedKey = ''
  private encryptedDecisionKey = ''
  tasks: Task[] = []
  constructor(
    private directory: string,
    private codec: SecretCodec,
    private options: { readOnly?: boolean } = {},
  ) {
    if (!options.readOnly) mkdirSync(directory, { recursive: true })
    const file = join(directory, 'state.json')
    if (existsSync(file)) {
      try {
        const data = JSON.parse(readFileSync(file, 'utf8'))
        this.settings = settingsSchema.parse(data.settings)
        this.encryptedKey = typeof data.encryptedKey === 'string' ? data.encryptedKey : ''
        this.encryptedDecisionKey =
          this.settings.decisionProvider && typeof data.encryptedDecisionKey === 'string'
            ? data.encryptedDecisionKey
            : ''
        this.tasks = z
          .array(taskSchema)
          .parse(data.tasks)
          .slice(0, 200)
          .map((task) =>
            task.status === 'running'
              ? {
                  ...task,
                  status: 'failed',
                  stage: '已中断',
                  error: '上次运行被应用退出中断',
                  finishedAt: new Date().toISOString(),
                }
              : task,
          )
      } catch {
        if (options.readOnly) throw new Error('STORE_READ_ONLY_LOAD_FAILED')
        // Preserve an unreadable file for diagnosis; never silently overwrite it.
        renameSync(file, join(directory, `state.recovery-${Date.now()}.json`))
      }
    }
  }
  publicSettings(): Settings {
    const { apiKey: _key, clearKey: _clear, ...provider } = this.settings.provider
    const { decisionProvider, ...settings } = structuredClone(this.settings)
    const decision = decisionProvider
      ? (({ apiKey: _key, clearKey: _clear, ...value }) => value)(decisionProvider)
      : undefined
    return {
      ...settings,
      provider: { ...provider, hasKey: !!this.encryptedKey },
      ...(decision
        ? { decisionProvider: { ...decision, hasKey: !!this.encryptedDecisionKey } }
        : {}),
    }
  }
  get config(): SettingsInput {
    return structuredClone(this.settings)
  }
  get apiKey(): string {
    return this.encryptedKey ? this.codec.decrypt(this.encryptedKey) : ''
  }
  decisionModel(): DecisionModelRoute {
    const decision = this.settings.decisionProvider
    const limits = this.settings.modelLimits
    return {
      provider: structuredClone(decision ?? this.settings.provider),
      apiKey: decision
        ? this.encryptedDecisionKey
          ? this.codec.decrypt(this.encryptedDecisionKey)
          : ''
        : this.apiKey,
      role: decision ? 'decision' : 'default',
      pricing: decision
        ? structuredClone(this.settings.decisionPricing ?? {})
        : {
            inputYuanPerMillion: limits?.inputYuanPerMillion,
            outputYuanPerMillion: limits?.outputYuanPerMillion,
          },
    }
  }
  recordDecisionModelProbe(
    route: DecisionModelRoute,
    imageInput: 'supported' | 'unsupported' | 'unknown',
  ): boolean {
    if (this.options.readOnly) throw new Error('STORE_READ_ONLY')
    const current = this.decisionModel()
    if (
      current.role !== route.role ||
      current.apiKey !== route.apiKey ||
      current.provider.protocol !== route.provider.protocol ||
      current.provider.baseUrl !== route.provider.baseUrl ||
      current.provider.model !== route.provider.model
    )
      return false
    const provider =
      current.role === 'decision' ? this.settings.decisionProvider! : this.settings.provider
    provider.imageInput = imageInput
    this.persist()
    return true
  }
  saveSettings(input: SettingsInput): Settings {
    if (this.options.readOnly) throw new Error('STORE_READ_ONLY')
    const parsed = settingsSchema.parse(input)
    const current = this.settings.provider
    const changedEndpoint =
      current.protocol !== parsed.provider.protocol || current.baseUrl !== parsed.provider.baseUrl
    parsed.provider.imageInput =
      changedEndpoint || current.model !== parsed.provider.model ? 'unknown' : current.imageInput
    if (parsed.modelLimits && (changedEndpoint || current.model !== parsed.provider.model)) {
      delete parsed.modelLimits.inputYuanPerMillion
      delete parsed.modelLimits.outputYuanPerMillion
    }
    const encryptedKey = parsed.provider.clearKey
      ? ''
      : parsed.provider.apiKey
        ? this.codec.encrypt(parsed.provider.apiKey)
        : changedEndpoint
          ? ''
          : this.encryptedKey
    const { apiKey: _key, clearKey: _clear, ...provider } = parsed.provider
    const currentDecision = this.settings.decisionProvider
    const nextDecision = parsed.decisionProvider
    const decisionEndpointChanged =
      !currentDecision ||
      !nextDecision ||
      currentDecision.protocol !== nextDecision.protocol ||
      currentDecision.baseUrl !== nextDecision.baseUrl
    const decisionModelChanged =
      !!currentDecision &&
      !!nextDecision &&
      (decisionEndpointChanged || currentDecision.model !== nextDecision.model)
    if (nextDecision)
      nextDecision.imageInput =
        decisionEndpointChanged || decisionModelChanged ? 'unknown' : currentDecision?.imageInput
    if (!nextDecision || decisionModelChanged) delete parsed.decisionPricing
    const encryptedDecisionKey =
      !nextDecision || nextDecision.clearKey
        ? ''
        : nextDecision.apiKey
          ? this.codec.encrypt(nextDecision.apiKey)
          : decisionEndpointChanged
            ? ''
            : this.encryptedDecisionKey
    const decisionProvider = nextDecision
      ? (({ apiKey: _key, clearKey: _clear, ...value }) => value)(nextDecision)
      : undefined
    this.settings = { ...parsed, provider, decisionProvider }
    this.encryptedKey = encryptedKey
    this.encryptedDecisionKey = encryptedDecisionKey
    this.persist()
    return this.publicSettings()
  }
  persist(): void {
    if (this.options.readOnly) throw new Error('STORE_READ_ONLY')
    const file = join(this.directory, 'state.json')
    const temporary = join(this.directory, 'state.json.tmp')
    writeFileSync(
      temporary,
      JSON.stringify(
        {
          schemaVersion: 2,
          settings: this.settings,
          encryptedKey: this.encryptedKey,
          encryptedDecisionKey: this.encryptedDecisionKey,
          tasks: this.tasks.slice(0, 200),
        },
        null,
        2,
      ),
      { encoding: 'utf8', mode: 0o600 },
    )
    replaceFileSync(temporary, file)
  }
}
