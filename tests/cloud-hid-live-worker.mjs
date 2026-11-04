import { app, safeStorage, session } from 'electron'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'

const root = resolve(import.meta.dirname, '..')
const output = process.env.COLOOP_RELAY_OUTPUT
const profile = join(process.env.APPDATA, 'coloop')
const rkAgentMode = process.env.COLOOP_RELAY_AGENT_LOCATION === 'rk'
app.setPath('userData', profile)
app.on('window-all-closed', () => {})
let board,
  desktop,
  indicator,
  phone,
  key = ''
const runtimePackets = []
const memoryCalls = []
let submittedAtMs, terminalAtMs, businessVerifiedAtMs, submittedAt
const events = [],
  cloudCalls = [],
  rkCalls = []
const save = async (name, value) => {
  const text = JSON.stringify(value, null, 2)
  if (key && text.includes(key)) throw new Error('KEY_IN_EVIDENCE')
  await writeFile(join(output, name), text)
}
const event = (value) => {
  events.push({ at: new Date().toISOString(), ...value })
  process.stdout.write('RELAY_EVENT ' + JSON.stringify(value) + '\n')
}
const until = async (fn, timeout) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error('LIVE_TIMEOUT')
}
let stateHash,
  failed = false
async function main() {
  try {
    const lib = await import(pathToFileURL(process.env.COLOOP_RELAY_SNAPSHOT).href)
    const stateBytes = await readFile(join(profile, 'state.json'))
    stateHash = createHash('sha256').update(stateBytes).digest('hex')
    const state = JSON.parse(stateBytes)
    key = safeStorage.decryptString(Buffer.from(state.encryptedKey, 'base64'))
    if (!key) throw new Error('CLOUD_KEY_UNAVAILABLE')
    const network = session.fromPartition('cloud-hid-live-' + randomUUID())
    const cloud = new lib.CloudGateway(async (url, init) => {
      if (cloudCalls.length >= 24) throw new Error('CLOUD_CALL_LIMIT')
      const row = { request: JSON.parse(init.body), response: null }
      cloudCalls.push(row)
      let response
      try {
        response = await network.fetch(url, init)
      } catch (error) {
        row.error = error.message
        await save('cloud.json', cloudCalls)
        throw error
      }
      row.status = response.status
      if (!response.ok) {
        const body = await response
          .clone()
          .json()
          .catch(() => ({}))
        row.error = {
          code: body.error?.code,
          type: body.error?.type,
          message: body.error?.message?.slice(0, 400),
        }
      }
      if (response.ok) row.response = await response.clone().json()
      await save('cloud.json', cloudCalls)
      return response
    })
    board = new lib.BoardGateway(() => {})
    const device = await board.connect(
      lib.importRkBoard('D:/RK/config/board.json'),
      process.env.RK_BOARD_PASSWORD,
    )
    await save('device.json', device)
    const open = board.openDesktopRuntime.bind(board)
    board.openDesktopRuntime = async (source) => {
      const channel = await open(source)
      let buffer = ''
      channel.on('data', (chunk) => {
        buffer += chunk.toString('utf8')
        let end
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end)
          buffer = buffer.slice(end + 1)
          try {
            const packet = JSON.parse(line)
            runtimePackets.push(packet)
            if (
              packet.type === 'request' &&
              packet.op === 'relay_review' &&
              packet.value?.verified === true
            )
              businessVerifiedAtMs ??= performance.now()
            if (packet.type === 'business_verified' && packet.verified === true)
              businessVerifiedAtMs ??= performance.now()
          } catch {}
        }
      })
      return channel
    }
    if (!device.qwenReady || !device.modelPrivacyReady) throw new Error('RK_NOT_READY')
    const procedureMemory =
      process.env.COLOOP_RELAY_MEMORY === '1'
        ? new lib.DesktopProcedureMemory({
            call: async (input) => {
              const row = { op: input.op, startedAt: new Date().toISOString() }
              memoryCalls.push(row)
              try {
                row.result = await board.desktopProcedureMemory(input)
                return row.result
              } finally {
                row.finishedAt = new Date().toISOString()
                await save('memory.json', memoryCalls)
              }
            },
          })
        : undefined
    if (process.env.COLOOP_RELAY_SEED_MEMORY_ONLY === '1') {
      if (!procedureMemory) throw new Error('MEMORY_NOT_ENABLED')
      const evidence = process.env.COLOOP_RELAY_MEMORY_EVIDENCE
      const proof = JSON.parse(await readFile(evidence, 'utf8'))
      if (
        !proof.singleContinuousRun ||
        !proof.businessResult?.verified ||
        !Object.values(proof.businessResult.states).every((v) => v === true)
      )
        throw new Error('PROCEDURE_EVIDENCE_NOT_VERIFIED')
      await procedureMemory.remember(
        evidence,
        proof.timing.commandToEndMs,
        'command_to_end',
        new AbortController().signal,
        proof.cloudReview,
      )
      const recalled = await procedureMemory.recall(
        '打开bilibili，点击主页的一个任意视频，然后三连点赞',
        new AbortController().signal,
      )
      if (!recalled) throw new Error('MEMORY_READBACK_FAILED')
      await save('seed-result.json', recalled)
      return
    }
    const rk = async (system, content, signal, tokens) => {
      const row = { system, content, tokens, startedAt: new Date().toISOString() }
      rkCalls.push(row)
      try {
        row.response = await board.privacyAgent(system, content, signal, tokens)
        return row.response
      } catch (e) {
        row.error = e.message
        throw e
      } finally {
        row.finishedAt = new Date().toISOString()
        await save('rk.json', rkCalls)
        await save('runtime.json', runtimePackets)
      }
    }
    const procedures = process.env.COLOOP_RELAY_PROCEDURES ?? join(output, 'procedures')
    if (process.env.COLOOP_RELAY_SEED) {
      await mkdir(procedures, { recursive: true })
      await writeFile(
        join(procedures, 'open-bilibili-mouse.json'),
        await readFile(process.env.COLOOP_RELAY_SEED),
        { flag: 'wx' },
      )
    }
    const relay = new lib.CloudHIDRelay({
      workflowMode:
        process.env.COLOOP_RELAY_WORKFLOW === 'semantic-plan' ? 'semantic-plan' : 'stepwise',
      procedureMemory,
      directory: procedures,
      cloud: async (system, content, signal) => {
        try {
          return await cloud.relay(state.settings.provider, key, system, content, signal)
        } catch (error) {
          await save('relay-error.json', { message: error.message })
          throw error
        }
      },
      rk,
    })
    indicator = new lib.ControlIndicatorWindow({
      preloadPath: join(root, 'out/preload/control.cjs'),
      rendererPath: join(root, 'out/renderer/index.html'),
      onStop: async () => phone?.stop(),
      onOpenMain: () => {},
    })
    let last = ''
    desktop = new lib.DesktopTaskService({
      board,
      workspace: () => 'D:/RK',
      resources: join(root, 'resources'),
      directory: join(output, 'desktop'),
      relay: rkAgentMode ? undefined : relay,
      agentLocation: rkAgentMode ? 'rk' : 'host',
      forwardCloud: (system, content, signal) =>
        cloud.relayText(state.settings.provider, key, system, content, signal),
      assertObservation: () => {},
      assertStart: () => {},
      prepareInput: () =>
        indicator.update({
          mode: 'controlling',
          title: 'RK USB 云端试验',
          detail: '打开 Chrome → Bilibili',
          sessionCount: 1,
        }),
      plan: async () => {
        throw new Error('WRONG_PLANNER')
      },
      onChange: () => {
        phone?.observeDesktop()
        const state = desktop.snapshot()
        const next = JSON.stringify(state)
        if (next !== last) {
          last = next
          event({ phase: state.phase, steps: state.steps, error: state.error })
        }
      },
    })
    phone = new lib.VioloopService({
      directory: join(output, 'phone'),
      encrypt: (value) => value,
      decrypt: (value) => value,
      desktop,
      assertAvailable: () => {},
      understand: (content, signal) => rk(lib.violoopIntentPolicy, content, signal, 192),
      browserAgentLocation: rkAgentMode ? 'rk' : 'host',
      recallProcedure:
        !rkAgentMode && procedureMemory
          ? (goal, signal) => relay.recallProcedure(goal, signal)
          : undefined,
      onChange: () => {
        if (submittedAtMs !== undefined && phone && !phone.active)
          terminalAtMs ??= performance.now()
      },
    })
    if (process.env.COLOOP_RELAY_RESUME_VIDEO) {
      const start = desktop.start.bind(desktop)
      const resumeVideo = JSON.parse(process.env.COLOOP_RELAY_RESUME_VIDEO)
      desktop.start = (input) => start({ ...input, resumeVideo })
      await save('resume.json', resumeVideo)
    }
    const goal = process.env.COLOOP_RELAY_GOAL ?? '打开 Bilibili'
    await save('input.json', { goal, authorizeInput: true, physicalPhoneUsed: false })
    submittedAt = new Date().toISOString()
    submittedAtMs = performance.now()
    const accepted = phone.submit(
      { text: goal, authorizeInput: true, commandId: randomUUID() },
      randomUUID(),
    )
    event({ receipt: accepted.id })
    await until(() => !phone.active, 600000)
    const result = {
      phone: phone.snapshot().tasks[0],
      desktop: desktop.snapshot(),
      events,
      cloudCalls: cloudCalls.length,
      rkCalls: rkCalls.length,
      inputBackend: 'rk_usb_hid',
      physicalPhoneUsed: false,
      procedureMemoryEnabled: !!procedureMemory || rkAgentMode,
      agentLocation: rkAgentMode ? 'rk' : 'host',
      hostProcedureMemoryCalls: memoryCalls.length,
      rkAgentMetadata: runtimePackets.find((p) => p.type === 'agent_ready') ?? null,
      workflowMode:
        process.env.COLOOP_RELAY_WORKFLOW === 'semantic-plan' ? 'semantic-plan' : 'stepwise',
      timing: {
        boundary:
          'Immediately before production phone task service submit -> terminal task notification, one PC monotonic clock',
        submittedAt,
        commandToEndMs: terminalAtMs - submittedAtMs,
        commandToBusinessVerifiedMs:
          businessVerifiedAtMs === undefined ? null : businessVerifiedAtMs - submittedAtMs,
        businessVerifiedToEndMs:
          businessVerifiedAtMs === undefined ? null : terminalAtMs - businessVerifiedAtMs,
      },
    }
    await save('summary.json', result)
    if (result.phone.state !== 'completed') throw new Error('TASK_NOT_COMPLETED')
    if (rkAgentMode) {
      const episode = runtimePackets.find((p) => p.type === 'agent_episode')
      if (!episode || result.desktop.agentLocation !== 'rk')
        throw Error('RK_AGENT_EVIDENCE_MISSING')
      await save('procedure.json', episode.episode)
      await save(
        'rk-agent.json',
        runtimePackets.filter((p) => p.type.startsWith('agent_')),
      )
    } else {
      await save(
        'procedure.json',
        JSON.parse(
          await readFile(
            join(
              procedures,
              goal.includes('三连')
                ? 'bilibili-video-triple-mouse.json'
                : 'open-bilibili-mouse.json',
            ),
            'utf8',
          ),
        ),
      )
    }
  } catch (error) {
    failed = true
    await save('failure.json', {
      message: key && error.message.includes(key) ? 'REDACTED' : error.message,
      events,
    })
  } finally {
    await phone?.stop().catch(() => {})
    indicator?.dispose()
    board?.disconnect()
    await save('rk.json', rkCalls)
    await save('cloud.json', cloudCalls)
    await save('runtime.json', runtimePackets)
    await save('integrity.json', {
      stateUnchanged:
        stateHash ===
        createHash('sha256')
          .update(await readFile(join(profile, 'state.json')))
          .digest('hex'),
    })
    app.exit(failed ? 1 : 0)
  }
}
// Electron emits ready only after main module evaluation; never top-level-await it.
app
  .whenReady()
  .then(main)
  .catch(() => app.exit(1))
