import { randomBytes, randomUUID, createHash, scryptSync } from 'node:crypto'
import { mkdir, readFile, writeFile, copyFile, chmod } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { homedir } from 'node:os'
import { gzipSync } from 'node:zlib'
import { transform } from 'esbuild'

const ip = process.argv[2]
const accessKey = process.env.COLOOP_SERVER_ACCESS_KEY
if (!accessKey || !/^[\x21-\x7e]{6,128}$/.test(accessKey))
  throw Error('Set COLOOP_SERVER_ACCESS_KEY (6 to 128 printable ASCII characters).')
if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip || '')) throw Error('Provide the server public IPv4.')
const root = resolve(import.meta.dirname, '..')
const output = join(root, '.qa', 'relay-deploy')
const privateDirectory = join(homedir(), '.codex', 'secrets', 'coloop')
await mkdir(output, { recursive: true })
await mkdir(privateDirectory, { recursive: true, mode: 0o700 })
const credentialFile = join(privateDirectory, `server-${ip}.json`)
let credential
try {
  credential = JSON.parse(await readFile(credentialFile, 'utf8'))
} catch (error) {
  if (error.code !== 'ENOENT') throw error
  credential = {
    version: 1,
    endpoint: `https://${ip}/h/${randomUUID()}`,
    token: randomBytes(32).toString('base64url'),
  }
  await writeFile(credentialFile, JSON.stringify(credential), { flag: 'wx', mode: 0o600 })
}
const serverConfiguration = {
  channels: [
    {
      channelId: new URL(credential.endpoint).pathname.slice(3),
      tokenHash: createHash('sha256').update(credential.token).digest('hex'),
    },
  ],
}
credential.accessKey = accessKey
await writeFile(credentialFile, JSON.stringify(credential), { mode: 0o600 })
serverConfiguration.accessKeySalt = randomBytes(16).toString('hex')
serverConfiguration.accessKeyHash = scryptSync(
  accessKey,
  serverConfiguration.accessKeySalt,
  32,
).toString('hex')
await writeFile(join(output, 'relay.json'), JSON.stringify(serverConfiguration))
for (const file of ['relay.mjs', 'install.sh'])
  await copyFile(join(root, 'server', file), join(output, file))
const bundled = await transform(await readFile(join(output, 'relay.mjs'), 'utf8'), {
  minify: true, platform: 'node', format: 'esm', target: 'node24',
})
await writeFile(join(output, 'relay.mjs'), bundled.code)
// The cloud command contains code and a token HASH only. No desktop token or pairing secrets.
const payload = {}
for (const file of ['relay.mjs', 'relay.json', 'install.sh'])
  payload[file] = await readFile(join(output, file), 'utf8')
const compressed = gzipSync(Buffer.from(JSON.stringify(payload))).toString('base64')
const python = `import base64,gzip,json,pathlib\np=pathlib.Path('/root/coloop-deploy')\np.mkdir(mode=0o700,exist_ok=True)\nfiles=json.loads(gzip.decompress(base64.b64decode('${compressed}')))\nfor name,data in files.items():\n (p/name).write_text(data,encoding='utf-8')\n`
const command = `#!/bin/bash\nset -eu\npython3 - <<'COLOOP_BUNDLE'\n${python}COLOOP_BUNDLE\nCOLOOP_SERVER_IP='${ip}' bash /root/coloop-deploy/install.sh\n`
await writeFile(join(output, 'install-command.sh'), command)
await chmod(credentialFile, 0o600)
console.log(
  JSON.stringify({
    output,
    credentialFile,
    commandBytes: Buffer.byteLength(command),
    serverCodeSha256: createHash('sha256')
      .update(await readFile(join(output, 'relay.mjs')))
      .digest('hex'),
  }),
)
