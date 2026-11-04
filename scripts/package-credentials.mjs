// Freeze a standalone release so concurrent builds cannot replace its compiled inputs.
import { cp, mkdir, readFile, writeFile, readdir } from 'node:fs/promises'
import { resolve, relative, join } from 'node:path'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

const root = resolve(import.meta.dirname, '..')
const stamp = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric',
  month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  hour12: false }).format(new Date()).replaceAll(/[^0-9]/g, '')
const verifying = process.argv[2] === '--verify'
const memory = process.argv.includes('--memory') || (verifying && process.argv[3].includes('memory-package-'))
const flavor = memory ? 'memory' : 'credentials'
const stage = verifying ? resolve(process.argv[3]) : resolve(root, '.qa', `${memory ? 'memory' : 'credential'}-package-${stamp}`)
const pkg = JSON.parse(await readFile(resolve(verifying ? stage : root, 'package.json'), 'utf8'))
const output = verifying ? pkg.build.directories.output : resolve(root, 'release', `${flavor}-${stamp}`)
const runtimeFiles = {}
if (!verifying) {
await mkdir(stage, { recursive: false })
await cp(resolve(root, 'out'), resolve(stage, 'out'), { recursive: true })
// Materialize only the installed production closure. A junction to the entire development
// node_modules makes npm's dependency collector report undefined transitive versions.
const visited = new Set()
async function freezeDependency(name, parent) {
  const require = createRequire(join(parent, 'package.json'))
  let manifest
  try { manifest = require.resolve(name + '/package.json') }
  catch {
    let candidate = resolve(require.resolve(name), '..')
    while (candidate.startsWith(root)) {
      try {
        const data = JSON.parse(await readFile(join(candidate, 'package.json'), 'utf8'))
        if (data.name === name) { manifest = join(candidate, 'package.json'); break }
      } catch {}
      const next = resolve(candidate, '..')
      if (next === candidate) break
      candidate = next
    }
  }
  if (!manifest) throw new Error('Missing installed runtime dependency: ' + name)
  const folder = resolve(manifest, '..')
  if (visited.has(folder)) return
  visited.add(folder)
  const relativeFolder = relative(root, folder)
  if (!relativeFolder.startsWith('node_modules') || relativeFolder.includes('..'))
    throw new Error('Runtime dependency is outside the application: ' + name)
  const data = JSON.parse(await readFile(manifest, 'utf8'))
  await cp(folder, resolve(stage, relativeFolder), { recursive: true })
  for (const path of [manifest, require.resolve(name)]) {
    const key = relative(root, path).replaceAll('\\', '/')
    runtimeFiles[key] = createHash('sha256').update(await readFile(path)).digest('hex')
  }
  for (const dependency of Object.keys(data.dependencies ?? {})) await freezeDependency(dependency, folder)
}
for (const dependency of Object.keys(pkg.dependencies ?? {})) await freezeDependency(dependency, root)
await writeFile(resolve(stage, 'runtime-files.json'), JSON.stringify(runtimeFiles, null, 2))
pkg.build.directories.output = output
pkg.build.electronDist = resolve(root, 'node_modules/electron/dist')
pkg.build.electronVersion = JSON.parse(await readFile(resolve(root, 'node_modules/electron/package.json'), 'utf8')).version
pkg.devDependencies = {}
pkg.build.win.artifactName = `Coloop-${pkg.version}-${flavor}-Windows-x64.exe`
await cp(resolve(root, 'resources/icon.ico'), resolve(stage, 'icon.ico'))
pkg.build.win.icon = resolve(stage, 'icon.ico')
for (let i = 0; i < pkg.build.extraResources.length; i++) {
  const resource = pkg.build.extraResources[i]
  const frozen = resolve(stage, 'extra', String(i))
  await mkdir(resolve(stage, 'extra'), { recursive: true })
  await cp(resolve(root, resource.from), frozen, { recursive: true })
  resource.from = frozen
}
await writeFile(resolve(stage, 'package.json'), JSON.stringify(pkg, null, 2))
await cp(resolve(root, 'package-lock.json'), resolve(stage, 'package-lock.json'))
}
const hash = (value) => createHash('sha256').update(value).digest('hex')
async function files(path) {
  const result = []
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const p = join(path, entry.name)
    if (entry.isDirectory()) result.push(...await files(p))
    else if (entry.isFile()) result.push(p)
  }
  return result
}
const compiled = Object.fromEntries(await Promise.all((await files(resolve(stage, 'out')))
  .map(async (path) => [relative(stage, path).replaceAll('\\', '/'), hash(await readFile(path))])))
