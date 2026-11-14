import { _electron as electron } from '@playwright/test'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { resolve, join, sep } from 'node:path'
import assert from 'node:assert/strict'
import { workspaceCacheEnvironment } from '../scripts/with-workspace-cache.mjs'
const root = resolve(import.meta.dirname, '..')
const temporaryRoot = resolve(root, '.cache/tmp/command-line-quit')
await mkdir(temporaryRoot, { recursive: true })
const executablePath = process.env.COLOOP_EXECUTABLE || resolve(root, 'node_modules/electron/dist/electron.exe')
const args = process.env.COLOOP_EXECUTABLE ? [] : [root]
for (const flag of ['--quit', '--force-quit']) {
  const profile = await mkdtemp(join(temporaryRoot, 'run-'))
  const env = { ...workspaceCacheEnvironment(root), COLOOP_DATA_DIR: profile }
  delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ executablePath, args, env })
  try {
    await app.firstWindow()
    const exited = new Promise((resolveExit, reject) => {
      const timer = setTimeout(() => reject(new Error('CLI_QUIT_TIMEOUT')), 20000)
      app.process().once('exit', () => { clearTimeout(timer); resolveExit() })
    })
    const launcher = spawn(executablePath, [...args, flag], { env, windowsHide: true, stdio: 'ignore' })
    await new Promise((done, reject) => { launcher.once('error', reject); launcher.once('exit', done) })
    await exited
    console.log(JSON.stringify({ flag, passed: true }))
  } finally {
    await app.close().catch(() => {})
    assert.ok(profile.startsWith(temporaryRoot + sep))
    await rm(profile, { recursive: true, force: true })
  }
}
