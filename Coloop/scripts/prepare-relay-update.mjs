import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { transform } from 'esbuild'

const expected = process.argv[2]
if (!/^[a-f0-9]{64}$/.test(expected || ''))
  throw Error('Usage: node scripts/prepare-relay-update.mjs <currently-deployed-sha256>')
const root = resolve(import.meta.dirname, '..')
const output = join(root, '.qa', 'relay-update-20261031')
await mkdir(output, { recursive: true })
const code = (
  await transform(await readFile(join(root, 'server/relay.mjs'), 'utf8'), {
    minify: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
  })
).code
const update = await readFile(join(root, 'server/update.sh'), 'utf8')
await writeFile(join(output, 'relay.mjs'), code)
await writeFile(join(output, 'update.sh'), update)
const compressed = gzipSync(
  Buffer.from(JSON.stringify({ 'relay.mjs': code, 'update.sh': update })),
).toString('base64')
// Code only; no server config, tokens, access keys or pairing data enter this bundle.
const command = `#!/bin/bash
set -eu
python3 - <<'COLOOP_UPDATE'
import base64,gzip,json,pathlib
p=pathlib.Path('/root/coloop-update-20261031')
p.mkdir(mode=0o700,exist_ok=True)
for name,data in json.loads(gzip.decompress(base64.b64decode('${compressed}'))).items():
 (p/name).write_text(data,encoding='utf-8')
COLOOP_UPDATE
COLOOP_EXPECTED_SHA256='${expected}' bash /root/coloop-update-20261031/update.sh
`
await writeFile(join(output, 'update-command.sh'), command)
console.log(
  JSON.stringify({
    output,
    expectedSha256: expected,
    targetSha256: createHash('sha256').update(code).digest('hex'),
    commandBytes: Buffer.byteLength(command),
  }),
)