if (!verifying) await new Promise((accept, reject) => {
  const process = spawn(globalThis.process.execPath, [resolve(root, 'node_modules/electron-builder/out/cli/cli.js'),
    '--projectDir', stage, '--win', 'portable', '--x64'], { cwd: root, stdio: 'inherit', windowsHide: true })
  process.once('error', reject)
  process.once('close', (code) => code === 0 ? accept() : reject(new Error('Package failed')))
})
const require = createRequire(resolve(root, 'package.json'))
const asar = require('@electron/asar')
const archive = resolve(output, 'win-unpacked/resources/app.asar')
for (const [path, expected] of Object.entries(compiled)) {
  if (hash(asar.extractFile(archive, join(...path.split('/')))) !== expected) throw new Error('Compiled file mismatch: ' + path)
}
const runtime = verifying ? await readFile(resolve(stage, 'runtime-files.json'), 'utf8')
  .then(JSON.parse).catch((e) => { if (e.code === 'ENOENT') return {}; throw e }) : runtimeFiles
const transform = require('app-builder-lib/out/fileTransformer.js').createTransformer(stage, pkg.build)
const runtimePackaged = {}
const runtimeLocations = {}
const archivePackages = []
for (const name of asar.listPackage(archive).map((p) => p.replaceAll('\\', '/').replace(/^\//, ''))) {
  if (!name.startsWith('node_modules/') || !name.endsWith('/package.json')) continue
  const data = JSON.parse(asar.extractFile(archive, join(...name.split('/'))).toString())
  archivePackages.push({ name: data.name, version: data.version, folder: name.slice(0, -13) })
}
const frozenPackages = await Promise.all(Object.keys(runtime).filter((p) => p.endsWith('/package.json'))
  .map(async (path) => ({ path, folder: path.slice(0, -13), ...JSON.parse(await readFile(resolve(stage, path), 'utf8')) })))
frozenPackages.sort((a, b) => b.folder.length - a.folder.length)
for (const [path, expected] of Object.entries(runtime)) {
  const frozen = resolve(stage, path)
  const original = await readFile(frozen)
  if (hash(original) !== expected) throw new Error('Frozen runtime input changed: ' + path)
  // electron-builder strips package metadata (scripts, keywords, bugs, etc.). Verify
  // its exact installed transformer output, while JavaScript remains byte-for-byte.
  const transformed = path.endsWith('/package.json') ? await transform(frozen) : null
  const packagedHash = hash(transformed ?? original)
  const owner = frozenPackages.find((p) => path.startsWith(p.folder + '/'))
  // The packager may hoist nested production modules. Validate the same name/version,
  // exact transformed metadata and entry bytes at every corresponding packaged location.
  const targets = archivePackages.filter((p) => p.name === owner.name && p.version === owner.version)
    .map((p) => p.folder + path.slice(owner.folder.length))
  if (!targets.length) throw new Error('Runtime dependency is absent from package: ' + path)
  runtimeLocations[path] = targets
  for (const target of targets) {
    runtimePackaged[target] = packagedHash
    if (hash(asar.extractFile(archive, join(...target.split('/')))) !== packagedHash)
      throw new Error('Runtime dependency mismatch: ' + path + ' -> ' + target)
  }
}
for (const resource of pkg.build.extraResources) {
  const target = resolve(output, 'win-unpacked/resources', resource.to)
  if (hash(await readFile(target)) !== hash(await readFile(resource.from)))
    throw new Error('Resource mismatch: ' + resource.to)
}
const executable = resolve(output, `Coloop-${pkg.version}-${flavor}-Windows-x64.exe`)
const manifest = { version: pkg.version, timeZone: 'Asia/Shanghai', executable, compiled, runtime, runtimePackaged, runtimeLocations,
  asarSha256: hash(await readFile(archive)), sha256: hash(await readFile(executable)),
  bytes: (await readFile(executable)).length, frozenStage: stage, packagedInputsVerified: true }
await writeFile(resolve(output, `${memory ? 'memory' : 'credential'}-manifest.json`), JSON.stringify(manifest, null, 2))
console.log(JSON.stringify({ output, executable, sha256: manifest.sha256, bytes: manifest.bytes }))
