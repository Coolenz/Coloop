// Explicit paid-account acceptance. Not selected by Vitest.
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { build } from 'esbuild'
import electronBinary from 'electron'

const root = resolve(import.meta.dirname, '..')
const phase =
  process.argv.find((value) => value.startsWith('--phase='))?.slice(8) ??
  process.env.COLOOP_LIVE_PHASE ??
  'direct'
if (!['direct', 'full'].includes(phase)) throw new Error('LIVE_PHASE_MUST_BE_DIRECT_OR_FULL')
if (phase === 'full' && !process.env.RK_BOARD_PASSWORD)
  throw new Error('RK_BOARD_PASSWORD_REQUIRED')
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
const output = resolve(
  process.env.COLOOP_LIVE_OUTPUT ?? `D:/RK/logs/coloop-deepseek-${phase}-${stamp}`,
)
await mkdir(output, { recursive: false })
await mkdir(resolve(output, 'isolated-profile'))
const save = (name, value) =>
  writeFile(resolve(output, name), JSON.stringify(value, null, 2) + '\n')
const sources = [
  'src/main/infrastructure/board.ts',
  'src/main/infrastructure/cloud.ts',
  'src/main/services/cooperative.ts',
  'src/main/domain/privacy-vault.ts',
  'src/main/domain/cloud-spans.ts',
  'src/main/domain/strict-json.ts',
  'src/shared/contracts.ts',
  'tests/deepseek-live.mjs',
  'tests/deepseek-live-worker.mjs',
]
const hashes = async () =>
  Object.fromEntries(
    await Promise.all(
      sources.map(async (path) => [
        path,
        createHash('sha256')
          .update(await readFile(resolve(root, path)))
          .digest('hex'),
      ]),
    ),
  )
const manifest = {
  startedAt: new Date().toISOString(),
  timeZone: 'Asia/Shanghai',
  output,
  phase,
  actualCloudAccountUsed: true,
  syntheticOnly: true,
  keyNotLogged: true,
  realRkInference: phase === 'full',
  maxPaidRequests: phase === 'direct' ? 2 : 1,
  sourceHashes: await hashes(),
  exitCode: 1,
}
await save('manifest.json', manifest)
await build({
  stdin: {
    contents: [
      "export { BoardGateway, importRkBoard } from './src/main/infrastructure/board.ts';",
      "export { CloudGateway } from './src/main/infrastructure/cloud.ts';",
      "export { CooperativeAgent, localAgentPolicies } from './src/main/services/cooperative.ts';",
      "export { providerSchema } from './src/shared/contracts.ts';",
    ].join('\n'),
    resolveDir: root,
    sourcefile: 'deepseek-live-entry.ts',
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
await mkdir(resolve(root, '.qa'), { recursive: true })
const snapshot = resolve(root, '.qa', `deepseek-live-${phase}-${stamp}.mjs`)
await writeFile(snapshot, await readFile(resolve(output, 'production-snapshot.mjs')))
const env = {
  ...process.env,
  COLOOP_LIVE_OUTPUT: output,
  COLOOP_LIVE_PHASE: phase,
  COLOOP_LIVE_SNAPSHOT: snapshot,
  ELECTRON_ENABLE_LOGGING: '0',
}
delete env.ELECTRON_RUN_AS_NODE
let stderrBytes = 0,
  otherStdoutBytes = 0,
  code = 1
try {
  const child = spawn(electronBinary, [resolve(root, 'tests/deepseek-live-worker.mjs')], {
    cwd: root,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  let stdout = ''
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString('utf8')
    let index
    while ((index = stdout.indexOf('\n')) >= 0) {
      const line = stdout.slice(0, index).replace(/\r$/, '')
      stdout = stdout.slice(index + 1)
      // Only fixed metadata emitted by this worker is forwarded. Never forward native diagnostics.
      if (line.startsWith('LIVE_EVENT ') && line.length <= 4096) {
        try {
          const event = JSON.parse(line.slice(11))
          process.stdout.write(JSON.stringify(event) + '\n')
        } catch {
          otherStdoutBytes += Buffer.byteLength(line)
        }
      } else otherStdoutBytes += Buffer.byteLength(line)
    }
  })
  child.stderr.on('data', (chunk) => {
    stderrBytes += chunk.byteLength
  })
  const abort = () => {
    if (child.connected) child.send({ type: 'abort' })
  }
  process.once('SIGINT', abort)
  try {
    code = await new Promise((done, reject) => {
      child.once('error', reject)
      child.once('exit', (exitCode) => done(exitCode ?? 1))
    })
  } finally {
    process.removeListener('SIGINT', abort)
  }
} catch {
  await save('launcher-error.json', { code: 'ELECTRON_WORKER_FAILED' })
} finally {
  await unlink(snapshot).catch(() => {})
  manifest.finishedAt = new Date().toISOString()
  manifest.exitCode = code
  manifest.sourceHashesAfter = await hashes()
  manifest.sourceUnchanged =
    JSON.stringify(manifest.sourceHashes) === JSON.stringify(manifest.sourceHashesAfter)
  manifest.localScratchModuleRemoved = true
  manifest.diagnosticsDiscarded = { stderrBytes, otherStdoutBytes }
  await save('manifest.json', manifest)
  const checksums = {}
  for (const name of [
    'manifest.json',
    'summary.json',
    'cloud-requests.json',
    'cloud-responses.json',
  ]) {
    try {
      checksums[name] = createHash('sha256')
        .update(await readFile(resolve(output, name)))
        .digest('hex')
    } catch {
      /* Missing evidence is visible in the manifest's exit status. */
    }
  }
  await save('evidence-checksums.json', checksums)
  process.stdout.write(
    JSON.stringify({ output, exitCode: code, sourceUnchanged: manifest.sourceUnchanged }) + '\n',
  )
  process.exitCode = code
}
