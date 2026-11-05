import { app, safeStorage, session, clipboard } from 'electron'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { randomUUID, createHash } from 'node:crypto'
import { actualSentActions, evaluateTask } from './action-taskset-assertions.mjs'

const root = 'D:/Coloop',
  output = process.env.COLOOP_ACTION_OUTPUT
app.setPath('userData', process.env.APPDATA + '/coloop')
app.on('window-all-closed', () => {})
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')

async function main() {
  let board,
    ocr,
    capture,
    leases,
    key = '',
    activeCase = '',
    totalBudgetHit = false,
    exitCode = 1
  const results = [],
    cloudRows = []
  let persist = Promise.resolve()
  const save = (path, value) => {
    const text = JSON.stringify(value, null, 2)
    if (key && text.includes(key)) throw Error('KEY_IN_ARTIFACT')
    persist = persist.catch(() => {}).then(() => writeFile(output + '/' + path, text))
    return persist
  }
  const readJson = async (path) => JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''))
  const until = async (fn, seconds) => {
    const end = performance.now() + seconds * 1000
    while (performance.now() < end) {
      const value = await fn()
      if (value) return value
      await pause(80)
    }
    throw Error('CASE_TIMEOUT')
  }
  try {
    const taskset = await readJson(root + '/tests/action-taskset.json')
    const filter = process.env.COLOOP_ACTION_CASES?.split(',').filter(Boolean)
    if (filter?.some((id) => !taskset.tasks.some((task) => task.id === id)))
      throw Error('INVALID_CASE_FILTER')
    const tasks = taskset.tasks.filter((task) => !filter || filter.includes(task.id))
    const lib = await import(pathToFileURL(process.env.COLOOP_ACTION_LIB).href)
    const profile = await readJson(process.env.APPDATA + '/coloop/state.json')
    key = safeStorage.decryptString(Buffer.from(profile.encryptedKey, 'base64'))
    const net = session.fromPartition('action-taskset-' + randomUUID())
    const cloud = new lib.CloudGateway(async (url, init) => {
      if (cloudRows.length >= taskset.max_cloud_calls) {
        totalBudgetHit = true
        throw Error('SUITE_CLOUD_BUDGET')
      }
      if (
        cloudRows.filter((row) => row.case_id === activeCase).length >=
        taskset.max_cloud_calls_per_case
      )
        throw Error('CASE_CLOUD_BUDGET')
      const started = performance.now(),
        row = { case_id: activeCase, request: JSON.parse(init.body), started: Date.now() }
      cloudRows.push(row)
      try {
        const response = await net.fetch(url, init)
        row.status = response.status
        row.elapsed_ms = performance.now() - started
        if (response.ok) row.response = await response.clone().json()
        await save('cloud.json', cloudRows)
        return response
      } catch (error) {
        row.error = error.name
        row.elapsed_ms = performance.now() - started
        await save('cloud.json', cloudRows)
        throw error
      }
    })
    const agentSource = await readFile(root + '/resources/rk-proactive-agent.py', 'utf8')
    const fixtureSource = await readFile(root + '/tests/ActionTaskLab.cs')
    const exe = output + '/ActionTaskLab.exe'
    await promisify(execFile)(
      process.env.WINDIR + '/Microsoft.NET/Framework64/v4.0.30319/csc.exe',
      [
        '/nologo',
        '/target:winexe',
        '/out:' + exe.replaceAll('/', '\\'),
        '/reference:System.Windows.Forms.dll',
        '/reference:System.Drawing.dll',
        '/reference:System.Web.Extensions.dll',
        (root + '/tests/ActionTaskLab.cs').replaceAll('/', '\\'),
      ],
      { windowsHide: true },
    )
    await save('manifest.json', {
      suite: taskset.suite,
      route: taskset.route,
      case_ids: tasks.map((task) => task.id),
      scope:
        'Real explicit goals, configured cloud, RK native USB, actual screen capture/OCR and independent native fixture. No injected action plan or synthesized observation. Local Qwen execution forbidden. QA-only real Mem0 namespace, TTL300.',
      max_cloud_calls: taskset.max_cloud_calls,
      max_cloud_calls_per_case: taskset.max_cloud_calls_per_case,
      hashes: {
        agent: sha(agentSource),
        fixture: sha(fixtureSource),
        driver: sha(await readFile(root + '/tests/action-taskset-live-worker.mjs')),
        capture: sha(await readFile(root + '/src/main/infrastructure/foreground-observation.ts')),
        taskset: sha(await readFile(root + '/tests/action-taskset.json')),
      },
    })
    ocr = new lib.OcrEngine(
      () => 'D:/RK',
      root + '/resources/rapidocr-worker.py',
      () => {},
    )
    leases = new lib.ClipboardLeaseService(root + '/resources/clipboard-lease.ps1')
    board = new lib.BoardGateway(() => {})
    await save(
      'device.json',
      await board.connect(
        lib.importRkBoard('D:/RK/config/board.json'),
        process.env.RK_BOARD_PASSWORD,
      ),
    )
    let unknownInput = false
    for (const task of tasks) {
      if (totalBudgetHit || unknownInput) {
        results.push({
          id: task.id,
          status: 'not_attempted',
          reason: unknownInput ? 'prior_input_unknown' : 'suite_cloud_budget',
        })
        continue
      }
      activeCase = task.id
      await mkdir(output + '/' + task.id)
      await mkdir(output + '/' + task.id + '/fixture')
      const prefix = task.id + '/',
        folder = output + '/' + prefix + 'fixture',
        qaTag = 'qa:' + randomUUID().replaceAll('-', '')
      const events = [],
        states = [],
        observations = [],
        inputs = [],
        validations = [],
        clips = [],
        validationIndex = new Map()
      let lab, agent, initial, final, identity, recordedError
      const started = performance.now()
      try {
        // Visible window is the explicitly authorized independent test target.
        lab = spawn(
          exe,
          [folder, task.id, 'Coloop Action Lab ' + task.id + ' ' + qaTag.slice(-6)],
          { stdio: 'ignore' },
        )
        identity = await until(async () => {
          try {
            const row = await readJson(folder + '/identity.json')
            return row.pid === lab.pid && row.task_id === task.id ? row : null
          } catch {
            return null
          }
        }, 15)
        await save(prefix + 'identity.json', identity)
        capture = new lib.WindowsObservationCapture({
          recognize: (png, signal) => ocr.recognize(png, signal),
        })
        await capture.metadata(undefined, identity.window_id)
        initial = await readJson(folder + '/state.json')
        if (
          task.id === 'hover' &&
          (initial.mouse_enter_count !== 0 || initial.pointer_inside_on_shown === true)
        )
          throw Error('HOVER_ALREADY_ENTERED_BEFORE_TASK')
        await save(prefix + 'initial-fixture.json', initial)
        const observe = async () => {
          const meta = await capture.metadata()
          if (meta.process_id !== lab.pid || meta.window_id !== identity.window_id)
            throw Error('FIXTURE_NOT_FOREGROUND')
          const frame = await capture.captureFrame()
          if (!frame) throw Error('FIXTURE_FRAME_UNAVAILABLE')
          await writeFile(
            output + '/' + prefix + 'frame-' + observations.length + '.png',
            frame.png,
          )
          const view = await capture.recognize(frame)
          observations.push(view)
          await save(prefix + 'observations.json', observations)
          return view
        }
        // Only memory namespace is adapted. The fixture's state is NEVER passed to Agent/cloud.
        const adapter = `\nclass QAMemory:\n    def __init__(self,root,emit):\n        from memory_client import MemoryClient\n        self.client,self.emit,self.ids=MemoryClient(root),emit,set()\n    def call(self,args):\n        body=dict(args);op=body['op']\n        if op=='catalog':body['tags']=['${qaTag}']\n        elif op=='get_many':\n            if not set(body['ids']) <= self.ids:raise ValueError('qa_memory_id_scope')\n        elif op=='set':\n            body['key']='test:coloop:actions:${qaTag}'\n            body['tags']=['${qaTag}']+list(body.get('tags',[]))[:7]\n            body['ttl']=300\n        else:raise ValueError('qa_memory_operation')\n        row=self.client.call(body)\n        if op=='set' and row.get('id'):self.ids.add(row['id'])\n        self.emit({'type':'qa.memory','value':{'op':op,'result':row}})\n        return row\n\n`
        const injected = agentSource
          .replace('\ndef main():', adapter + '\ndef main():')
          .replace(
            'agent = Agent(root, emit)',
            'agent = Agent(root, emit, memory=QAMemory(root,emit))',
          )
        if (injected === agentSource || !injected.includes('memory=QAMemory(root,emit)'))
          throw Error('QA_MEMORY_ISOLATION_NOT_APPLIED')
        const script = output + '/' + prefix + 'rk-agent-qa.py'
        await writeFile(script, injected)
        const clipboardBefore = sha(await clipboard.readText())
        agent = new lib.ProactiveAgentService({
          script,
          available: () => true,
          assertStart: () => {},
          observe,
          openRuntime: async (source) => {
            const channel = await board.openDesktopRuntime(source)
            let pending = ''
            channel.on('data', (data) => {
              pending += data.toString()
              for (;;) {
                const at = pending.indexOf('\n')
                if (at < 0) break
                const line = pending.slice(0, at)
                pending = pending.slice(at + 1)
                try {
                  events.push(JSON.parse(line))
                  void save(prefix + 'events-live.json', events).catch(() => {})
                } catch {}
              }
            })
            return channel
          },
          cloud: (system, content, signal) =>
            cloud.relayText(profile.settings.provider, key, system, content, signal, {
              maxTokens: 4096,
              maxResponseBytes: 24000,
            }),
          input: async (op, view, value) => {
            if (op === 'input.validate') {
              const index = validationIndex.get(value.action_group_id) ?? 0
              validationIndex.set(value.action_group_id, index + 1)
              validations.push({ ...value, action_index: index })
            }
            const result =
              op === 'clipboard.verify'
                ? await capture.verifyText(view, value.action.text)
                : op === 'completion.verify'
                  ? value.evidence_mode === 'visible_text'
                    ? await capture.verifyVisibleText(view, value.expected_text)
                    : await capture.verifyCurrentText(view, value.expected_text)
                  : op === 'input.guard'
                    ? await capture.guard(view, value.action)
                    : await capture.validate(view, value.action)
            inputs.push({ op, ...value, result })
            await save(prefix + 'input.json', inputs)
            return result
          },
          clipboard: async (op, value) => {
            const result = await leases.call(op, value)
            clips.push({ op, lease_id: value.lease_id, result })
            await save(prefix + 'clipboard.json', clips)
            return result
          },
          releaseClipboard: (id) => leases.releaseTask(id),
          prepareInput: async () => {},
          onChange: () => {
            if (agent) {
              states.push({ ...agent.snapshot(), at_ms: performance.now() })
              void save(prefix + 'states-live.json', states).catch(() => {})
            }
          },
        })
        const taskId = await agent.startTask(task.goal)
        await until(() => {
          const state = agent.snapshot()
          if (state.question) throw Error('UNEXPECTED_CLARIFICATION')
          return state.taskId === taskId && !state.active ? state : null
        }, 120)
        final = await readJson(folder + '/state.json')
        const actions = actualSentActions(events, validations)
        const independent = evaluateTask(task, initial, final, actions)
        const modelCalls = events
          .filter((event) => event.type === 'model.timing')
          .map((event) => event.value)
        const restored = sha(await clipboard.readText()) === clipboardBefore
        const state = agent.snapshot()
        const errors = [...independent.errors]
        if (state.phase !== 'completed')
          errors.push('agent_phase:' + state.phase + ':' + (state.error ?? ''))
        if (modelCalls.some((call) => call.stage !== 'classify'))
          errors.push('local_execution_model_ran')
        if (!restored) errors.push('clipboard_not_restored')
        if (state.phase === 'input_unknown') unknownInput = true
        results.push({
          id: task.id,
          goal: task.goal,
          status: errors.length ? 'failed' : 'passed',
          errors,
          agent: state,
          independent,
          actual_actions: actions,
          local_model_calls: modelCalls,
          clipboard_restored: restored,
          elapsed_ms: Math.round(performance.now() - started),
          cloud_calls: cloudRows.filter((row) => row.case_id === task.id).length,
          qa_tag: qaTag,
          evidence_source: 'independent_native_fixture_events',
        })
      } catch (error) {
        recordedError = error
        results.push({
          id: task.id,
          goal: task.goal,
          status: 'failed',
          reason: error.message,
          agent: agent?.snapshot(),
          elapsed_ms: Math.round(performance.now() - started),
          actual_actions: actualSentActions(events, validations),
          cloud_calls: cloudRows.filter((row) => row.case_id === task.id).length,
        })
      } finally {
        await agent?.stop().catch(() => {})
        await agent?.dispose().catch(() => {})
        capture?.dispose()
        capture = undefined
        if (!final && lab)
          try {
            final = await readJson(folder + '/state.json')
          } catch {}
        if (final) await save(prefix + 'final-fixture.json', final)
        await save(prefix + 'events.json', events)
        await save(prefix + 'states.json', states)
        await save(prefix + 'validations.json', validations)
        await save(prefix + 'input.json', inputs)
        await save(prefix + 'clipboard.json', clips)
        await save(prefix + 'result.json', results.at(-1))
        if (recordedError)
          await save(prefix + 'failure.json', {
            error: recordedError.message,
            stack: recordedError.stack,
          })
        if (lab) {
          const exited = new Promise((resolve) => lab.once('exit', resolve))
          lab.kill()
          await Promise.race([exited, pause(1500)])
        }
        await save('results-live.json', results)
        console.log(
          JSON.stringify({
            case: task.id,
            status: results.at(-1).status,
            reason: results.at(-1).reason,
            errors: results.at(-1).errors,
          }),
        )
      }
    }
    const coverage = {}
    for (const result of results)
      for (const action of result.actual_actions ?? [])
        coverage[action.action] = (coverage[action.action] ?? 0) + 1
    const ok =
      results.length === tasks.length && results.every((result) => result.status === 'passed')
    await save('results.json', {
      ok,
      suite: taskset.suite,
      route: taskset.route,
      cloud_calls: cloudRows.length,
      cloud_budget: taskset.max_cloud_calls,
      coverage,
      results,
    })
    exitCode = ok ? 0 : 1
  } catch (error) {
    await save('suite-failure.json', { error: error.message, stack: error.stack })
    console.log(JSON.stringify({ suite_error: error.message }))
  } finally {
    await leases?.dispose().catch(() => {})
    capture?.dispose()
    ocr?.dispose()
    board?.disconnect()
    await persist.catch(() => {})
    console.log(JSON.stringify({ exitCode, output, cloudCalls: cloudRows.length }))
    app.exit(exitCode)
  }
}
app
  .whenReady()
  .then(main)
  .catch((error) => {
    console.log(JSON.stringify({ error: error.message }))
    app.exit(1)
  })
