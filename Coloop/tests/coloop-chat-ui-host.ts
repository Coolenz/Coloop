/** Explicit local QA backend: real protocol/admission, simulated RK inference and HID. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { VioloopService } from '../src/main/services/violoop'
import { RemoteGatewayService } from '../src/main/services/remote-gateway'
import { desktopRequestSchema, type DesktopSnapshot } from '../src/shared/desktop'

const directory = resolve(process.env.COLOOP_VIOLOOP_QA_DIR ?? '.qa/coloop-chat-ui')
mkdirSync(directory, { recursive: true })
const hostName = `Coloop 界面验收 ${basename(directory)}`
let gate = 'ready'
let snapshots = 0,
  uncertainSubmissions = 0
let state: DesktopSnapshot = { phase: 'idle', active: false, steps: 0, maxSteps: 8, events: [] }
let stopped = false,
  started = 0,
  inferenceCalls = 0
let violoop: VioloopService
const timers = new Set<ReturnType<typeof setTimeout>>()
function save() {
  writeFileSync(
    join(directory, 'state.json'),
    JSON.stringify(
      {
        scope: 'Real Android + AES-GCM RPC + real admission. RK model and HID are simulated.',
        hostName,
        gate,
        snapshots,
        uncertainSubmissions,
        started,
        inferenceCalls,
        stopped,
        desktop: state,
        violoop: violoop?.snapshot(),
      },
      null,
      2,
    ),
  )
}
const desktop = {
  windows: async () => ['Coloop QA Lab'],
  snapshot: () => structuredClone(state),
  start: (input: unknown) => {
    desktopRequestSchema.parse(input)
    started++
    state = {
      phase: 'preparing',
      active: true,
      taskId: randomUUID(),
      steps: 0,
      maxSteps: 8,
      events: [],
    }
    const id = state.taskId
    for (const [phase, ms] of [
      ['observing', 500],
      ['planning', 1000],
      ['executing', 3000],
      ['verifying', 12000],
      ['completed', 15000],
    ] as const) {
      const timer = setTimeout(() => {
        timers.delete(timer)
        if (state.taskId !== id || !state.active) return
        state = {
          ...state,
          phase,
          active: phase !== 'completed',
          planningSource: 'local',
          steps: phase === 'completed' ? 1 : 0,
        }
        violoop.observeDesktop()
        save()
      }, ms)
      timers.add(timer)
    }
    save()
    return id!
  },
  stop: async () => {
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
    if (state.active) state = { ...state, phase: 'cancelled', active: false }
    violoop.observeDesktop()
    save()
  },
}
violoop = new VioloopService({
  directory: join(directory, 'private-tasks'),
  desktop,
  encrypt: (text) => Buffer.from(text).toString('base64'),
  decrypt: (text) => Buffer.from(text, 'base64').toString(),
  assertAvailable: () => {
    if (stopped) throw new Error('CONTROL_STOPPED')
    if (gate === 'connecting') throw new Error('正在自动连接 RK')
  },
  understand: async (content, signal) => {
    inferenceCalls++
    const { text } = JSON.parse(content)
    if (/^hello/i.test(String(text)))
      return JSON.stringify({
        kind: 'reply',
        message: '你好，我是 Coloop。告诉我你想让电脑完成什么任务。',
      })
    if (String(text).startsWith('FAIL')) throw new Error('QA_SIMULATED_FAILURE')
    const slow = String(text).includes('STOP')
    await new Promise<void>((complete, reject) => {
      const timer = setTimeout(complete, slow ? 30_000 : 300)
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer)
          reject(new Error('Cancelled'))
        },
        { once: true },
      )
    })
    if (String(text).includes('QQ'))
      return JSON.stringify({
        kind: 'clarify',
        message: '当前尚未支持跨应用邮件流程；请先用已打开窗口内的任务验证连接。此为模拟验收。',
      })
    return JSON.stringify({
      kind: 'desktop',
      windowTitle: 'Coloop QA Lab',
      expectedText: 'Applied: 1234',
    })
  },
  onChange: save,
})
const gateway = new RemoteGatewayService({
  directory: join(directory, 'private-devices'),
  encrypt: (text) => Buffer.from(text).toString('base64'),
  decrypt: (text) => Buffer.from(text, 'base64').toString(),
  onChange: () => {},
  hostName,
  getSnapshot: () => {
    snapshots++
    save()
    if (gate === 'snapshot-fail') throw new Error('QA_SNAPSHOT_FAILURE')
    return {
      hostName,
      sessionControl: {
        stopped,
        controlActive: gate === 'snapshot-active' || violoop.active,
        unconfirmedCount: 0,
        sessions: [],
        commands: [],
      },
      progress: [],
      violoop: gate === 'old' ? undefined : violoop.snapshot(),
      connection:
        gate === 'old'
          ? undefined
          : {
              rk: gate === 'connecting' ? ('connecting' as const) : ('ready' as const),
              message:
                gate === 'connecting' ? 'RK 已连接，正在启动本地模型' : 'RK 已连接，可以发送消息',
              autoConnect: true,
              phase: gate === 'connecting' ? ('starting_model' as const) : ('ready' as const),
            },
    }
  },
  command: async () => {
    throw new Error('NO_NATIVE_SESSIONS')
  },
  violoopMessage: (input, deviceId) => {
    if (process.env.COLOOP_QA_ADMISSION_FAULT === '1' && input.text.startsWith('UNCERTAIN')) {
      uncertainSubmissions++
      gate = 'snapshot-fail'
      save()
      throw new Error('QA_UNCERTAIN_ADMISSION')
    }
    return violoop.submit(input, deviceId)
  },
  stop: async () => {
    stopped = true
    await violoop.stop()
    save()
  },
  resume: async () => {
    stopped = false
    save()
  },
  reconnect: () => {
    gate = 'connecting'
    setTimeout(() => {
      gate = 'ready'
      save()
    }, 3000)
  },
})
const { url } = await gateway.start()
const invitation = gateway.createPairing('https://qa.example')
const endpoint = url.replace('127.0.0.1', '10.0.2.2')
const payload = { ...invitation.payload, endpoint }
writeFileSync(
  join(directory, 'pairing.txt'),
  'coloop://pair?data=' + Buffer.from(JSON.stringify(payload)).toString('base64url'),
  { mode: 0o600 },
)
save()
console.log('Violoop Android QA host ready. Simulated RK/HID; private invitation stored locally.')
const commandPoll = setInterval(() => {
  let request = ''
  try {
    request = readFileSync(join(directory, 'request.txt'), 'utf8').trim()
  } catch {
    return
  }
  if (['ready', 'connecting', 'old', 'snapshot-fail', 'snapshot-active'].includes(request)) {
    gate = request
    writeFileSync(join(directory, 'request.txt'), '')
    save()
    return
  }
  if (request !== 'stop') return
  clearInterval(commandPoll)
  void (async () => {
    await violoop.stop()
    await gateway.dispose()
    save()
  })()
}, 500)
