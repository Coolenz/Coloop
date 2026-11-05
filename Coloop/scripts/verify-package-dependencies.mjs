// Complete runtime peers omitted by electron-builder, preserving valid hoists.
import { cp, mkdir, open, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const semver = createRequire(import.meta.url)('semver')
const inside = (child, parent) => {
  const path = relative(parent, child)
  return path === '' || (!path.startsWith('..' + sep) && path !== '..' && !path.includes(':'))
}
async function manifest(directory) {
  try {
    return JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}
async function resolvePackage(name, issuer, boundary) {
  if (!/^(?:@[^/\\.][^/\\]*\/)?[^/\\.][^/\\]*$/.test(name))
    throw new Error('Invalid dependency name: ' + name)
  for (let directory = issuer; inside(directory, boundary); directory = dirname(directory)) {
    const candidate = join(directory, 'node_modules', name)
    const data = await manifest(candidate)
    if (data) {
      if (!inside(await realpath(candidate), boundary))
        throw new Error('Dependency escapes package boundary: ' + candidate)
      return { directory: candidate, data }
    }
    if (directory === boundary) break
  }
  return null
}
function requirements(data) {
  const result = new Map()
  for (const [name, range] of Object.entries(data.dependencies ?? {}))
    result.set(name, { range, optional: false })
  for (const [name, range] of Object.entries(data.optionalDependencies ?? {}))
    result.set(name, { range, optional: true })
  for (const [name, range] of Object.entries(data.peerDependencies ?? {})) {
    const optional = data.peerDependenciesMeta?.[name]?.optional === true
    if (!result.has(name) || !optional) result.set(name, { range, optional, peer: true })
  }
  return result
}
function expected(name, range) {
  if (range.startsWith('npm:')) {
    const alias = range.slice(4),
      split = alias.lastIndexOf('@')
    return split > 0
      ? { name: alias.slice(0, split), range: alias.slice(split + 1) }
      : { name: alias, range: '*' }
  }
  return { name, range }
}
function compatible(data, name, range) {
  const wanted = expected(name, range)
  return (
    data?.name === wanted.name &&
    !!semver.validRange(wanted.range) &&
    semver.satisfies(data.version, wanted.range)
  )
}
const delay = (ms) => new Promise((done) => setTimeout(done, ms))
async function publishPackage(staging, target, name, range, boundary) {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(staging, target)
      return
    } catch (error) {
      const appeared = await manifest(target)
      if (appeared) {
        if (compatible(appeared, name, range) && inside(await realpath(target), boundary)) return
        throw new Error('Another writer installed a conflicting package: ' + target)
      }
      if (
        !['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY', 'EEXIST'].includes(error.code) ||
        attempt >= 12
      )
        throw error
      await delay(Math.min(100 * (attempt + 1), 1000))
    }
  }
}
export async function repairPackageDependencies(appDirectory, options = {}) {
  if (options.repair === false) return runDependencyCheck(appDirectory, options)
  const app = await realpath(resolve(appDirectory))
  const lockPath = join(app, '.coloop-dependency-repair.lock')
  let lock
  for (let attempt = 0; !lock; attempt++) {
    try {
      lock = await open(lockPath, 'wx')
    } catch (error) {
      if (error.code !== 'EEXIST' || attempt >= 60) throw error
      await delay(500)
    }
  }
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }))
    return await runDependencyCheck(app, options)
  } finally {
    await lock.close()
    await unlink(lockPath)
  }
}
async function runDependencyCheck(appDirectory, options = {}) {
  const repair = options.repair ?? true
  const sourceRoot = await realpath(resolve(options.sourceRoot ?? repository))
  const app = await realpath(resolve(appDirectory))
  if (inside(sourceRoot, app) || app === sourceRoot || app === join(sourceRoot, 'node_modules'))
    throw new Error('Target must be a separate packaged resources/app directory')
  const sourceManifest = await manifest(sourceRoot),
    targetManifest = await manifest(app)
  if (
    !sourceManifest ||
    targetManifest?.name !== sourceManifest.name ||
    targetManifest?.version !== sourceManifest.version
  )
    throw new Error('Packaged application name/version does not match source')
  const lock = JSON.parse(await readFile(join(sourceRoot, 'package-lock.json'), 'utf8'))
  const sourceCandidates = new Map()
  for (const [path, data] of Object.entries(lock.packages ?? {})) {
    if (!path.startsWith('node_modules/') || !data.version) continue
    const name = data.name ?? path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length)
    if (!sourceCandidates.has(name)) sourceCandidates.set(name, [])
    sourceCandidates.get(name).push({ directory: join(sourceRoot, path), version: data.version })
  }
  const findSource = async (name, range, issuer) => {
    const nearest = await resolvePackage(name, issuer, sourceRoot)
    if (nearest && compatible(nearest.data, name, range)) return nearest
    const wanted = expected(name, range)
    for (const candidate of sourceCandidates.get(wanted.name) ?? []) {
      if (!semver.validRange(wanted.range) || !semver.satisfies(candidate.version, wanted.range))
        continue
      const data = await manifest(candidate.directory)
      if (data && compatible(data, name, range)) return { directory: candidate.directory, data }
    }
    return null
  }
  const copied = [],
    omittedOptional = [],
    failures = []
  const nodes = new Map([[app, { directory: app, data: targetManifest, source: sourceRoot }]])
  const queue = [app]
  let edges = 0
  for (let index = 0; index < queue.length; index++) {
    const issuer = nodes.get(queue[index])
    for (const [name, requirement] of requirements(issuer.data)) {
      const { range, optional, peer } = requirement
      const resolved = await resolvePackage(name, issuer.directory, app)
      let found = resolved
      if (found && !compatible(found.data, name, range)) found = null
      if (!found && optional && peer && !resolved) {
        omittedOptional.push({ issuer: relative(app, issuer.directory), name })
        continue
      }
      let source
      if (!found) {
        source = await findSource(name, range, issuer.source)
        if (!source && optional && !resolved) {
          omittedOptional.push({ issuer: relative(app, issuer.directory), name })
          continue
        }
        if (!source) {
          failures.push(
            `${relative(app, issuer.directory) || '.'} -> ${name}@${range}: no compatible source package`,
          )
          continue
        }
        if (!repair) {
          failures.push(
            `${relative(app, issuer.directory) || '.'} -> ${name}@${range}: missing or incompatible in package`,
          )
          continue
        }
        // Share a missing root version; otherwise use a nested copy to retain
        // the existing version required by other consumers.
        const rootTarget = join(app, 'node_modules', name)
        const target = !(await manifest(rootTarget))
          ? rootTarget
          : join(issuer.directory, 'node_modules', name)
        if (await manifest(target))
          throw new Error(`Conflicting direct dependency at ${target}; refusing to overwrite`)
        await mkdir(dirname(target), { recursive: true })
        const staging = target + `.coloop-copy-${process.pid}-${copied.length}`
        await cp(source.directory, staging, {
          recursive: true,
          dereference: true,
          force: false,
          errorOnExist: true,
          filter: (path) => path === source.directory || basename(path) !== 'node_modules',
        })
        await publishPackage(staging, target, name, range, app)
        found = await resolvePackage(name, issuer.directory, app)
        if (!found || !compatible(found.data, name, range))
          throw new Error('Repaired dependency still resolves incorrectly: ' + target)
        copied.push(relative(app, target))
      }
      edges++
      if (!nodes.has(found.directory)) {
        source ??= await findSource(found.data.name, found.data.version, issuer.source)
        if (!source)
          throw new Error(`Cannot map packaged ${name}@${found.data.version} to installed source`)
        nodes.set(found.directory, { ...found, source: source.directory })
        queue.push(found.directory)
      }
    }
  }
  if (failures.length)
    throw new Error('Unresolved production dependencies:\n' + failures.join('\n'))
  const result = {
    ok: true,
    appDirectory: app,
    packages: nodes.size - 1,
    edges,
    copied,
    omittedOptional,
  }
  if (options.report) await writeFile(resolve(options.report), JSON.stringify(result, null, 2))
  return result
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2),
    target = args.find((arg) => !arg.startsWith('--'))
  if (!target)
    throw new Error(
      'Usage: node scripts/verify-package-dependencies.mjs <resources/app> [--repair]',
    )
  console.log(
    JSON.stringify(
      await repairPackageDependencies(target, { repair: args.includes('--repair') }),
      null,
      2,
    ),
  )
}
