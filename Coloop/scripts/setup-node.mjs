import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

// Harness native boot is built for standard Node, not Electron's V8 ABI.
const version = '24.14.0'
const base = `https://nodejs.org/dist/v${version}`
const directory = resolve(import.meta.dirname, '../.cache/node-runtime')
async function download(path) {
  const response = await fetch(path.startsWith('https://') ? path : `${base}/${path}`)
  if (!response.ok) throw new Error(`Node runtime download failed: ${response.status}`)
  return Buffer.from(await response.arrayBuffer())
}
const manifest = (await download('SHASUMS256.txt')).toString('utf8')
const expected = manifest
  .split('\n')
  .find((line) => line.trim().endsWith(' win-x64/node.exe'))
  ?.split(/\s+/)[0]
if (!expected || !/^[a-f0-9]{64}$/.test(expected)) throw new Error('Node release checksum missing')
await mkdir(directory, { recursive: true })
const file = resolve(directory, 'node.exe')
let bytes = await readFile(file).catch(() => undefined)
const sha = (value) => createHash('sha256').update(value).digest('hex')
if (!bytes || sha(bytes) !== expected) bytes = await download('win-x64/node.exe')
if (sha(bytes) !== expected) throw new Error('Node runtime checksum mismatch')
await writeFile(file, bytes)
await writeFile(
  resolve(directory, 'LICENSE'),
  await download(`https://raw.githubusercontent.com/nodejs/node/v${version}/LICENSE`),
)
await writeFile(
  resolve(directory, 'manifest.json'),
  JSON.stringify({ version, sha256: expected, source: `${base}/win-x64/node.exe` }, null, 2),
)
console.log(`Node ${version} runtime verified: ${directory}`)
