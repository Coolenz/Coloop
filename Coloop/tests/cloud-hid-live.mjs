// Explicit live acceptance; never included in Vitest. Uses the saved cloud provider.
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { createHash } from 'node:crypto'
import electron from 'electron'

if (!process.env.RK_BOARD_PASSWORD) throw new Error('RK_BOARD_PASSWORD_REQUIRED')
const root = resolve(import.meta.dirname, '..')
const output = process.env.COLOOP_RELAY_OUTPUT ?? `D:/RK/logs/cloud-hid-relay-${Date.now()}`
await mkdir(output, { recursive: false })
await mkdir(join(root, '.qa'), { recursive: true })
const snapshot = join(root, '.qa', `cloud-hid-live-${Date.now()}.mjs`)
await build({
  stdin: {
    contents: [
      "export { BoardGateway, importRkBoard } from './src/main/infrastructure/board.ts'",
      "export { CloudGateway } from './src/main/infrastructure/cloud.ts'",
      "export { CloudHIDRelay } from './src/main/services/cloud-hid-relay.ts'",
      "export { DesktopProcedureMemory } from './src/main/services/desktop-procedure-memory.ts'",
      "export { DesktopTaskService } from './src/main/services/desktop-tasks.ts'",
      "export { VioloopService, violoopIntentPolicy } from './src/main/services/violoop.ts'",
      "export { ControlIndicatorWindow } from './src/main/infrastructure/control-indicator.ts'",
    ].join('\n'),
    resolveDir: root,
    loader: 'ts',
  },
  outfile: snapshot,
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
})
const sources = [
  'src/main/services/cloud-hid-relay.ts',
  'src/main/services/cloud-ui-agent.ts',
  'src/main/services/desktop-tasks.ts',
  'src/main/services/violoop.ts',
  'src/main/services/desktop-procedure-memory.ts',
  'src/main/infrastructure/board.ts',
  'src/main/infrastructure/cloud.ts',
  'resources/browser-observer.py',
  'resources/browser-runtime.py',
  'resources/rk-cloud-agent.py',
  'src/main/services/browser-task.ts',
  'tests/cloud-hid-live-worker.mjs',
]
await writeFile(
  join(output, 'manifest.json'),
  JSON.stringify(
    {
      at: new Date().toISOString(),
      scope:
        process.env.COLOOP_RELAY_SEED_MEMORY_ONLY === '1'
          ? 'Explicit real Mem0 procedure write/read, no USB or cloud requests'
          : 'Real phone task service admission, actual Mem0 when enabled, paid cloud planning/review, actual USB HID; no physical phone transport in this test',
      hashes: Object.fromEntries(
        await Promise.all(
          sources.map(async (p) => [
            p,
            createHash('sha256')
              .update(await readFile(join(root, p)))
              .digest('hex'),
          ]),
        ),
      ),
    },
    null,
    2,
  ),
)
const env = { ...process.env, COLOOP_RELAY_OUTPUT: output, COLOOP_RELAY_SNAPSHOT: snapshot }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(electron, [join(root, 'tests/cloud-hid-live-worker.mjs')], {
  cwd: root,
  env,
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
})
child.stdout.on('data', (chunk) => {
  const s = chunk.toString()
  if (s.startsWith('RELAY_EVENT ')) process.stdout.write(s)
})
child.stderr.on('data', () => {})
const timeout = setTimeout(() => child.kill(), 660000)
const code = await new Promise((resolve) => child.on('exit', resolve))
clearTimeout(timeout)
console.log(JSON.stringify({ output, code }))
process.exitCode = code === 0 ? 0 : 1
