// Invoked only by deepseek-live.mjs inside Electron. All test material is synthetic.
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, safeStorage, session } from 'electron'

const output = process.env.COLOOP_LIVE_OUTPUT
const phase = process.env.COLOOP_LIVE_PHASE
if (!output || !['direct', 'full'].includes(phase)) app.exit(1)
const sourceProfile = process.env.COLOOP_SOURCE_PROFILE ?? join(process.env.APPDATA, 'coloop')
// safeStorage's OS crypt metadata belongs to this profile. No AppStore or default-session fetch is used.
const runtimeProfile = process.env.COLOOP_CREDENTIAL_PROFILE ?? sourceProfile
app.setPath('userData', runtimeProfile)
const controller = new AbortController()
process.on('message', (message) => {
  if (message?.type === 'abort') controller.abort()
})
const results = [],
  cloudRequests = [],
  cloudResponses = [],
  captures = [],
  stages = [],
  activities = []
const ownActivities = new Set()
const egressRejections = new Map()
const requiredSourceFacts = ['方案A初期投入低但维护负担高', '方案B初期投入适中但维护负担低']
const business = `项目${randomBytes(6).toString('hex')}`
const credential = `live-synthetic-${randomBytes(12).toString('hex')}`
const protectedForms = [business, credential].flatMap((value) => [
  value,
  encodeURIComponent(value),
  Buffer.from(value).toString('base64'),
  Buffer.from(value).toString('base64url'),
])
let apiKey = '',
  currentTask = '',
  board,
  originalActivity,
  originalPrivate,
  originalService,
  activeCall,
  paidRequests = 0,
  failed = false,
  credentialReady = false,
  fatalEvidenceError = false,
  localSourceFidelity = null
