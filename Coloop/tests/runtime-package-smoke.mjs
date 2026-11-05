// Scripted package-runtime verification with local synthetic model responses.
// This is not an autonomous model business acceptance test.
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import assert from 'node:assert/strict'

const root = resolve(import.meta.dirname, '..')
const strictEnv = process.argv.includes('--strict-env')
const nativeKnownFolders = process.argv.includes('--native-known-folders')
const environmentMode = strictEnv
  ? nativeKnownFolders
    ? 'strict-native-folders'
    : 'strict-whitelist'
  : 'windows-no-credentials'
const target = resolve(
  root,
  process.argv.slice(2).find((arg) => !arg.startsWith('--')) ??
    join(process.env.LOCALAPPDATA, 'Programs', 'Coloop'),
)
const resources = join(target, 'resources')
const app = join(resources, 'app')
const output = join(root, '.qa', `runtime-package-${environmentMode}-` + Date.now())
const node = join(resources, 'runtime', 'node', 'node.exe')
const python = join(resources, 'runtime', 'docling', '.venv', 'Scripts', 'python.exe')
const probe = join(app, `.runtime-package-probe-${process.pid}.mjs`)
await mkdir(output, { recursive: true })
assert.ok(existsSync(node), 'Packaged standard Node must exist')
assert.ok(existsSync(python), 'Packaged embedded Python must exist')
assert.ok(existsSync(join(app, 'package.json')), 'Expected unpacked application directory')
assert.ok(probe.startsWith(app + sep), 'Temporary probe must remain inside app')

const profile = join(output, 'profile')
const temporary = join(output, 'temp')
await Promise.all(
  [profile, temporary, join(profile, 'Local'), join(profile, 'Roaming')].map((directory) =>
    mkdir(directory, { recursive: true }),
  ),
)
const blockedEnvironment =
  /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|PROXY|NODE_PATH|NODE_OPTIONS|PYTHONPATH|PYTHONHOME|COLOOP_|DSH_|STAGEHAND_|ELECTRON_RUN_AS_NODE/i
const env = {
  ...(strictEnv
    ? {}
    : Object.fromEntries(
        Object.entries(process.env).filter(([name]) => !blockedEnvironment.test(name)),
      )),
  PATH: dirname(node) + ';' + join(process.env.SystemRoot ?? 'C:\\Windows', 'System32'),
  ...(strictEnv
    ? nativeKnownFolders
      ? {
          USERPROFILE: process.env.USERPROFILE,
          LOCALAPPDATA: process.env.LOCALAPPDATA,
          APPDATA: process.env.APPDATA,
        }
      : {
          USERPROFILE: profile,
          LOCALAPPDATA: join(profile, 'Local'),
          APPDATA: join(profile, 'Roaming'),
        }
    : {}),
  TEMP: temporary,
  TMP: temporary,
  HF_HUB_OFFLINE: '1',
  TRANSFORMERS_OFFLINE: '1',
  HF_HUB_DISABLE_TELEMETRY: '1',
  STAGEHAND_CDP_LOG_FILE: join(output, 'stagehand-cdp.log'),
}
for (const name of [
  'SystemRoot',
  'SystemDrive',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'PROGRAMDATA',
  'ALLUSERSPROFILE',
  'CHROME_PATH',
])
  if (process.env[name]) env[name] = process.env[name]
assert.ok(
  !Object.keys(env).some((name) => /API.?KEY|TOKEN|SECRET|PROXY|NODE_PATH|PYTHONPATH/i.test(name)),
)
await writeFile(
  join(output, 'environment.json'),
  JSON.stringify(
    {
      mode: environmentMode,
      retainedNames: Object.keys(env),
      browserProfile: 'SDK-owned fresh temporary user-data-dir',
      applicationState: output,
    },
    null,
    2,
  ),
)

try {
  await build({
    entryPoints: [join(root, 'tests', 'fixtures', 'runtime-package-probe.ts')],
    outfile: probe,
    bundle: true,
    packages: 'external',
    platform: 'node',
    format: 'esm',
    target: 'node24',
    logLevel: 'silent',
  })
  let stdout = '',
    stderr = ''
  const child = spawn(node, [probe, resources, output], {
    cwd: output,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (part) => {
    stdout += part
    process.stdout.write(part)
  })
  child.stderr.on('data', (part) => {
    stderr += part
  })
  const exit = await new Promise((resolveExit, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolveExit({ code, signal }))
  })
  await Promise.all([
    writeFile(join(output, 'stdout.log'), stdout),
    writeFile(join(output, 'stderr.log'), stderr),
  ])
  assert.equal(exit.code, 0, `Package probe failed: ${stderr.slice(-6000)}`)
  const report = JSON.parse(await readFile(join(output, 'report.json'), 'utf8'))
  assert.equal(report.ok, true)
  console.log(JSON.stringify({ ok: true, output, target, scope: report.scope }))
} finally {
  await rm(probe, { force: true })
}
