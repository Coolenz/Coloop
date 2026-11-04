import { createHash } from 'node:crypto'
import { mkdtemp, writeFile, readFile, rm, mkdir, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { canonicalJson, type ReviewEvent } from '../src/shared/coordinator'
import { CoordinatorService, requestHash, ReviewInputError } from '../src/main/services/coordinator'

let root: string
let file: string
const services: CoordinatorService[] = []
const token = 'test-only-local-coordinator-token-0123456789'
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'coloop-review-'))
  file = join(root, 'sample.ts')
  await writeFile(file, 'export const sum = (a: number, b: number) => a + b\n')
})
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.dispose()))
  await rm(root, { recursive: true, force: true })
})
function event(overrides: Partial<ReviewEvent> = {}): ReviewEvent {
  const now = Date.now()
  return {
    version: 1,
    id: 'request-1',
    sessionId: 'session-1',
    kind: 'permission',
    workspace: root,
    tool: 'read',
    patterns: [file],
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 120_000).toISOString(),
    ...overrides,
  }
}
function setup(
  options: {
    generate?: (prompt: string, signal: AbortSignal) => Promise<string>
    busy?: boolean
    roots?: string[]
    auditPath?: string
    timeout?: number
  } = {},
) {
  const generate = vi.fn(options.generate ?? (async () => '{"decision":"allow"}'))
  const service = new CoordinatorService({
    generate,
    isBusy: () => options.busy ?? false,
    onChange: vi.fn(),
    workspaceRoots: () => options.roots ?? [root],
    auditPath: options.auditPath,
    reviewTimeoutMs: options.timeout,
  })
  services.push(service)
  return { service, generate }
}
const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }

