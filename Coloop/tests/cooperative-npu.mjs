// Explicit opt-in hardware acceptance. Never included by Vitest's *.test.ts pattern.
// Run from D:/Coloop with RK_BOARD_PASSWORD set only in this process environment.
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { build } from 'esbuild'

const root = resolve(import.meta.dirname, '..')
const startedAt = new Date().toISOString()
const stamp = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
})
  .format(new Date())
  .replace(/[^0-9]/g, '')
const output = resolve(process.env.COLOOP_NPU_OUTPUT ?? `D:/RK/logs/coloop-cooperative-${stamp}`)
if (!process.env.RK_BOARD_PASSWORD) throw new Error('RK_BOARD_PASSWORD is required')
await mkdir(output, { recursive: false })
const save = (name, value) =>
  writeFile(resolve(output, name), JSON.stringify(value, null, 2) + '\n')
const manifest = {
  startedAt,
  timeZone: 'Asia/Shanghai',
  output,
  fixture: 'real local HTTP, synthetic cloud response',
  paidCloudAccountUsed: false,
  realRkInference: true,
  sourceHashes: {},
  exitCode: 1,
}
const sources = [
  'src/main/infrastructure/board.ts',
  'src/main/infrastructure/cloud.ts',
  'src/main/services/cooperative.ts',
  'src/main/domain/privacy-vault.ts',
  'src/main/domain/strict-json.ts',
  'src/shared/contracts.ts',
  'tests/cooperative-npu.mjs',
]
for (const name of sources) {
  manifest.sourceHashes[name] = createHash('sha256')
    .update(await readFile(resolve(root, name)))
    .digest('hex')
}
await save('manifest.json', manifest)
await build({
  stdin: {
    contents: [
      "export { BoardGateway, importRkBoard } from './src/main/infrastructure/board.ts';",
      "export { CloudGateway } from './src/main/infrastructure/cloud.ts';",
      "export { CooperativeAgent, localAgentPolicies } from './src/main/services/cooperative.ts';",
    ].join('\n'),
    resolveDir: root,
    sourcefile: 'cooperative-npu-entry.ts',
    loader: 'ts',
  },
  outfile: resolve(output, 'production-snapshot.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  packages: 'external',
  sourcemap: true,
})
// Keep module resolution of external native dependencies anchored to the project.
const snapshot = resolve(root, '.qa', `cooperative-npu-${stamp}.mjs`)
await mkdir(resolve(root, '.qa'), { recursive: true })
await writeFile(snapshot, await readFile(resolve(output, 'production-snapshot.mjs')))
const { BoardGateway, importRkBoard, CloudGateway, CooperativeAgent, localAgentPolicies } =
  await import(`file:///${snapshot.replaceAll('\\', '/')}`)
const results = [],
  stages = [],
  activities = [],
  cloudRequests = [],
  cloudResponses = []
const ownActivities = new Set()
let taskName = '',
  callNumber = 0,
  activeCall
const board = new BoardGateway(() => {})
let server,
  originalService,
  originalPrivate,
  originalActivity,
  failed = false
const business = `项目${randomBytes(6).toString('hex')}`
const credential = `fixture-only-${randomBytes(12).toString('hex')}`
const tasks = [
  { name: 'simple', prompt: '2+3等于多少？只回答一个数字。', context: '' },
  {
    name: 'complex',
    prompt: `为<private>${business}</private>进行需要多步推理的复杂方案比较：方案A初期投入低但维护负担高，方案B初期投入适中但维护负担低。综合上线风险、长期维护和可回退性，给出简短结论及分步验证建议。最终答复首句必须原样保留本地业务代号。\npassword=${credential}\n`,
    context: '这是合成验收资料，没有真实客户、账户或业务数据。不能上传本地业务代号和密码。',
  },
]
await save('inputs.json', { business, credential, tasks, syntheticOnly: true })
try {
  const config = importRkBoard('D:/RK/config/board.json')
  const state = await board.connect(config, process.env.RK_BOARD_PASSWORD)
  const script = `import json,os,time,fcntl\nfrom pathlib import Path\nroot=Path(${JSON.stringify(config.serviceDirectory ?? '~/rk-opencode')}).expanduser()\nrows=[]\nfor item in Path('/proc').iterdir():\n if not item.name.isdigit(): continue\n try:\n  raw=(item/'cmdline').read_bytes().replace(b'\\0',b' ').decode(errors='replace')\n  if any(x in raw for x in ['rkllm-worker','bridge/server.py','bin/opencode','qwen35/build','qwen35-4b/build']):\n   fields=(item/'stat').read_text().rsplit(')',1)[1].split()\n   rows.append({'pid':int(item.name),'cmd':('bridge/server.py' if 'bridge/server.py' in raw else raw.split(' ',1)[0]),'state':fields[0],'cpu_ticks':int(fields[11])+int(fields[12])})\n except (OSError,ValueError,IndexError): pass\ntime.sleep(.5)\nfor row in rows:\n try:\n  fields=(Path('/proc')/str(row['pid'])/'stat').read_text().rsplit(')',1)[1].split()\n  row['cpu_delta_half_second']=int(fields[11])+int(fields[12])-row['cpu_ticks']\n except (OSError,ValueError,IndexError): row['exited']=True\nmem={}\nfor line in Path('/proc/meminfo').read_text().splitlines():\n k,v=line.split(':',1)\n if k in ['MemTotal','MemAvailable','SwapFree']: mem[k]=int(v.split()[0])\nlocks=[]\nfor path in [root/'.runtime/bridge.pid',root.parent/'rk-edge-ai/.qwen35-4b-inference.lock',root.parent/'rk-edge-ai/qwen35-4b/.inference.lock']:\n if not path.exists(): continue\n item={'path':str(path),'bytes':path.stat().st_size}\n if path.suffix=='.pid': item['pid']=path.read_text().strip()\n else:\n  with path.open('rb') as f:\n   try:\n    fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB);item['held']=False;fcntl.flock(f,fcntl.LOCK_UN)\n   except BlockingIOError:item['held']=True\n locks.append(item)\nprint(json.dumps({'processes':rows,'memory_kib':mem,'locks':locks}))`
  // Read-only inspection through the existing test-only transport; no extra inference process.
  const inspection = JSON.parse(
    await board.execute(
      `python3 -c "import base64; exec(base64.b64decode('${Buffer.from(script).toString('base64')}'))"`,
      10000,
    ),
  )
  await save('preflight.json', { state, inspection })
  const activeWorkers = inspection.processes.filter(
    (row) =>
      /rkllm-worker|bridge\/server\.py/.test(row.cmd) && (row.cpu_delta_half_second ?? 0) > 8,
  )
  assert.equal(activeWorkers.length, 0, 'Shared model appears active; do not interfere')
  assert.ok(inspection.memory_kib.MemAvailable > 1024 * 1024, 'Less than 1 GiB available RAM')
  if (!state.qwenReady) {
    const runningWorker = inspection.processes.some((row) => /rkllm-worker/.test(row.cmd))
    assert.equal(runningWorker, false, 'Existing worker not ready; do not replace it')
    await save('started-service.json', await board.startModelService())
  }
  assert.equal(board.state.modelPrivacyReady, true, 'RK service must declare metadata-only privacy')
  originalActivity = board.memoryActivity.bind(board)
  board.memoryActivity = async (session, active, signal) => {
    const record = { session, active, at: new Date().toISOString(), success: false }
    if (active) ownActivities.add(session)
    try {
      const result = await originalActivity(session, active, signal)
      record.success = true
      if (!active) ownActivities.delete(session)
      return result
    } catch (error) {
      record.error = { name: error.name, message: error.message }
      throw error
    } finally {
      activities.push(record)
      await save('activity.json', activities)
    }
  }
  originalService = board.serviceRequest.bind(board)
  board.serviceRequest = async (...args) => {
    try {
      const result = await originalService(...args)
      if (activeCall && args[0] === '/v1/chat/completions') {
        activeCall.envelope = result
        await save(
          `rk-${activeCall.number}-${activeCall.task}-${activeCall.stage}-envelope.json`,
          result,
        )
      }
      return result
    } catch (error) {
      if (activeCall) activeCall.serviceError = { name: error.name, message: error.message }
      throw error
    }
  }
  originalPrivate = board.privacyAgent.bind(board)
  board.privacyAgent = async (...args) => {
    const stage =
      Object.entries(localAgentPolicies).find(([, policy]) => policy === args[0])?.[0] ?? 'unknown'
    const record = {
      number: ++callNumber,
      task: taskName,
      stage,
      system: args[0],
      input: args[1],
      maxTokens: args[3] ?? 512,
      startedAt: new Date().toISOString(),
    }
    activeCall = record
    const began = performance.now()
    try {
      record.output = await originalPrivate(...args)
      return record.output
    } catch (error) {
      record.error = { name: error.name, message: error.message }
      throw error
    } finally {
      record.elapsedMs = performance.now() - began
      record.finishedAt = new Date().toISOString()
      stages.push(record)
      await save(`rk-${record.number}-${record.task}-${record.stage}.json`, record)
      activeCall = undefined
    }
  }
  server = createServer(async (request, response) => {
    try {
      let body = ''
      for await (const chunk of request) body += chunk
      const row = {
        task: taskName,
        path: request.url,
        headers: request.headers,
        body,
        at: new Date().toISOString(),
      }
      cloudRequests.push(row)
      await save('cloud-requests.json', cloudRequests)
      assert.equal(request.url, '/v1/chat/completions')
      const protectedForms = [business, credential].flatMap((value) => [
        value,
        encodeURIComponent(value),
        Buffer.from(value).toString('base64'),
        Buffer.from(value).toString('base64url'),
      ])
      for (const forbidden of [...protectedForms, '<private>', 'private_values', 'local_request'])
        assert.equal(
          JSON.stringify(row).includes(forbidden),
          false,
          `Forbidden data in cloud request: ${forbidden}`,
        )
      const data = JSON.parse(body)
      assert.equal(data.stream, false)
      assert.equal(data.max_tokens, 512)
      assert.deepEqual(data.tools, [])
      const analysis = {
        summary: '建议选择方案B，综合长期维护和回退风险进行验证。',
        steps: ['先小规模验证部署与回退，再比较维护负担。'],
        uncertainties: ['合成资料缺少实际成本和维护数据。'],
      }
      const envelope = {
        choices: [
          {
            finish_reason: 'stop',
            message: { role: 'assistant', content: JSON.stringify(analysis) },
          },
        ],
      }
      cloudResponses.push({ task: taskName, envelope })
      await save('cloud-responses.json', cloudResponses)
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(envelope))
    } catch (error) {
      cloudResponses.push({ error: { name: error.name, message: error.message } })
      response.writeHead(500, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'Synthetic fixture check failed' } }))
    }
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  const cloud = new CloudGateway()
  const agent = new CooperativeAgent(board, cloud)
  const configFixture = {
    protocol: 'openai',
    name: 'Synthetic loopback fixture',
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    model: 'synthetic-analysis-fixture',
  }
  for (const task of tasks) {
    taskName = task.name
    const record = {
      task: task.name,
      startedAt: new Date().toISOString(),
      passed: false,
      stages: [],
    }
    const began = performance.now(),
      priorCloud = cloudRequests.length
    try {
      const result = await agent.run(
        task.prompt,
        task.context,
        configFixture,
        () => '',
        AbortSignal.timeout(600000),
        (stage) => record.stages.push(stage),
      )
      record.result = result
      if (task.name === 'simple') {
        assert.deepEqual(result, { answer: '5', cloudUsed: false })
        assert.equal(cloudRequests.length - priorCloud, 0)
      } else {
        assert.equal(result.cloudUsed, true)
        assert.equal(cloudRequests.length - priorCloud, 1)
        assert.ok(
          result.answer.includes(business),
          'Local final answer must preserve private business canary',
        )
        assert.equal(result.answer.includes(credential), false)
        const actualStages = stages
          .filter((stage) => stage.task === 'complex')
          .map((stage) => stage.stage)
        const expectedStages = ['route', 'identify', 'sanitize', 'verify', 'final']
        if (actualStages.at(-1) === 'finalRetry') expectedStages.push('finalRetry')
        assert.deepEqual(actualStages, expectedStages)
      }
      record.passed = true
    } catch (error) {
      failed = true
      record.error = { name: error.name, message: error.message }
    } finally {
      record.elapsedMs = performance.now() - began
      record.finishedAt = new Date().toISOString()
      results.push(record)
      await save(`result-${task.name}.json`, record)
      process.stdout.write(
        JSON.stringify({
          task: task.name,
          passed: record.passed,
          stages: record.stages,
          error: record.error,
        }) + '\n',
      )
    }
  }
} catch (error) {
  failed = true
  await save('fatal-error.json', { name: error.name, message: error.message, stack: error.stack })
  process.stdout.write(JSON.stringify({ preflightFailed: true, error: error.message }) + '\n')
} finally {
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
  await board.releaseHookActivities().catch(() => {})
  board.disconnect()
  server?.closeAllConnections()
  if (server) await new Promise((done) => server.close(done))
  await unlink(snapshot)
  manifest.finishedAt = new Date().toISOString()
  manifest.exitCode = failed ? 1 : 0
  manifest.sourceHashesAfter = {}
  for (const name of sources)
    manifest.sourceHashesAfter[name] = createHash('sha256')
      .update(await readFile(resolve(root, name)))
      .digest('hex')
  await save('summary.json', {
    results,
    cloudRequestCount: cloudRequests.length,
    rkCalls: stages.length,
    passed: !failed,
    realCloudAccountUsed: false,
    cleanup: {
      gatewayDisconnected: board.state.status === 'disconnected',
      boardBusy: board.busy,
      fixtureClosed: !server?.listening,
      sharedModelServiceStopped: false,
      ownActivitiesRemaining: ownActivities.size,
      localScratchModuleRemoved: true,
    },
  })
  await save('manifest.json', manifest)
  process.stdout.write(JSON.stringify({ output, exitCode: manifest.exitCode }) + '\n')
  process.exitCode = manifest.exitCode
}
