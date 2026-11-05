import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// npm ci installs the official extension with the SDK. No model key, remote
// browser, downloaded browser, or account registration is required by this check.
const modulePath = fileURLToPath(import.meta.resolve('@browserbasehq/stagehand'))
const packageRoot = dirname(dirname(modulePath))
const metadata = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
if (metadata.version !== '4.4.0') throw new Error('STAGEHAND_VERSION_MISMATCH: expected 4.4.0')
const assets = [
  'dist/extension/manifest.json',
  'dist/extension/service-worker.js',
  'dist/assets/stagehand-extension.zip',
]
const hashes = {}
for (const asset of assets) {
  const bytes = await readFile(join(packageRoot, asset))
  hashes[asset] = createHash('sha256').update(bytes).digest('hex')
}
const candidates = [
  process.env.CHROME_PATH,
  ...[process.env.LOCALAPPDATA, process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)']]
    .filter(Boolean)
    .map((root) => join(root, 'Google', 'Chrome', 'Application', 'chrome.exe')),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean)
const browser = candidates.find((candidate) => existsSync(candidate))
if (!browser) throw new Error('STAGEHAND_CHROME_REQUIRED: install local Chrome or set CHROME_PATH')
console.log(
  JSON.stringify(
    { version: metadata.version, browser, extension: join(packageRoot, 'dist/extension'), hashes },
    null,
    2,
  ),
)