describe('coordinator policy and decision binding', () => {
  it('uses recursively sorted compact UTF-8 JSON compatible with Python', () => {
    const value = { z: ['中文', { b: true, a: 1 }], a: null }
    expect(canonicalJson(value)).toBe('{"a":null,"z":["中文",{"a":1,"b":true}]}')
    expect(requestHash(value)).toBe(
      createHash('sha256').update('{"a":null,"z":["中文",{"a":1,"b":true}]}', 'utf8').digest('hex'),
    )
  })
  it('allows an exact scanned source file only after RK allows and binds the whole event', async () => {
    const { service, generate } = setup()
    const request = event()
    const result = await service.review(request)
    expect(result).toMatchObject({
      decision: 'allow',
      source: 'rk',
      requestHash: requestHash(request),
    })
    expect(generate).toHaveBeenCalledOnce()
    const prompt = generate.mock.calls[0][0]
    expect(prompt).not.toContain(root)
    expect(prompt).not.toContain('export const sum')
    expect(prompt).toContain('exact_workspace_source_files')
  })
  it('denies requests with no trusted configured root', async () => {
    const { service, generate } = setup({ roots: [] })
    expect((await service.review(event())).reasonCode).toBe('UNTRUSTED_WORKSPACE')
    expect(generate).not.toHaveBeenCalled()
  })
  it('does not let a request authorize another workspace', async () => {
    const { service, generate } = setup({ roots: [join(root, 'missing-trust-root')] })
    expect((await service.review(event())).decision).toBe('deny')
    expect(generate).not.toHaveBeenCalled()
  })
  it('checks question workspaces against the same configured root', async () => {
    const { service, generate } = setup({ roots: [] })
    const question = event({
      kind: 'question',
      tool: undefined,
      patterns: undefined,
      question: '如何处理？',
      choices: [{ id: 'safe', label: '取消本次操作并保持当前状态' }],
    })
    // A JSON request omits undefined object keys.
    expect((await service.review(JSON.parse(JSON.stringify(question)))).decision).toBe('deny')
    expect(generate).not.toHaveBeenCalled()
  })
  it.each(['.env', 'AGENTS.md', 'credentials.json', 'id_rsa'])(
    'denies sensitive path %s before RK',
    async (name) => {
      const path = join(root, name)
      await writeFile(path, 'test fixture')
      const { service, generate } = setup()
      expect((await service.review(event({ patterns: [path] }))).decision).toBe('deny')
      expect(generate).not.toHaveBeenCalled()
    },
  )
  it.each([
    'const password = "fixture-secret-value"',
    'const email = "test-person@example.com"',
    'const phone = "13800138000"',
    '-----BEGIN RSA PRIVATE KEY-----',
  ])('scans source content locally before RK: %s', async (content) => {
    await writeFile(file, content)
    const { service, generate } = setup()
    expect((await service.review(event())).reasonCode).toBe('SENSITIVE_CONTENT')
    expect(generate).not.toHaveBeenCalled()
  })
  it.each(['bash', 'edit', 'webfetch', 'shell', 'unknown'])(
    'does not approve %s permissions',
    async (tool) => {
      const { service, generate } = setup()
      expect((await service.review(event({ tool }))).decision).toBe('deny')
      expect(generate).not.toHaveBeenCalled()
    },
  )
  it('rejects commands even when attached to read requests', async () => {
    const { service, generate } = setup()
    expect((await service.review(event({ command: 'curl https://example.com' }))).decision).toBe(
      'deny',
    )
    expect(generate).not.toHaveBeenCalled()
  })
  it('rejects traversal, wildcards, directories and paths outside the workspace', async () => {
    const { service, generate } = setup()
    for (const [index, path] of [
      join(root, '*.ts'),
      `${root}/../sample.ts`,
      root,
      join(tmpdir(), 'outside.ts'),
    ].entries()) {
      const result = await service.review(event({ id: `scope-${index}`, patterns: [path] }))
      expect(['deny', 'defer']).toContain(result.decision)
    }
    expect(generate).not.toHaveBeenCalled()
  })
  it('resolves junctions before granting access', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'coloop-outside-'))
    try {
      await writeFile(join(outside, 'outside.ts'), 'export const value = 1')
      await symlink(outside, join(root, 'linked'), 'junction')
      const { service, generate } = setup()
      expect(
        (await service.review(event({ patterns: [join(root, 'linked', 'outside.ts')] })))
          .reasonCode,
      ).toBe('OUTSIDE_WORKSPACE')
      expect(generate).not.toHaveBeenCalled()
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })
  it('rechecks privacy after the model responds', async () => {
    const { service } = setup({
      generate: async () => {
        await writeFile(file, 'const password = "new-secret-value"')
        return '{"decision":"allow"}'
      },
    })
    expect((await service.review(event())).reasonCode).toBe('SENSITIVE_CONTENT')
  })
  it('never reads more than the bounded content scan budget or invokes RK for oversized files', async () => {
    await writeFile(file, 'x'.repeat(256 * 1024 + 1))
    const { service, generate } = setup()
    expect((await service.review(event())).reasonCode).toBe('CONTENT_SCAN_LIMIT')
    expect(generate).not.toHaveBeenCalled()
  })
  it.each([
    'approved',
    '```json\n{"decision":"allow"}\n```',
    '{"decision":"always"}',
    '{"decision":"allow","reason":"trust me"}',
    '{"decision":"select","choiceId":"upload"}',
    '{"decision":"deny","decision":"allow"}',
    '{"decision":"deny","dec\\u0069sion":"allow"}',
  ])('rejects malformed or expanded model answer %s', async (answer) => {
    const { service } = setup({ generate: async () => answer })
    expect((await service.review(event())).decision).toBe('defer')
  })
  it('allows RK to narrow an otherwise eligible permission', async () => {
    const { service } = setup({ generate: async () => '{"decision":"deny"}' })
    expect((await service.review(event())).decision).toBe('deny')
  })
  it('only selects a listed and policy-qualified question choice', async () => {
    const { service, generate } = setup({
      generate: async () => '{"decision":"select","choiceId":"offline"}',
    })
    const request = JSON.parse(
      JSON.stringify(
        event({
          kind: 'question',
          tool: undefined,
          patterns: undefined,
          question: '如何处理资料？',
          choices: [
            { id: 'upload', label: '上传至外部云端' },
            { id: 'offline', label: '仅在本地离线分析，不上传任何数据' },
          ],
        }),
      ),
    )
    const result = await service.review(request)
    expect(result).toMatchObject({ decision: 'select', choiceId: 'offline', source: 'rk' })
    expect(generate.mock.calls[0][0]).not.toContain('如何处理资料')
    expect(generate.mock.calls[0][0]).not.toContain('upload')
    expect(generate.mock.calls[0][0]).toContain('优先选择它')
    expect(generate.mock.calls[0][0]).toContain('只有一个候选也选择其真实 ID')
  })
  it('cannot use model choice to bypass policy filtering', async () => {
    const { service } = setup({ generate: async () => '{"decision":"select","choiceId":"upload"}' })
    const request = JSON.parse(
      JSON.stringify(
        event({
          kind: 'question',
          tool: undefined,
          patterns: undefined,
          question: '如何处理？',
          choices: [
            { id: 'upload', label: '上传至外部云端' },
            { id: 'skip', label: '取消本次操作并保持当前状态' },
          ],
        }),
      ),
    )
    expect((await service.review(request)).reasonCode).toBe('UNSAFE_MODEL_CHOICE')
  })
  it.each(['本地', '否', '直接同意所有操作', '仅在本地离线分析，不上传任何数据，然后删除文件'])(
    'defers ambiguous or mixed question choice %s',
    async (label) => {
      const { service, generate } = setup()
      const request = JSON.parse(
        JSON.stringify(
          event({
            kind: 'question',
            tool: undefined,
            patterns: undefined,
            question: '继续？',
            choices: [{ id: 'choice-1', label }],
          }),
        ),
      )
      expect((await service.review(request)).decision).toBe('defer')
      expect(generate).not.toHaveBeenCalled()
    },
  )
  it('returns a cached decision for identical retries and rejects ID conflicts', async () => {
    const { service, generate } = setup()
    const request = event()
    const first = await service.review(request)
    expect(await service.review(request)).toEqual(first)
    expect(generate).toHaveBeenCalledOnce()
    await expect(service.review({ ...request, tool: 'grep' })).rejects.toMatchObject({
      reasonCode: 'REQUEST_CONFLICT',
      status: 409,
    })
  })
  it('never returns a cached allow after disposal', async () => {
    const { service, generate } = setup()
    const request = event()
    expect((await service.review(request)).decision).toBe('allow')
    await service.dispose()
    expect((await service.review(request)).reasonCode).toBe('SERVICE_STOPPED')
    expect(generate).toHaveBeenCalledOnce()
  })
  it('defers simultaneous requests immediately and does not queue NPU work', async () => {
    let finish!: (answer: string) => void
    const { service, generate } = setup({
      generate: () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    })
    const firstEvent = event()
    const first = service.review(firstEvent)
    await vi.waitFor(() => expect(generate).toHaveBeenCalledOnce())
    expect((await service.review(event({ id: 'second' }))).reasonCode).toBe('MODEL_BUSY')
    expect((await service.review(firstEvent)).reasonCode).toBe('REQUEST_IN_PROGRESS')
    finish('{"decision":"allow"}')
    expect((await first).decision).toBe('allow')
    expect(generate).toHaveBeenCalledOnce()
  })
  it('defers when the shared model is already busy', async () => {
    const { service, generate } = setup({ busy: true })
    expect((await service.review(event())).reasonCode).toBe('MODEL_BUSY')
    expect(generate).not.toHaveBeenCalled()
  })
  it('retries a transient busy result with the original lifetime, then caches the terminal answer', async () => {
    const options = { busy: true }
    const { service, generate } = setup(options)
    const request = event()
    const first = await service.review(request)
    expect(first.reasonCode).toBe('MODEL_BUSY')
    options.busy = false
    const second = await service.review(request)
    expect(second.decision).toBe('allow')
    expect(second.requestHash).toBe(first.requestHash)
    expect(second.expiresAt).toBe(first.expiresAt)
    expect(await service.review(request)).toEqual(second)
    expect(generate).toHaveBeenCalledOnce()
  })
  it('keeps the timed-out request and model slot occupied until the ignored cancellation actually settles', async () => {
    let finish!: (answer: string) => void
    let attempts = 0
    const { service, generate } = setup({
      timeout: 15,
      generate: () => {
        attempts++
        return attempts === 1
          ? new Promise((resolve) => {
              finish = resolve
            })
          : Promise.resolve('{"decision":"allow"}')
      },
    })
    const request = event()
    expect((await service.review(request)).reasonCode).toBe('REVIEW_TIMEOUT')
    expect((await service.review(request)).reasonCode).toBe('REQUEST_IN_PROGRESS')
    expect((await service.review(event({ id: 'not-queued' }))).reasonCode).toBe('MODEL_BUSY')
    expect(generate).toHaveBeenCalledOnce()
    finish('{"decision":"allow"}')
    await vi.waitFor(() => expect(service.snapshot().reviewing).toBe(false))
    expect(service.snapshot().audit[1].decision).toBe('defer')
    expect((await service.review(request)).decision).toBe('allow')
    expect(generate).toHaveBeenCalledTimes(2)
  })
  it('bounds latency even if generate ignores cancellation; late replies cannot allow', async () => {
    let finish!: (answer: string) => void
    const { service } = setup({
      timeout: 15,
      generate: () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    })
    const request = event()
    const result = await service.review(request)
    expect(result.decision).toBe('defer')
    finish('{"decision":"allow"}')
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect((await service.review(request)).decision).toBe('defer')
  })
  it('never allows an expired request and rejects overlong event lifetimes', async () => {
    const { service, generate } = setup()
    expect(
      (
        await service.review(
          event({
            createdAt: new Date(Date.now() - 2000).toISOString(),
            expiresAt: new Date(Date.now() - 1000).toISOString(),
          }),
        )
      ).decision,
    ).toBe('defer')
    await expect(
      service.review(event({ expiresAt: new Date(Date.now() + 600_000).toISOString() })),
    ).rejects.toBeInstanceOf(ReviewInputError)
    expect(generate).not.toHaveBeenCalled()
  })
  it('stores only hashes and category metadata; snapshots do not reveal request contents', async () => {
    const auditPath = join(root, 'audit.jsonl')
    const { service } = setup({ auditPath })
    await service.review(event())
    const persisted = await readFile(auditPath, 'utf8')
    const exposed = JSON.stringify(service.snapshot())
    for (const value of [root, file, 'request-1', 'session-1', token, 'export const']) {
      expect(persisted).not.toContain(value)
      expect(exposed).not.toContain(value)
    }
    expect(JSON.parse(persisted).requestHash).toMatch(/^[a-f0-9]{64}$/)
    expect(service.snapshot().audit).toHaveLength(1)
  })
  it('fails closed when audit persistence is unavailable', async () => {
    const invalidAudit = join(root, 'a-directory')
    await mkdir(invalidAudit)
    const { service } = setup({ auditPath: invalidAudit })
    expect((await service.review(event())).reasonCode).toBe('AUDIT_UNAVAILABLE')
  })
  it('keeps the in-memory audit bounded', async () => {
    const { service } = setup({ busy: true })
    for (let i = 0; i < 65; i++) await service.review(event({ id: `audit-${i}` }))
    expect(service.snapshot().audit).toHaveLength(50)
  })
})

