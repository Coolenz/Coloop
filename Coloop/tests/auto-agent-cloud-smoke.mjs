// Real configured cloud + official DSH, synthetic task evidence only. No UI
// actions, production setting writes, or credential/state copies.
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, realpath, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { workspaceCacheEnvironment } from '../scripts/with-workspace-cache.mjs'

const root = resolve(import.meta.dirname, '..')
const screenshotOnly = process.argv.includes('--screenshot-only')
if (process.argv.slice(2).some((value) => value !== '--screenshot-only'))
  throw Error('UNKNOWN_SMOKE_ARGUMENT')
const runId = randomUUID()
const cache = join(root, '.cache', 'auto-agent-cloud-smoke', runId)
const reports = join(root, '.qa', 'auto-agent-cloud-smoke')
const productionDirectory = process.env.APPDATA ? join(process.env.APPDATA, 'coloop') : ''
if (!productionDirectory || !existsSync(join(productionDirectory, 'state.json'))) {
  console.log(
    JSON.stringify({
      passed: false,
      error: 'PRODUCTION_STATE_NOT_FOUND',
      expected: '%APPDATA%/coloop/state.json',
    }),
  )
  process.exitCode = 1
} else {
  await mkdir(cache, { recursive: true })
  await mkdir(reports, { recursive: true })
  const report = join(reports, runId + '.json')
  const entry = join(cache, 'probe.mjs')
  const resolvedCache = await realpath(cache)
  const resolvedRoot = await realpath(join(root, '.cache'))
  const inside = relative(resolvedRoot, resolvedCache)
  if (!inside || inside === '..' || inside.startsWith('..' + sep) || isAbsolute(inside))
    throw Error('CACHE_PATH_INVALID')
  let exited = false
  let diagnostic = ''
  try {
    await build({
      entryPoints: [join(root, 'tests', 'fixtures', 'auto-agent-cloud-probe.ts')],
      outfile: entry,
      bundle: true,
      packages: 'external',
      platform: 'node',
      format: 'esm',
      target: 'node24',
      logLevel: 'silent',
    })
    const env = workspaceCacheEnvironment(root)
    delete env.ELECTRON_RUN_AS_NODE
    env.COLOOP_CLOUD_SMOKE_ROOT = root
    env.COLOOP_CLOUD_SMOKE_CACHE = cache
    env.COLOOP_CLOUD_SMOKE_REPORT = report
    env.COLOOP_CLOUD_SMOKE_DATA = productionDirectory
    env.COLOOP_CLOUD_SMOKE_ID = runId
    env.COLOOP_CLOUD_SMOKE_NODE = process.execPath
    env.COLOOP_CLOUD_SMOKE_SCREENSHOT_ONLY = screenshotOnly ? '1' : '0'
    const code = await new Promise((resolveExit, reject) => {
      const child = spawn(join(root, 'node_modules', 'electron', 'dist', 'electron.exe'), [entry], {
        cwd: root,
        env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      // Child diagnostics are intentionally not printed: upstream errors can
      // reflect secrets. The probe writes a fixed-code report on every failure.
      child.stdout.resume()
      child.stderr.on('data', (data) => {
        if (diagnostic.length < 8000) diagnostic += data.toString()
      })
      child.on('error', reject)
      child.on('close', (value) => {
        exited = true
        resolveExit(value)
      })
    })
    if (existsSync(report)) {
      const result = JSON.parse(await readFile(report, 'utf8'))
      console.log(JSON.stringify({ report, ...result }))
      if (!result.passed) process.exitCode = 1
    } else
      console.log(
        JSON.stringify({
          report,
          passed: false,
          error: 'PROBE_REPORT_MISSING',
          exitCode: code,
          diagnosticCode:
            [
              'ERR_MODULE_NOT_FOUND',
              'ERR_REQUIRE_ESM',
              'EACCES',
              'EPERM',
              'ENOENT',
              'FATAL',
              'SyntaxError',
              'TypeError',
            ].find((value) => diagnostic.includes(value)) ?? 'UNCLASSIFIED',
          diagnosticBytes: Buffer.byteLength(diagnostic),
        }),
      )
    if (code !== 0 || !existsSync(report)) process.exitCode = 1
  } finally {
    if (exited) await rm(resolvedCache, { recursive: true, force: true })
  }
}
