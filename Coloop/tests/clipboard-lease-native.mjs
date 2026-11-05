// Actual native clipboard transaction. No original clipboard contents leave verifier memory.
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { createRequire } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import assert from 'node:assert/strict'
const root = resolve(import.meta.dirname, '..'),
  output = resolve(root, '.qa', `clipboard-native-${Date.now()}`)
await mkdir(output, { recursive: true })
const bundled = resolve(output, 'clipboard.cjs')
await build({
  entryPoints: [resolve(root, 'src/main/infrastructure/clipboard-lease.ts')],
  outfile: bundled,
  bundle: true,
  platform: 'node',
  format: 'cjs',
})
const { ClipboardLeaseService } = createRequire(import.meta.url)(bundled)
const verifierSource = resolve(root, 'tests/ClipboardStateVerifier.cs').replaceAll("'", "''")
const script = `
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -Path '${verifierSource}' -ReferencedAssemblies System.Windows.Forms
$verifier = [ClipboardStateVerifier]::new()
[Console]::WriteLine('ready')
while ($null -ne ($line = [Console]::ReadLine())) {
  try {
    $query = $line | ConvertFrom-Json
    $same = if ($query.op -eq 'marker') { $verifier.Marker([string]$query.text) } elseif ($query.op -eq 'metadata') { $verifier.MetadataSame() } else { $verifier.Same() }
    [Console]::WriteLine((@{same=$same} | ConvertTo-Json -Compress))
  } catch { [Console]::WriteLine('{"same":false}') }
}
`
const verifier = spawn(
  'powershell.exe',
  [
    '-NoProfile',
    '-NonInteractive',
    '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64'),
  ],
  { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
)
let pending
let readyResolve
const ready = new Promise((resolve) => (readyResolve = resolve))
createInterface({ input: verifier.stdout }).on('line', (line) => {
  if (line === 'ready') readyResolve()
  else {
    try {
      pending?.resolve(JSON.parse(line))
      pending = undefined
    } catch {
      pending?.reject(Error('Verifier failed'))
      pending = undefined
    }
  }
})
verifier.stderr.on('data', () => {})
const query = (value) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Clipboard verifier timeout')), 4000)
    pending = {
      resolve: (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      reject,
    }
    verifier.stdin.write(JSON.stringify(value) + '\n')
  })
const service = new ClipboardLeaseService(resolve(root, 'resources/clipboard-lease.ps1'))
const task = 'clipboard-native-' + Date.now()
const marker = 'Coloop clipboard lease 中文 ' + Date.now()
const cases = []
try {
  await Promise.race([
    ready,
    new Promise((_, reject) => setTimeout(() => reject(Error('Verifier startup timed out')), 5000)),
  ])
  let lease = await service.call('clipboard.prepare', { task_id: task, text: marker })
  assert.equal(
    (await service.call('clipboard.guard', { task_id: task, lease_id: lease.lease_id })).allowed,
    true,
  )
  assert.equal((await query({ op: 'marker', text: marker })).same, true)
  assert.equal(
    (await service.call('clipboard.finish', { task_id: task, lease_id: lease.lease_id })).status,
    'restored',
  )
  assert.equal((await query({ op: 'same' })).same, true)
  assert.equal((await query({ op: 'metadata' })).same, true)
  cases.push('prepare guard finish restores every readable public format byte-for-byte')
  lease = await service.call('clipboard.prepare', { task_id: task, text: marker })
  await new Promise((resolve) => setTimeout(resolve, 11000))
  assert.equal((await query({ op: 'same' })).same, true)
  assert.equal((await query({ op: 'metadata' })).same, true)
  await assert.rejects(() =>
    service.call('clipboard.guard', { task_id: task, lease_id: lease.lease_id }),
  )
  cases.push('10-second idle expiry restores original and invalidates guard')
  lease = await service.call('clipboard.prepare', { task_id: task, text: marker })
  await service.dispose()
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.equal((await query({ op: 'same' })).same, true)
  cases.push('service disposal restores active lease')
  await writeFile(
    resolve(output, 'verification.json'),
    JSON.stringify(
      {
        passed: cases.length,
        cases,
        scope:
          'actual Windows clipboard helper; original readable public formats hashed only inside the verifier; OLE transport envelopes and an unrenderable EnterpriseDataProtectionId marker are excluded from payload equality',
      },
      null,
      2,
    ),
  )
  console.log(JSON.stringify({ passed: cases.length, output }))
} finally {
  await service.dispose()
  verifier.stdin.end()
  setTimeout(() => verifier.kill(), 500).unref()
}
