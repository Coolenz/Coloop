import { execFile } from 'node:child_process'
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
  copyFile,
} from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, beforeEach, expect, it } from 'vitest'

const run = promisify(execFile)
const repository = resolve(import.meta.dirname, '..')
// This probe uses Windows PowerShell 5.1, not the parent shell's PowerShell 7 modules.
const shellEnv = {
  ...process.env,
  PSModulePath: join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32/WindowsPowerShell/v1.0/Modules',
  ),
}
let fixture: string
beforeEach(async () => {
  await mkdir(join(repository, '.qa'), { recursive: true })
  fixture = await mkdtemp(join(repository, '.qa', 'local-storage-test-'))
})
afterEach(async () => {
  await rm(fixture, { recursive: true, force: true })
})
async function put(path: string, text: string) {
  await mkdir(resolve(path, '..'), { recursive: true })
  await writeFile(path, text)
}
async function install(source: string, programs: string) {
  return run(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-File',
      join(repository, 'tests/fixtures/local-install-probe.ps1'),
      '-Source',
      source,
      '-Programs',
      programs,
      '-NodeExecutable',
      process.execPath,
    ],
    { windowsHide: true, timeout: 30000, env: shellEnv },
  )
}

it('routes inherited C-drive cache settings into the workspace and leaves user data alone', async () => {
  const { workspaceCacheEnvironment } = await import(
    pathToFileURL(join(repository, 'scripts/with-workspace-cache.mjs')).href
  )
  const original = {
    TEMP: 'C:\\old-temp',
    temp: 'C:\\alias',
    NPM_CONFIG_CACHE: 'C:\\npm',
    APPDATA: 'C:\\user-data',
  }
  const env = workspaceCacheEnvironment(fixture, original)
  expect(env.TEMP).toBe(join(fixture, '.cache/temp'))
  expect(env.TMP).toBe(env.TEMP)
  expect(env.npm_config_cache).toBe(join(fixture, '.cache/npm'))
  expect(env.PIP_CACHE_DIR).toBe(join(fixture, '.cache/pip'))
  expect(env.ELECTRON_CACHE).toBe(join(fixture, '.cache/electron'))
  expect(env.temp).toBeUndefined()
  expect(env.NPM_CONFIG_CACHE).toBeUndefined()
  expect(env.APPDATA).toBe(original.APPDATA)
  expect(original.TEMP).toBe('C:\\old-temp')
  const probe = join(fixture, 'cache-probe.mjs')
  await writeFile(
    probe,
    "import { tmpdir } from 'node:os'; console.log(JSON.stringify({tmp:tmpdir(),npm:process.env.npm_config_cache}))",
  )
  const child = await run(
    process.execPath,
    [join(repository, 'scripts/with-workspace-cache.mjs'), probe],
    { env: { ...process.env, TEMP: 'C:\\wrong-temp' } },
  )
  expect(JSON.parse(child.stdout)).toEqual({
    tmp: join(repository, '.cache/temp'),
    npm: join(repository, '.cache/npm'),
  })
})

it.runIf(process.platform === 'win32')(
  'replaces only the installation, removes old asar and creates no backups or stage copies',
  async () => {
    const source = join(fixture, 'package'),
      programs = join(fixture, 'Programs')
    await put(join(source, 'Coloop.exe'), 'new executable')
    await put(join(source, 'resources/app/main.js'), 'new application')
    await mkdir(join(source, 'empty'), { recursive: true })
    await put(join(programs, 'Coloop/Coloop.exe'), 'old executable')
    await put(join(programs, 'Coloop/resources/app.asar'), 'obsolete asar')
    await put(join(programs, 'OtherApp/keep.txt'), 'other application')
    await put(join(fixture, 'user-data/state.json'), 'private user data')
    const report = JSON.parse((await install(source, programs)).stdout)
    expect(report.verifiedFiles).toBe(2)
    expect(report.backup).toBeNull()
    expect(await readFile(join(programs, 'Coloop/resources/app/main.js'), 'utf8')).toBe(
      'new application',
    )
    expect(await readdir(join(programs, 'Coloop/resources'))).toEqual(['app'])
    expect(await readdir(programs)).toEqual(['Coloop', 'OtherApp'])
    expect(await readdir(join(programs, 'Coloop/empty'))).toEqual([])
    expect(await readFile(join(programs, 'OtherApp/keep.txt'), 'utf8')).toBe('other application')
    expect(await readFile(join(fixture, 'user-data/state.json'), 'utf8')).toBe('private user data')
  },
  30000,
)

