// Timed, immutable fixture delivery. This process never writes business outputs.
import { copyFile, link, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const args = process.argv.slice(2)
const option = (name) => {
  const index = args.indexOf(name)
  if (index < 0 || !args[index + 1]) throw new Error(`Missing ${name}`)
  return args[index + 1]
}
const workspace = await realpath(resolve(option('--workspace')))
const pending = await realpath(resolve(option('--pending')))
const evidence = resolve(option('--evidence'))
const dispatchPath = resolve(option('--dispatch'))
const interval = Number(option('--interval-ms'))
if (!Number.isFinite(interval) || interval < 1000) throw new Error('Invalid interval')
await mkdir(evidence, { recursive: true })
let dispatch
while (!dispatch) {
  try {
    dispatch = JSON.parse(await readFile(dispatchPath, 'utf8'))
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
    await delay(200)
  }
}
const start = Date.parse(dispatch.started)
if (!Number.isFinite(start)) throw new Error('Invalid dispatch timestamp')
const records = []
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
for (let part = 2; part <= 4; part++) {
  await delay(Math.max(0, start + (part - 1) * interval - Date.now()))
  const name = `卷${part}.txt`
  const source = join(pending, name)
  const destination = join(workspace, name)
  const staged = join(workspace, `.source-${randomUUID()}.tmp`)
  const expected = hash(await readFile(source))
  try {
    await copyFile(source, staged)
    if (hash(await readFile(staged)) !== expected) throw new Error('Fixture copy mismatch')
    try {
      await link(staged, destination)
    } catch (error) {
      if (error.code !== 'EEXIST' || hash(await readFile(destination)) !== expected) throw error
    }
  } finally {
    await rm(staged, { force: true })
  }
  records.push({
    name,
    at: new Date().toISOString(),
    elapsed_ms: Date.now() - start,
    bytes: (await stat(destination)).size,
    sha256: expected,
  })
  await writeFile(join(evidence, 'source-delivery.json'), JSON.stringify(records, null, 2))
  console.log(JSON.stringify(records.at(-1)))
}
