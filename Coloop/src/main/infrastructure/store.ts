import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
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
    host: '192.0.2.2',
    port: 22,
    username: 'cat',
    fingerprint: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  },
  ocrWorkspace: 'D:/RK',
}
const taskSchema = z.object({
  id: z.string(),
  prompt: z.string(),
  target: z.enum(['cloud', 'rk']),
  source: z.enum(['text', 'screen']),
  status: z.enum(['running', 'completed', 'failed', 'cancelled']),
  createdAt: z.string(),
  finishedAt: z.string().optional(),
  answer: z.string(),
  error: z.string().optional(),
  stage: z.string(),
  model: z.string(),
})
export class AppStore {
  private settings: SettingsInput = structuredClone(defaultSettings)
  private encryptedKey = ''
  tasks: Task[] = []
  constructor(
    private directory: string,
    private codec: SecretCodec,
  ) {
    mkdirSync(directory, { recursive: true })
    const file = join(directory, 'state.json')
    if (existsSync(file)) {
      try {
        const data = JSON.parse(readFileSync(file, 'utf8'))
        this.settings = settingsSchema.parse(data.settings)
        this.encryptedKey = typeof data.encryptedKey === 'string' ? data.encryptedKey : ''
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
        // Preserve an unreadable file for diagnosis; never silently overwrite it.
        renameSync(file, join(directory, `state.recovery-${Date.now()}.json`))
      }
    }
  }
  publicSettings(): Settings {
    const { apiKey: _key, clearKey: _clear, ...provider } = this.settings.provider
    return {
      ...structuredClone(this.settings),
      provider: { ...provider, hasKey: !!this.encryptedKey },
    }
  }
  get config(): SettingsInput {
    return structuredClone(this.settings)
  }
  get apiKey(): string {
    return this.encryptedKey ? this.codec.decrypt(this.encryptedKey) : ''
  }
  saveSettings(input: SettingsInput): Settings {
    const parsed = settingsSchema.parse(input)
    const current = this.settings.provider
    const changedEndpoint =
      current.protocol !== parsed.provider.protocol || current.baseUrl !== parsed.provider.baseUrl
    const encryptedKey = parsed.provider.clearKey
      ? ''
      : parsed.provider.apiKey
        ? this.codec.encrypt(parsed.provider.apiKey)
        : changedEndpoint
          ? ''
          : this.encryptedKey
    const { apiKey: _key, clearKey: _clear, ...provider } = parsed.provider
    this.settings = { ...parsed, provider }
    this.encryptedKey = encryptedKey
    this.persist()
    return this.publicSettings()
  }
  persist(): void {
    const file = join(this.directory, 'state.json')
    const temporary = join(this.directory, 'state.json.tmp')
    writeFileSync(
      temporary,
      JSON.stringify(
        {
          schemaVersion: 1,
          settings: this.settings,
          encryptedKey: this.encryptedKey,
          tasks: this.tasks.slice(0, 200),
        },
        null,
        2,
      ),
      { encoding: 'utf8', mode: 0o600 },
    )
    renameSync(temporary, file)
  }
}