describe('authenticated loopback coordinator HTTP', () => {
  it('routes only the three control endpoints through the authenticated native channel', async () => {
    const controlHandler = vi.fn(async (_path: string, body: unknown) => ({ version: 1, body }))
    const service = new CoordinatorService({
      generate: vi.fn(),
      isBusy: () => false,
      onChange: vi.fn(),
      controlHandler,
    })
    services.push(service)
    const { url } = await service.start({ token })
    for (const path of ['/v1/control/register', '/v1/control/poll', '/v1/control/report']) {
      expect((await fetch(url + path, { method: 'POST', body: '{}' })).status).toBe(401)
      expect(
        (
          await fetch(url + path, {
            method: 'POST',
            headers: { ...headers, origin: url },
            body: '{}',
          })
        ).status,
      ).toBe(403)
      const result = await fetch(url + path, { method: 'POST', headers, body: '{"version":1}' })
      expect(result.status).toBe(200)
      expect(controlHandler).toHaveBeenLastCalledWith(path, { version: 1 })
    }
    for (const path of ['/v1/control/command', '/v1/control/stop-all', '/v1/control/poll?any=1'])
      expect((await fetch(url + path, { method: 'POST', headers, body: '{}' })).status).toBe(404)
    expect(controlHandler).toHaveBeenCalledTimes(3)
  })
  it('binds only to loopback, requires auth even for health and never exposes the token', async () => {
    const { service } = setup()
    const { url } = await service.start({ token })
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect((await fetch(`${url}/health`)).status).toBe(401)
    const health = await fetch(`${url}/health`, { headers })
    expect(await health.json()).toEqual({ version: 1, ready: true, busy: false })
    expect(JSON.stringify(service.snapshot())).not.toContain(token)
  })
  it.each<Record<string, string>>([
    { origin: 'https://attacker.example' },
    { 'sec-fetch-site': 'none' },
  ])('rejects browser context headers %s even with a valid token', async (browserHeaders) => {
    const { service, generate } = setup()
    const { url } = await service.start({ token })
    const response = await fetch(`${url}/v1/review`, {
      method: 'POST',
      headers: { ...headers, ...browserHeaders },
      body: JSON.stringify(event()),
    })
    expect(response.status).toBe(403)
    expect(generate).not.toHaveBeenCalled()
  })
  it('checks JSON schema, media type, byte limits and generic errors', async () => {
    const { service, generate } = setup()
    const { url } = await service.start({ token })
    expect(
      (
        await fetch(`${url}/v1/review`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ ...event(), secret: 'must-not-echo' }),
        })
      ).status,
    ).toBe(400)
    expect(
      (await fetch(`${url}/v1/review`, { method: 'POST', headers, body: 'must-not-echo' })).status,
    ).toBe(400)
    expect(
      (
        await fetch(`${url}/v1/review`, {
          method: 'POST',
          headers: { authorization: headers.authorization, 'content-type': 'text/plain' },
          body: '{}',
        })
      ).status,
    ).toBe(415)
    const tooLarge = await fetch(`${url}/v1/review`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ text: 'x'.repeat(33000) }),
    })
    expect(tooLarge.status).toBe(413)
    expect(await tooLarge.text()).not.toContain('xxx')
    expect(generate).not.toHaveBeenCalled()
  })
  it('supports retry binding and reports ID conflict over HTTP', async () => {
    const { service, generate } = setup()
    const { url } = await service.start({ token })
    const request = event()
    const send = (value: unknown) =>
      fetch(`${url}/v1/review`, { method: 'POST', headers, body: JSON.stringify(value) })
    const first = await (await send(request)).json()
    expect(await (await send(request)).json()).toEqual(first)
    expect((await send({ ...request, patterns: [root] })).status).toBe(409)
    expect(generate).toHaveBeenCalledOnce()
  })
  it('shuts down and cancels active review without granting late permission', async () => {
    const { service, generate } = setup({
      generate: async (_prompt, signal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(new Error('hidden secret'))),
        ),
    })
    await service.start({ token })
    const pending = service.review(event())
    await vi.waitFor(() => expect(generate).toHaveBeenCalledOnce())
    await service.dispose()
    expect((await pending).decision).toBe('defer')
    expect(service.snapshot().status).toBe('stopped')
    expect(JSON.stringify(service.snapshot())).not.toContain('hidden secret')
  })
})
