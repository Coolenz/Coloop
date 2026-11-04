import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve, join } from 'node:path'

const directory = resolve(import.meta.dirname, '../.cache/cloudflared')
const version = '2026.10.6'
const expectedDigest = 'sha256:d521b3bf68982165f0d06d76732f22d9a105ef057ff3ae4c0986f3a23190950f'
await mkdir(directory, { recursive: true })
const release = await (
  await fetch(`https://api.github.com/repos/cloudflare/cloudflared/releases/tags/${version}`, {
    headers: { 'user-agent': 'Coloop-build', accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(30_000),
  })
).json()
const asset = release.assets?.find((item) => item.name === 'cloudflared-windows-amd64.exe')
if (!asset || asset.digest !== expectedDigest)
  throw new Error('Official cloudflared release is missing a verifiable Windows asset')
const path = join(directory, 'cloudflared.exe')
let bytes
try {
  const existing = await readFile(path)
  if (`sha256:${createHash('sha256').update(existing).digest('hex')}` === asset.digest)
    bytes = existing
} catch {
  /* Fresh isolated download. */
}
if (!bytes) {
  const response = await fetch(`${asset.url}?download=1`, {
    headers: { 'user-agent': 'Coloop-build', accept: 'application/octet-stream' },
    signal: AbortSignal.timeout(180_000),
  })
  if (!response.ok) throw new Error('Official cloudflared download failed')
  bytes = Buffer.from(await response.arrayBuffer())
  if (`sha256:${createHash('sha256').update(bytes).digest('hex')}` !== asset.digest)
    throw new Error('cloudflared SHA256 verification failed')
  await writeFile(path, bytes)
}
await writeFile(
  join(directory, 'provenance.json'),
  JSON.stringify(
    {
      version: release.tag_name,
      source: asset.browser_download_url,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length,
    },
    null,
    2,
  ),
)
console.log(
  JSON.stringify({ version: release.tag_name, path, bytes: bytes.length, verified: true }),
)
