// Explicit RK + paid cloud + real Mem0 + isolated native HID acceptance; never in Vitest.
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import electron from 'electron'

if (!process.argv.includes('--hid-lab')) throw Error('EXPLICIT_HID_LAB_FLAG_REQUIRED')
if (!process.env.RK_BOARD_PASSWORD) throw Error('RK_BOARD_PASSWORD_REQUIRED')
const output = process.env.COLOOP_AGENT_STATE_OUTPUT
if (!output) throw Error('NEW_OUTPUT_DIRECTORY_REQUIRED')
await mkdir(output, { recursive: false })
const snapshot = 'D:/Coloop/.qa/rk-agent-state-live-lib-' + Date.now() + '.mjs'
await build({
  stdin: {
    contents: [
      "export { BoardGateway, importRkBoard } from './src/main/infrastructure/board.ts'",
      "export { CloudGateway } from './src/main/infrastructure/cloud.ts'",
    ].join('\n'),
    resolveDir: 'D:/Coloop',
    loader: 'ts',
  },
  outfile: snapshot,
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
})
const files = [
  'resources/rk-cloud-agent.py',
  'resources/browser-runtime.py',
  'tests/rk-agent-state-live.mjs',
  'tests/rk-agent-state-worker.mjs',
  'tests/rk-agent-state-observer.py',
  'src/main/infrastructure/cloud.ts',
]
const hashes = Object.fromEntries(
  await Promise.all(
    files.map(async (file) => [
      file,
      createHash('sha256')
        .update(await readFile('D:/Coloop/' + file))
        .digest('hex'),
    ]),
  ),
)
hashes['D:/RK/rk-opencode/pc/AgentLab.cs'] = createHash('sha256')
  .update(await readFile('D:/RK/rk-opencode/pc/AgentLab.cs'))
  .digest('hex')
await writeFile(
  output + '/manifest.json',
  JSON.stringify(
    {
      hashes,
      scope:
        'Real RK/USB/cloud/Mem0; synthetic Bilibili observations mapped to an isolated WinForms Apply button. Not a real Bilibili or physical-phone acceptance.',
    },
    null,
    2,
  ),
)
const env = { ...process.env, COLOOP_AGENT_STATE_LIB: snapshot }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(electron, ['D:/Coloop/tests/rk-agent-state-worker.mjs'], {
  cwd: 'D:/Coloop',
  env,
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
})
let stdout = '',
  stderr = ''
child.stdout.on('data', (chunk) => {
  stdout += chunk.toString()
})
child.stderr.on('data', (chunk) => {
  stderr += chunk.toString()
})
const timer = setTimeout(() => child.kill(), 180000)
const code = await new Promise((resolve) => child.on('exit', resolve))
clearTimeout(timer)
await writeFile(output + '/driver.json', JSON.stringify({ code, stdout, stderr }, null, 2))
console.log(JSON.stringify({ output, code, stdout }))
process.exitCode = code === 0 ? 0 : 1
