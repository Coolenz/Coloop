import { mkdirSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export function workspaceCacheEnvironment(root, original = process.env) {
  const cache = resolve(root, '.cache')
  const env = { ...original }
  const locations = {
    TEMP: 'temp',
    TMP: 'temp',
    TMPDIR: 'temp',
    npm_config_cache: 'npm',
    PIP_CACHE_DIR: 'pip',
    UV_CACHE_DIR: 'uv',
    ELECTRON_CACHE: 'electron',
    ELECTRON_BUILDER_CACHE: 'electron-builder',
    HF_HOME: 'huggingface',
    XDG_CACHE_HOME: 'xdg',
  }
  for (const [key, directory] of Object.entries(locations)) {
    // Windows environment names are case insensitive; remove inherited aliases.
    for (const inherited of Object.keys(env))
      if (inherited.toLowerCase() === key.toLowerCase()) delete env[inherited]
    env[key] = resolve(cache, directory)
    mkdirSync(env[key], { recursive: true })
  }
  return env
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = resolve(import.meta.dirname, '..')
  const [script, ...args] = process.argv.slice(2)
  if (!script) throw new Error('Usage: with-workspace-cache.mjs <Node script | --npm> [args]')
  const executableScript = script === '--npm' ? process.env.npm_execpath : resolve(script)
  if (!executableScript) throw new Error('--npm must be invoked by an npm script')
  const child = spawn(process.execPath, [executableScript, ...args], {
    env: workspaceCacheEnvironment(root),
    stdio: 'inherit',
    windowsHide: true,
  })
  child.on('error', (error) => {
    console.error(error.message)
    process.exitCode = 1
  })
  child.on('exit', (code) => {
    process.exitCode = code ?? 1
  })
}