it.runIf(process.platform === 'win32')(
  'refuses a linked installation before touching its external target',
  async () => {
    const source = join(fixture, 'package'),
      programs = join(fixture, 'Programs'),
      external = join(fixture, 'external')
    await put(join(source, 'Coloop.exe'), 'new executable')
    await put(join(external, 'keep.txt'), 'must survive')
    await mkdir(programs)
    await symlink(external, join(programs, 'Coloop'), 'junction')
    await expect(install(source, programs)).rejects.toThrow('Linked installation path')
    expect(await readdir(external)).toEqual(['keep.txt'])
    expect(await readFile(join(external, 'keep.txt'), 'utf8')).toBe('must survive')
  },
  30000,
)

it.runIf(process.platform === 'win32')(
  'refuses an overlapping package before a mirror can erase the source',
  async () => {
    const programs = join(fixture, 'Programs'),
      source = join(programs, 'Coloop/source')
    await put(join(source, 'Coloop.exe'), 'keep source')
    await expect(install(source, programs)).rejects.toThrow(
      'Source and installation must be separate',
    )
    expect(await readFile(join(source, 'Coloop.exe'), 'utf8')).toBe('keep source')
  },
  30000,
)

it.runIf(process.platform === 'win32')(
  'prunes only an obsolete desktop package after matching the retained installed build',
  async () => {
    const scripts = join(fixture, 'scripts'),
      local = join(fixture, 'Local')
    await mkdir(scripts)
    for (const name of ['local-install-copy.ps1', 'prune-local-builds.ps1'])
      await copyFile(join(repository, 'scripts', name), join(scripts, name))
    const keep = join(fixture, 'release/current/win-unpacked'),
      old = join(fixture, 'release/old/win-unpacked')
    for (const directory of [keep, old])
      await put(join(directory, 'Coloop.exe'), 'fixture executable')
    await put(join(keep, 'resources/app/out/main/index.js'), 'current main')
    await put(
      join(local, 'Programs/Coloop/resources/app/out/main/index.js'),
      'wrong installed main',
    )
    await put(join(fixture, 'release/android/latest.apk'), 'android')
    await put(join(fixture, 'release/unrelated/keep.txt'), 'unrecognized directory')
    const invoke = (extra: string[] = []) =>
      run(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-File',
          join(scripts, 'prune-local-builds.ps1'),
          '-KeepPackageDirectory',
          keep,
          ...extra,
        ],
        { windowsHide: true, timeout: 30000, env: { ...shellEnv, LOCALAPPDATA: local } },
      )
    await expect(invoke()).rejects.toThrow('Only prune after')
    expect(await readFile(join(old, 'Coloop.exe'), 'utf8')).toBe('fixture executable')
    await put(join(local, 'Programs/Coloop/resources/app/out/main/index.js'), 'current main')
    await invoke()
    expect(await readdir(join(fixture, 'release'))).toEqual(['android', 'current', 'unrelated'])
    expect(await readFile(join(fixture, 'release/android/latest.apk'), 'utf8')).toBe('android')
    await invoke(['-IncludeCurrent'])
    expect(await readdir(join(fixture, 'release'))).toEqual(['android', 'unrelated'])
    expect(
      await readFile(join(local, 'Programs/Coloop/resources/app/out/main/index.js'), 'utf8'),
    ).toBe('current main')
  },
  30000,
)