let integrityBefore, networkSession
const save = async (name, value) => {
  const body = JSON.stringify(value, null, 2) + '\n'
  if (apiKey && body.includes(apiKey)) throw new Error('KEY_IN_EVIDENCE_BLOCKED')
  await writeFile(resolve(output, name), body)
}
const event = (value) => process.stdout.write('LIVE_EVENT ' + JSON.stringify(value) + '\n')
const safeError = (error) => {
  const text = error instanceof Error ? error.message : ''
  if (apiKey && text.includes(apiKey)) return { code: 'SENSITIVE_ERROR_BLOCKED' }
  if (Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599)
    return { code: 'RK_SERVICE_REJECTED', status: error.status }
  if (error instanceof assert.AssertionError) return { code: 'ACCEPTANCE_ASSERTION_FAILED' }
  if (/^[A-Z][A-Z0-9_]{1,90}$/.test(text)) return { code: text }
  // Production gateways already suppress upstream bodies, but do not export arbitrary exception text.
  const allowed = [
    '云端分析响应无效、被截断或超出限制，请重试',
    '云端分析请求失败或超时，请检查连接与模型配置',
    '本地隐私检查未通过，未发送云端',
    '云端分析未通过校验，未生成最终答案',
    'RK 本地答案生成失败，未发布中间分析',
  ]
  return allowed.includes(text)
    ? { code: 'GATEWAY_REJECTED', message: text }
    : { code: 'LIVE_OPERATION_FAILED' }
}
async function boundedText(response, signal) {
  if (!response.body) throw new Error('EMPTY_CAPTURE_BODY')
  const reader = response.body.getReader()
  const abort = () => {
    void reader.cancel().catch(() => {})
  }
  signal?.addEventListener('abort', abort, { once: true })
  let bytes = 0,
    text = ''
  const decoder = new TextDecoder('utf-8', { fatal: true })
  try {
    while (true) {
      signal?.throwIfAborted()
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > 32768) throw new Error('CAPTURE_BODY_LIMIT')
      text += decoder.decode(value, { stream: true })
    }
    return text + decoder.decode()
  } finally {
    signal?.removeEventListener('abort', abort)
    void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
async function executeCase(name, operation) {
  currentTask = name
  const row = { task: name, startedAt: new Date().toISOString(), passed: false }
  const began = performance.now()
  try {
    Object.assign(row, await operation())
    row.passed = true
  } catch (error) {
    failed = true
    // CloudGateway deliberately wraps fetch errors. Keep the test guard's own
    // rejection distinct from a genuine network, HTTP, or response failure.
    row.error = egressRejections.has(name) ? { code: egressRejections.get(name) } : safeError(error)
  } finally {
    if (phase === 'full' && name === 'complex') row.local_source_fidelity = localSourceFidelity
    row.elapsedMs = performance.now() - began
    row.finishedAt = new Date().toISOString()
    results.push(row)
    await save(`result-${name}.json`, row)
    event({ task: name, passed: row.passed, error: row.error, elapsedMs: row.elapsedMs })
  }
  return row.passed
}
async function main() {
  const snapshot = await import(pathToFileURL(process.env.COLOOP_LIVE_SNAPSHOT).href)
  const {
    BoardGateway,
    importRkBoard,
    CloudGateway,
    CooperativeAgent,
    localAgentPolicies,
    providerSchema,
  } = snapshot
  // Read only the provider and encrypted credential; never instantiate AppStore or persist user data.
  const statePath = join(sourceProfile, 'state.json')
  const stateBytes = await readFile(statePath)
  const stateHashBefore = createHash('sha256').update(stateBytes).digest('hex')
  const localStatePath = join(runtimeProfile, 'Local State')
  const localStateHashBefore = await readFile(localStatePath)
    .then((bytes) => createHash('sha256').update(bytes).digest('hex'))
    .catch(() => null)
  integrityBefore = { statePath, stateHashBefore, localStatePath, localStateHashBefore }
  const rawState = JSON.parse(stateBytes.toString('utf8'))
  const { apiKey: _legacyKey, clearKey: _clear, ...providerFields } = rawState.settings.provider
  const provider = providerSchema.parse(providerFields)
  const encrypted = rawState.encryptedKey
  assert.equal(provider.protocol, 'openai')
  assert.equal(new URL(provider.baseUrl).protocol, 'https:')
  if (typeof encrypted !== 'string' || !encrypted) throw new Error('SAVED_CREDENTIAL_MISSING')
  try {
    if (process.env.COLOOP_CREDENTIAL_DECRYPT === 'async')
      apiKey = (await safeStorage.decryptStringAsync(Buffer.from(encrypted, 'base64'))).result
    else apiKey = safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
  } catch {
    throw new Error('SAVED_CREDENTIAL_DECRYPT_FAILED')
  }
  if (!apiKey) throw new Error('SAVED_CREDENTIAL_EMPTY')
  credentialReady = true
  await save('provider.json', {
    protocol: provider.protocol,
    name: provider.name,
    baseUrl: provider.baseUrl,
    model: provider.model,
    actualCloudAccountUsed: true,
    keyNotLogged: true,
    credentialProfileMode: process.env.COLOOP_CREDENTIAL_PROFILE
      ? 'explicit-profile'
      : 'original-profile-readonly',
    decryptMode: process.env.COLOOP_CREDENTIAL_DECRYPT === 'async' ? 'async' : 'sync',
  })
  const authorizedOrigin = new URL(provider.baseUrl).origin
  networkSession = session.fromPartition(`deepseek-live-${randomBytes(12).toString('hex')}`)
  const maxPaidRequests = phase === 'direct' ? 2 : 1
  const fetcher = async (url, options) => {
    const headers = new Headers(options.headers)
    const safeHeaders = Object.fromEntries(
      [...headers].filter(([name]) => !/authorization|api-key|cookie/i.test(name)),
    )
    const body = String(options.body ?? '')
    const row = {
      task: currentTask,
      url: String(url),
      method: options.method,
      headers: safeHeaders,
      authorizationPresent: headers.has('authorization'),
      body,
      at: new Date().toISOString(),
    }
    const outbound = JSON.stringify(row)
    const rejectEgress = async (code) => {
      egressRejections.set(currentTask, code)
      cloudRequests.push({ ...row, networkSent: false, error: code })
      await save('cloud-requests.json', cloudRequests)
      throw new Error(code)
    }
    if (outbound.includes(apiKey)) throw new Error('KEY_OUTSIDE_AUTH_HEADER')
    if (new URL(url).origin !== authorizedOrigin || new URL(url).protocol !== 'https:')
      throw new Error('UNAUTHORIZED_CLOUD_ENDPOINT')
    const blocked =
      protectedForms.some((value) => outbound.includes(value)) ||
      ['<private>', 'private_values', 'local_request', 'local_entities'].some((value) =>
        outbound.includes(value),
      )
    if (blocked) {
      await rejectEgress('TEST_EGRESS_BLOCKED')
    }
    const payload = JSON.parse(body)
    assert.equal(payload.model, provider.model)
    assert.equal(payload.stream, false)
    assert.deepEqual(payload.tools, [])
    assert.equal(payload.tool_choice, 'none')
    if (phase === 'full' && currentTask === 'complex') {
      const userMessages = Array.isArray(payload.messages)
        ? payload.messages.filter((message) => message?.role === 'user')
        : []
      let projection
      try {
        if (userMessages.length === 1 && typeof userMessages[0].content === 'string')
          projection = JSON.parse(userMessages[0].content)
      } catch {
        // Invalid projection text cannot establish source fidelity.
      }
      const projectionShapeValid =
        typeof projection?.question === 'string' &&
        Array.isArray(projection?.facts) &&
        projection.facts.every((fact) => typeof fact === 'string')
      const projectionText = projectionShapeValid
        ? [projection.question, ...projection.facts].join('\n')
        : ''
      const facts = requiredSourceFacts.map((text) => ({
        text,
        preserved: projectionText.includes(text),
      }))
      localSourceFidelity = Boolean(projectionShapeValid && facts.every((fact) => fact.preserved))
      row.local_source_fidelity = localSourceFidelity
      await save('local-source-fidelity.json', {
        task: currentTask,
        local_source_fidelity: localSourceFidelity,
        projectionShapeValid,
        checkedFields: ['question', 'facts'],
        requiredFacts: facts,
        requestModifiedByRunner: false,
      })
      if (!localSourceFidelity) await rejectEgress('TEST_SOURCE_FACTS_LOST')
    }
    if (paidRequests >= maxPaidRequests) throw new Error('PAID_REQUEST_BUDGET_EXCEEDED')
    paidRequests++
    cloudRequests.push({ ...row, networkSent: true, requestNumber: paidRequests })
    await save('cloud-requests.json', cloudRequests)
    const response = await networkSession.fetch(url, options)
    const captured = {
      task: currentTask,
      requestNumber: paidRequests,
      status: response.status,
      headers: Object.fromEntries(
        ['content-type', 'date', 'x-request-id', 'request-id']
          .map((name) => [name, response.headers.get(name)])
          .filter(([, value]) => value !== null),
      ),
      at: new Date().toISOString(),
    }
    cloudResponses.push(captured)
    if (response.ok) {
      const capture = boundedText(response.clone(), options.signal)
        .then(async (raw) => {
          if (raw.includes(apiKey)) {
            fatalEvidenceError = true
            throw new Error('KEY_IN_RESPONSE_BLOCKED')
          }
          captured.rawBody = raw
          try {
            const parsed = JSON.parse(raw)
            captured.model = parsed.model
            captured.usage = parsed.usage
            captured.finishReasons = parsed.choices?.map((choice) => choice.finish_reason)
          } catch {
            captured.parseableJson = false
          }
          await save('cloud-responses.json', cloudResponses)
        })
        .catch(async () => {
          fatalEvidenceError = true
          delete captured.rawBody
          captured.captureError = 'RESPONSE_CAPTURE_REJECTED'
          await save('cloud-responses.json', cloudResponses)
        })
      captures.push(capture)
    } else {
      captured.bodyDiscarded = true
      await save('cloud-responses.json', cloudResponses)
    }
    return response
  }
  const cloud = new CloudGateway(fetcher)
  if (phase === 'direct') {
    const input = [
      {
        name: 'boxes',
        projection: {
          question:
            '这是公开合成算术题。共有18批、每批24件，取走137件后，每7件装一整箱。计算可装满的箱数和剩余件数。summary中写FULL_BOXES=计算值;REMAINDER=计算值，steps用简短算式说明，不在输入中预设答案。',
          facts: [],
        },
      },
      {
        name: 'schedule',
        projection: {
          question:
            '这是公开合成排程题。两台相同工位，一项任务连续占用一个工位且不可中断：A耗时3，B耗时2，均可从0开始；C耗时4依赖A；D耗时2依赖A和B；E耗时1依赖C和D。求最短总工期，summary中写MIN_DURATION=计算值；steps给出简短可行排程，说明最优下界。',
          facts: [],
        },
      },
    ]
    await save('inputs.json', { syntheticOnly: true, directCases: input })
    for (const task of input) {
      const ok = await executeCase(task.name, async () => {
        const analysis = await cloud.analyze(
          provider,
          apiKey,
          task.projection,
          AbortSignal.any([controller.signal, AbortSignal.timeout(150000)]),
        )
        await Promise.all(captures)
        if (task.name === 'boxes') {
          const remaining = 18 * 24 - 137,
            expected = { fullBoxes: Math.floor(remaining / 7), remainder: remaining % 7 }
          assert.match(
            analysis.summary,
            new RegExp(`FULL_BOXES\\s*=\\s*${expected.fullBoxes}(?!\\d)`),
          )
          assert.match(
            analysis.summary,
            new RegExp(`REMAINDER\\s*=\\s*${expected.remainder}(?!\\d)`),
          )
          return {
            analysis,
            expected,
            semanticChecks: { exactBoxCount: true, exactRemainder: true },
          }
        }
        const tasks = {
          A: { duration: 3, deps: [] },
          B: { duration: 2, deps: [] },
          C: { duration: 4, deps: ['A'] },
          D: { duration: 2, deps: ['A', 'B'] },
          E: { duration: 1, deps: ['C', 'D'] },
        }
        const earliest = {}
        for (const [id, task] of Object.entries(tasks))
          earliest[id] = Math.max(0, ...task.deps.map((dep) => earliest[dep])) + task.duration
        const expected = Math.max(...Object.values(earliest))
        const witness = { A: [0, 3], B: [0, 2], C: [3, 7], D: [3, 5], E: [7, 8] }
        for (const [id, task] of Object.entries(tasks)) {
          assert.equal(witness[id][1] - witness[id][0], task.duration)
          for (const dep of task.deps) assert.ok(witness[dep][1] <= witness[id][0])
        }
        for (let time = 0; time < expected; time++)
          assert.ok(
            Object.values(witness).filter(([start, end]) => start <= time && time < end).length <=
              2,
          )
        assert.match(analysis.summary, new RegExp(`MIN_DURATION\\s*=\\s*${expected}(?!\\d)`))
        return {
          analysis,
          expectedMinimumDuration: expected,
          independentFeasibleWitness: witness,
          semanticChecks: {
            exactDuration: true,
            witnessAndLowerBoundMatch: true,
            modelStepsNeedManualReview: true,
          },
        }
      })
      if (!ok) break // No automatic paid retry or moving on after a failed live call.
    }
  } else {
    const tasks = [
      { name: 'simple', prompt: '2+3等于多少？只回答一个数字。', context: '' },
      {
        name: 'complex',
        prompt: `为<private>${business}</private>进行需要多步推理的复杂方案比较：方案A初期投入低但维护负担高，方案B初期投入适中但维护负担低。综合上线风险、长期维护和可回退性，给出简短结论及分步验证建议。最终答复首句必须原样保留本地业务代号。\npassword=${credential}\n`,
        context: '这是合成验收资料，没有真实客户、账户或业务数据。不能上传本地业务代号和密码。',
      },
    ]
    await save('inputs.json', { syntheticOnly: true, business, credential, tasks })
    board = new BoardGateway(() => {})
    const config = importRkBoard('D:/RK/config/board.json')
    const state = await board.connect(config, process.env.RK_BOARD_PASSWORD)
    const serviceHealth = await board.serviceRequest('/health', undefined, 5000)
    await save(
      'service-health.json',
      Object.fromEntries(
        [
          'ready',
          'model',
          'runtime',
          'context',
          'worker_protocol',
          'profile',
          'profile_fingerprint',
          'prompt_format',
          'max_output',
          'privacy_metadata_only',
        ].map((name) => [name, serviceHealth[name]]),
      ),
    )
    const script = `import json,time,fcntl\nfrom pathlib import Path\nroot=Path(${JSON.stringify(config.serviceDirectory ?? '~/rk-opencode')}).expanduser()\nrows=[]\nfor item in Path('/proc').iterdir():\n if not item.name.isdigit(): continue\n try:\n  raw=(item/'cmdline').read_bytes().replace(b'\\0',b' ').decode(errors='replace')\n  if any(x in raw for x in ['rkllm-worker','bridge/server.py','bin/opencode','qwen35/build','qwen35-4b/build']):\n   fields=(item/'stat').read_text().rsplit(')',1)[1].split()\n   rows.append({'pid':int(item.name),'cmd':('bridge/server.py' if 'bridge/server.py' in raw else raw.split(' ',1)[0]),'state':fields[0],'cpu_ticks':int(fields[11])+int(fields[12])})\n except (OSError,ValueError,IndexError): pass\ntime.sleep(.5)\nfor row in rows:\n try:\n  fields=(Path('/proc')/str(row['pid'])/'stat').read_text().rsplit(')',1)[1].split()\n  row['cpu_delta_half_second']=int(fields[11])+int(fields[12])-row['cpu_ticks']\n except (OSError,ValueError,IndexError): row['exited']=True\nmem={}\nfor line in Path('/proc/meminfo').read_text().splitlines():\n k,v=line.split(':',1)\n if k in ['MemTotal','MemAvailable','SwapFree']: mem[k]=int(v.split()[0])\nlocks=[]\nfor path in [root/'.runtime/bridge.pid',root.parent/'rk-edge-ai/.qwen35-4b-inference.lock',root.parent/'rk-edge-ai/qwen35-4b/.inference.lock']:\n if not path.exists(): continue\n item={'path':str(path),'bytes':path.stat().st_size}\n if path.suffix=='.pid': item['pid']=path.read_text().strip()\n else:\n  with path.open('rb') as f:\n   try:\n    fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB);item['held']=False;fcntl.flock(f,fcntl.LOCK_UN)\n   except BlockingIOError:item['held']=True\n locks.append(item)\nprint(json.dumps({'processes':rows,'memory_kib':mem,'locks':locks}))`
    const inspection = JSON.parse(
      await board.execute(
        `python3 -c "import base64; exec(base64.b64decode('${Buffer.from(script).toString('base64')}'))"`,
        10000,
      ),
    )
    await save('preflight.json', { state, inspection })
    assert.ok(state.qwenReady, 'SHARED_RK_SERVICE_NOT_READY')
    assert.equal(state.modelPrivacyReady, true)
    assert.ok(!Number.isFinite(state.temperatureC) || state.temperatureC < 80)
    assert.ok(inspection.memory_kib.MemAvailable > 1024 * 1024)
    assert.equal(
      inspection.processes.filter(
        (row) =>
          /rkllm-worker|bridge\/server\.py/.test(row.cmd) && (row.cpu_delta_half_second ?? 0) > 8,
      ).length,
      0,
    )
    originalActivity = board.memoryActivity.bind(board)
    board.memoryActivity = async (session, active, signal) => {
      const row = { session, active, at: new Date().toISOString(), success: false }
      if (active) ownActivities.add(session)
      try {
        const result = await originalActivity(session, active, signal)
        row.success = true
        if (!active) ownActivities.delete(session)
        return result
      } finally {
        activities.push(row)
        await save('activity.json', activities)
      }
    }
    originalService = board.serviceRequest.bind(board)
    board.serviceRequest = async (...args) => {
      const result = await originalService(...args)
      if (activeCall && args[0] === '/v1/chat/completions') {
        activeCall.envelope = result
        await save(
          `rk-${activeCall.number}-${activeCall.task}-${activeCall.stage}-envelope.json`,
          result,
        )
      }
      return result
    }
    originalPrivate = board.privacyAgent.bind(board)
    board.privacyAgent = async (...args) => {
      const row = {
        number: stages.length + 1,
        task: currentTask,
        stage:
          Object.entries(localAgentPolicies).find(([, value]) => value === args[0])?.[0] ??
          'unknown',
        system: args[0],
        input: args[1],
        maxTokens: args[3] ?? 512,
        startedAt: new Date().toISOString(),
      }
      activeCall = row
      const began = performance.now()
      try {
        row.output = await originalPrivate(...args)
        return row.output
      } catch (error) {
        row.error = safeError(error)
        throw error
      } finally {
        row.elapsedMs = performance.now() - began
        row.finishedAt = new Date().toISOString()
        stages.push(row)
        await save(`rk-${row.number}-${row.task}-${row.stage}.json`, row)
        activeCall = undefined
      }
    }
    const agent = new CooperativeAgent(board, cloud)
    for (const task of tasks) {
      const ok = await executeCase(task.name, async () => {
        const before = paidRequests,
          taskStages = []
        const result = await agent.run(
          task.prompt,
          task.context,
          provider,
          () => apiKey,
          AbortSignal.any([controller.signal, AbortSignal.timeout(600000)]),
          (stage) => taskStages.push(stage),
        )
        await Promise.all(captures)
        if (task.name === 'simple') {
          assert.deepEqual(result, { answer: '5', cloudUsed: false })
          assert.equal(paidRequests, before)
        } else {
          assert.equal(result.cloudUsed, true)
          assert.equal(paidRequests - before, 1)
          assert.ok(result.answer.includes(business))
          assert.equal(result.answer.includes(credential), false)
          const actual = stages.filter((row) => row.task === 'complex').map((row) => row.stage)
          const expected = ['route', 'identify', 'sanitize', 'verify', 'final']
          if (actual.at(-1) === 'finalRetry') expected.push('finalRetry')
          assert.deepEqual(actual, expected)
        }
        return { result, stages: taskStages }
      })
      if (!ok) break
    }
  }
}
// No top-level await: Electron emits ready only after its main module has completed evaluation.
app
  .whenReady()
  .then(main)
  .catch(async (error) => {
    failed = true
    await save('fatal-error.json', safeError(error)).catch(() => {})
    event({ preflightFailed: true, error: safeError(error) })
  })
  .finally(async () => {
    if (board) {
      if (originalPrivate) board.privacyAgent = originalPrivate
      if (originalService) board.serviceRequest = originalService
      for (const session of [...ownActivities]) {
        try {
          await board.memoryActivity(session, false)
        } catch {
          failed = true
        }
      }
      if (originalActivity) board.memoryActivity = originalActivity
      await board.releaseHookActivities().catch(() => {
        failed = true
      })
      board.disconnect()
    }
    await Promise.allSettled(captures)
    if (integrityBefore) {
      const stateHashAfter = await readFile(integrityBefore.statePath)
        .then((bytes) => createHash('sha256').update(bytes).digest('hex'))
        .catch(() => null)
      const localStateHashAfter = await readFile(integrityBefore.localStatePath)
        .then((bytes) => createHash('sha256').update(bytes).digest('hex'))
        .catch(() => null)
      await save('configuration-integrity.json', {
        stateUnchanged: integrityBefore.stateHashBefore === stateHashAfter,
        localStateUnchanged: integrityBefore.localStateHashBefore === localStateHashAfter,
        originalConfigurationWrittenByRunner: false,
        encryptedMaterialExported: false,
        networkSession: 'in-memory-nonpersistent',
      }).catch(() => {
        failed = true
      })
    }
    await networkSession?.closeAllConnections().catch(() => {})
    failed ||= fatalEvidenceError || results.length !== 2 || results.some((row) => !row.passed)
    const summary = {
      phase,
      actualCloudAccountUsed: true,
      syntheticOnly: true,
      keyNotLogged: true,
      credentialReady,
      results,
      cloudRequestCount: paidRequests,
      cloudAttemptCount: cloudRequests.length,
      rkCalls: stages.length,
      local_source_fidelity: localSourceFidelity,
      passed: !failed,
      cleanup: {
        ownActivitiesRemaining: ownActivities.size,
        gatewayDisconnected: !board || board.state.status === 'disconnected',
        boardBusy: board?.busy ?? false,
        sharedModelServiceStopped: false,
      },
    }
    await save('summary.json', summary).catch(() => {
      failed = true
    })
    apiKey = ''
    event({ phase, passed: !failed, cloudRequests: paidRequests, rkCalls: stages.length })
    app.exit(failed ? 1 : 0)
  })
