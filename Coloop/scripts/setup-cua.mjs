import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, readFile, writeFile, copyFile, rm } from 'node:fs/promises'
import { join, resolve, relative, isAbsolute } from 'node:path'

// Reviewed stable release, not the mutable upstream main/nightly installer.
const version = '0.38.0'
const tag = `cua-driver-rs-v${version}`
const asset = `cua-driver-rs-${version}-windows-x86_64-binary.zip`
const archiveSha256 = '5edaa74d0afa1b55a9668dbc4f32736507bd2bd4d75b18ca1dc8881bb12402b5'
const checksumsSha256 = '0d5773339166b764d995004ee3f6f6d296ac96b9fcf0cc09f113ddc35a4a8fc9'
const licenseSha256 = 'c0779290c1d4783169aa3dbfb55feb505e563ef8a004bbf55298ceffcfbda8d9'
const base = `https://github.com/trycua/cua/releases/download/${tag}`
const cache = resolve(import.meta.dirname, '../.cache/cua-driver-download')
const destination = resolve(import.meta.dirname, '../.cache/cua-driver')
const run = promisify(execFile)
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const binaries = ['cua-driver.exe', 'cua-driver-uia.exe', 'cua-cursor-theme.exe']

if (process.platform !== 'win32' || process.arch !== 'x64')
  throw new Error('CUA_SETUP_PLATFORM: this package pins the Windows x64 driver')

async function download(url) {
  // Windows PowerShell honors the user's Windows network/proxy configuration.
  // Node fetch can time out on hosts whose HTTPS proxy is configured there.
  const temporary = join(cache, `download-${process.pid}-${Date.now()}.part`)
  try {
    await run(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "$ErrorActionPreference='Stop'; [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -UseBasicParsing -Uri $env:COLOOP_CUA_URL -OutFile $env:COLOOP_CUA_DOWNLOAD -TimeoutSec 180",
      ],
      {
        windowsHide: true,
        timeout: 190_000,
        env: { ...process.env, COLOOP_CUA_URL: url, COLOOP_CUA_DOWNLOAD: temporary },
      },
    )
    return await readFile(temporary)
  } finally {
    await rm(temporary, { force: true })
  }
}

async function verifiedDownload(filename, url, expected) {
  const path = join(cache, filename)
  let bytes = await readFile(path).catch(() => undefined)
  if (!bytes || hash(bytes) !== expected) bytes = await download(url)
  if (hash(bytes) !== expected) throw new Error(`CUA_CHECKSUM_MISMATCH: ${filename}`)
  await writeFile(path, bytes)
  return bytes
}

await mkdir(cache, { recursive: true })
const checksums = await verifiedDownload('checksums.txt', `${base}/checksums.txt`, checksumsSha256)
const published = checksums
  .toString('utf8')
  .split(/\r?\n/)
  .find((line) => line.trim().endsWith(asset))
if (published?.trim().split(/\s+/)[0] !== archiveSha256)
  throw new Error('CUA_RELEASE_MANIFEST_MISMATCH')
await verifiedDownload('cua-driver.zip', `${base}/${asset}`, archiveSha256)
const staging = await mkdtemp(join(cache, 'stage-'))
try {
  // Paths travel through environment variables, never interpolated shell code.
  await run(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Expand-Archive -LiteralPath $env:COLOOP_CUA_ARCHIVE -DestinationPath $env:COLOOP_CUA_STAGE -Force',
    ],
    {
      windowsHide: true,
      timeout: 60_000,
      env: {
        ...process.env,
        COLOOP_CUA_ARCHIVE: join(cache, 'cua-driver.zip'),
        COLOOP_CUA_STAGE: staging,
      },
    },
  )
  const signature = await run(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$ErrorActionPreference='Stop'; Import-Module (Join-Path $PSHOME Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1); $result=@(); foreach($name in @('cua-driver.exe','cua-driver-uia.exe','cua-cursor-theme.exe')) { $s=Get-AuthenticodeSignature -LiteralPath (Join-Path $env:COLOOP_CUA_STAGE $name); if($s.Status -ne 'Valid' -or !$s.SignerCertificate -or $s.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName,$false) -ne 'Cua AI, Inc.') { throw ('CUA_SIGNATURE_INVALID: '+$name) }; $result+=@{file=$name;publisher='Cua AI, Inc.';status='Valid'} }; ConvertTo-Json -Compress -InputObject $result`,
    ],
    {
      windowsHide: true,
      timeout: 60_000,
      env: { ...process.env, COLOOP_CUA_STAGE: staging },
    },
  )
  const env = {
    ...process.env,
    CUA_DRIVER_RS_HOME: join(cache, 'probe-home'),
    CUA_DRIVER_RS_TELEMETRY_ENABLED: '0',
    CUA_TELEMETRY_ENABLED: '0',
    CUA_DRIVER_RS_UPDATE_CHECK: 'false',
  }
  const executable = join(staging, 'cua-driver.exe')
  const reported = (
    await run(executable, ['--version'], { windowsHide: true, timeout: 15_000, env })
  ).stdout.trim()
  if (reported !== `cua-driver ${version}`) throw new Error('CUA_BINARY_VERSION_MISMATCH')
  const tools = (await run(executable, ['list-tools'], { windowsHide: true, timeout: 15_000, env }))
    .stdout
  for (const tool of ['get_window_state', 'click', 'scroll', 'move_cursor'])
    if (!tools.split(/\r?\n/).some((line) => line.startsWith(`${tool}:`)))
      throw new Error(`CUA_REQUIRED_TOOL_MISSING: ${tool}`)
  const license = await verifiedDownload(
    'LICENSE-cua-driver.txt',
    `https://raw.githubusercontent.com/trycua/cua/${tag}/LICENSE.md`,
    licenseSha256,
  )
  const files = {}
  await mkdir(destination, { recursive: true })
  for (const filename of binaries) {
    const source = join(staging, filename)
    const bytes = await readFile(source)
    files[filename] = hash(bytes)
    const existing = await readFile(join(destination, filename)).catch(() => undefined)
    // Leave an identical in-use executable alone on repeat setup.
    if (!existing || hash(existing) !== files[filename])
      await copyFile(source, join(destination, filename))
  }
  await writeFile(join(destination, 'LICENSE-cua-driver.txt'), license)
  await writeFile(
    join(destination, 'manifest.json'),
    JSON.stringify(
      {
        version,
        tag,
        platform: 'windows-x86_64',
        source: `${base}/${asset}`,
        archiveSha256,
        checksumsSha256,
        licenseSha256,
        files,
        authenticode: JSON.parse(signature.stdout),
        verification:
          'Pinned SHA256 + upstream checksums + Windows Authenticode publisher; Sigstore bundle not evaluated',
      },
      null,
      2,
    ) + '\n',
  )
  console.log(`Cua Driver ${version} verified: ${destination}`)
} finally {
  const child = relative(cache, staging)
  if (!child || child.startsWith('..') || isAbsolute(child))
    throw new Error('CUA_INVALID_STAGING_PATH')
  await rm(staging, { recursive: true, force: true })
}
