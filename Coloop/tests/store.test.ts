import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AppStore } from '../src/main/infrastructure/store'
import { modelLimitsSchema } from '../src/shared/model-usage'

const directories: string[] = []
function create() {
  const directory = mkdtempSync(join(tmpdir(), 'coloop-store-'))
  directories.push(directory)
  const codec = {
    encrypt: (value: string) => Buffer.from(value).toString('base64'),
    decrypt: (value: string) => Buffer.from(value, 'base64').toString(),
  }
  return { directory, codec, store: new AppStore(directory, codec) }
}
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
describe('local persistence and credential boundary', () => {
  it('persists model limits and clears stale prices when the model changes', () => {
    const { store, directory, codec } = create()
    store.saveSettings({
      ...store.config,
      modelLimits: modelLimitsSchema.parse({ inputYuanPerMillion: 2, outputYuanPerMillion: 8 }),
    })
    expect(new AppStore(directory, codec).config.modelLimits?.inputYuanPerMillion).toBe(2)
    store.saveSettings({
      ...store.config,
      provider: { ...store.config.provider, name: 'renamed connection' },
    })
    expect(store.config.modelLimits?.inputYuanPerMillion).toBe(2)
    store.saveSettings({
      ...store.config,
      provider: { ...store.config.provider, model: 'different-model' },
    })
    expect(store.config.modelLimits?.inputYuanPerMillion).toBeUndefined()
    expect(store.config.modelLimits?.outputYuanPerMillion).toBeUndefined()
    expect(store.config.modelLimits?.maxCostYuanPerTask).toBe(2)
  })
  it('never exposes the API key in public settings or stores its plaintext', () => {
    const { store, directory } = create()
    store.saveSettings({
      ...store.config,
      provider: { ...store.config.provider, apiKey: 'secret-api-value' },
    })
    expect(store.publicSettings().provider.hasKey).toBe(true)
    expect(JSON.stringify(store.publicSettings())).not.toContain('secret-api-value')
    expect(readFileSync(join(directory, 'state.json'), 'utf8')).not.toContain('secret-api-value')
    expect(store.apiKey).toBe('secret-api-value')
  })
  it('does not reuse one provider credential when the endpoint changes', () => {
    const { store } = create()
    store.saveSettings({
      ...store.config,
      provider: { ...store.config.provider, apiKey: 'secret-api-value' },
    })
    store.saveSettings({
      ...store.config,
      provider: { ...store.config.provider, baseUrl: 'https://different.example/v1' },
    })
    expect(store.apiKey).toBe('')
  })
  it('preserves the key on ordinary edits and supports explicit deletion', () => {
    const { store } = create()
    store.saveSettings({ ...store.config, provider: { ...store.config.provider, apiKey: 'key' } })
    store.saveSettings({ ...store.config, provider: { ...store.config.provider, model: 'new' } })
    expect(store.apiKey).toBe('key')
    store.saveSettings({ ...store.config, provider: { ...store.config.provider, clearKey: true } })
    expect(store.publicSettings().provider.hasKey).toBe(false)
  })
  it('recovers interrupted runs on startup', () => {
    const { store, directory, codec } = create()
    store.tasks.push({
      id: 't',
      prompt: 'test',
      target: 'cloud',
      source: 'text',
      status: 'running',
      createdAt: new Date().toISOString(),
      model: 'test',
      answer: '',
      stage: 'running',
    })
    store.persist()
    const reopened = new AppStore(directory, codec)
    expect(reopened.tasks[0].status).toBe('failed')
    expect(reopened.tasks[0].error).toContain('中断')
  })
  it('preserves corrupted storage for recovery', () => {
    const { directory, codec } = create()
    writeFileSync(join(directory, 'state.json'), 'corrupted')
    expect(new AppStore(directory, codec).tasks).toEqual([])
    expect(readdirSync(directory).some((file) => file.startsWith('state.recovery-'))).toBe(true)
  })
  it('keeps cooperative task history readable across restarts', () => {
    const { store, directory, codec } = create()
    store.tasks.push({
      id: 'hybrid-task',
      prompt: 'synthetic',
      target: 'hybrid',
      source: 'text',
      status: 'completed',
      createdAt: new Date().toISOString(),
      answer: '完成',
      stage: '已完成',
      model: 'RK + cloud',
    })
    store.persist()
    expect(new AppStore(directory, codec).tasks[0]).toMatchObject({
      id: 'hybrid-task',
      target: 'hybrid',
      status: 'completed',
      answer: '完成',
    })
    expect(readdirSync(directory).some((file) => file.startsWith('state.recovery-'))).toBe(false)
  })
  it('persists the desktop execution capability beside legacy task history', () => {
    const { store, directory, codec } = create()
    const task = {
      id: 'computer-task',
      prompt: 'append a line',
      target: 'cloud' as const,
      source: 'text' as const,
      status: 'completed' as const,
      createdAt: new Date().toISOString(),
      answer: 'verified',
      stage: '已完成',
      model: 'TARS',
    }
    store.tasks.push({ ...task, execution: 'desktop' }, { ...task, id: 'old-task' })
    store.persist()
    const reopened = new AppStore(directory, codec)
    expect(reopened.tasks[0].execution).toBe('desktop')
    expect(reopened.tasks[1]).not.toHaveProperty('execution')
  })
})
