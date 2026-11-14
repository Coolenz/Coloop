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
  it('supports read-only inspection without modifying or renaming production state', () => {
    const { store, directory, codec } = create()
    store.saveSettings({
      ...store.config,
      provider: { ...store.config.provider, apiKey: 'read-only-key' },
    })
    const before = readFileSync(join(directory, 'state.json'), 'utf8')
    const reader = new AppStore(directory, codec, { readOnly: true })
    expect(reader.decisionModel().apiKey).toBe('read-only-key')
    expect(() => reader.persist()).toThrow('STORE_READ_ONLY')
    expect(() => reader.saveSettings(reader.config)).toThrow('STORE_READ_ONLY')
    expect(readFileSync(join(directory, 'state.json'), 'utf8')).toBe(before)
    writeFileSync(join(directory, 'state.json'), 'invalid')
    expect(() => new AppStore(directory, codec, { readOnly: true })).toThrow(
      'STORE_READ_ONLY_LOAD_FAILED',
    )
    expect(readFileSync(join(directory, 'state.json'), 'utf8')).toBe('invalid')
    expect(readdirSync(directory)).toEqual(['state.json'])
  })
  it('migrates the default role without changing history or requiring a second key', () => {
    const { store, directory, codec } = create()
    store.saveSettings({
      ...store.config,
      provider: { ...store.config.provider, apiKey: 'ordinary-key' },
    })
    const state = JSON.parse(readFileSync(join(directory, 'state.json'), 'utf8'))
    state.schemaVersion = 1
    delete state.encryptedDecisionKey
    writeFileSync(join(directory, 'state.json'), JSON.stringify(state))
    const reopened = new AppStore(directory, codec)
    expect(reopened.decisionModel()).toMatchObject({ role: 'default', apiKey: 'ordinary-key' })
    expect(reopened.publicSettings().decisionProvider).toBeUndefined()
    expect(readdirSync(directory)).toEqual(['state.json'])
  })
  it('isolates decision credentials and rates, and does not fall back from a configured role', () => {
    const { store, directory, codec } = create()
    store.saveSettings({
      ...store.config,
      provider: { ...store.config.provider, apiKey: 'ordinary-key' },
      decisionProvider: {
        ...store.config.provider,
        model: 'strong-model',
        apiKey: 'decision-secret',
        imageInput: 'supported',
      },
      decisionPricing: { inputYuanPerMillion: 10, outputYuanPerMillion: 20 },
    })
    expect(store.publicSettings().decisionProvider).toMatchObject({
      hasKey: true,
      imageInput: 'unknown',
    })
    expect(store.recordDecisionModelProbe(store.decisionModel(), 'supported')).toBe(true)
    expect(store.publicSettings().decisionProvider?.imageInput).toBe('supported')
    expect(JSON.stringify(store.publicSettings())).not.toMatch(/decision-secret|ordinary-key/)
    expect(readFileSync(join(directory, 'state.json'), 'utf8')).not.toMatch(
      /decision-secret|ordinary-key/,
    )
    const reopened = new AppStore(directory, codec)
    expect(reopened.decisionModel()).toMatchObject({
      role: 'decision',
      apiKey: 'decision-secret',
      pricing: { inputYuanPerMillion: 10 },
    })
    const staleProbe = reopened.decisionModel()
    reopened.saveSettings({
      ...reopened.config,
      decisionProvider: {
        ...reopened.config.decisionProvider!,
        baseUrl: 'https://other.example/v1',
      },
    })
    expect(reopened.recordDecisionModelProbe(staleProbe, 'supported')).toBe(false)
    expect(reopened.publicSettings().decisionProvider?.imageInput).toBe('unknown')
    expect(reopened.apiKey).toBe('ordinary-key')
    expect(reopened.decisionModel()).toMatchObject({ role: 'decision', apiKey: '', pricing: {} })
    reopened.saveSettings({ ...reopened.config, decisionProvider: undefined })
    expect(reopened.decisionModel()).toMatchObject({ role: 'default', apiKey: 'ordinary-key' })
    expect(reopened.publicSettings().decisionPricing).toBeUndefined()
  })
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
