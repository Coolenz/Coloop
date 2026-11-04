import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, join, basename } from 'node:path'

// Scoped to the dedicated emulator. Pairing links are read from a file and never printed.
const root = resolve(import.meta.dirname, '..')
const tools = join(root, '.cache/android-toolchain')
const adb = join(tools, 'sdk/platform-tools/adb.exe')
const serial = process.env.COLOOP_ANDROID_SERIAL || 'emulator-5554'
const output = resolve(process.env.COLOOP_ANDROID_QA_DIR || join(root, '.qa/android-live'))
mkdirSync(output, { recursive: true })
const env = {
  ...process.env,
  ANDROID_HOME: join(tools, 'sdk'),
  ANDROID_USER_HOME: join(tools, 'android-user'),
  ANDROID_EMULATOR_HOME: join(tools, 'android-user'),
  ANDROID_AVD_HOME: join(tools, 'avd'),
}
function command(args, binary = false, input) {
  try {
    return execFileSync(adb, ['-s', serial, ...args], {
      windowsHide: true,
      env,
      encoding: binary ? null : 'utf8',
      timeout: 30_000,
      maxBuffer: 12 * 1024 * 1024,
      ...(input === undefined ? {} : { input }),
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    })
  } catch {
    // execFile errors include argv; suppress them because a deep link contains a pairing secret.
    throw new Error('ADB action failed; check the dedicated emulator and the private QA inputs.')
  }
}
function decode(value) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}
export function hierarchy() {
  command(['shell', 'uiautomator', 'dump', '/sdcard/coloop-ui.xml'])
  const xml = command(['shell', 'cat', '/sdcard/coloop-ui.xml'])
  const nodes = []
  const stack = []
  for (const match of xml.matchAll(/<(\/?)node\b([^>]*?)(\/?)>/g)) {
    if (match[1]) {
      stack.pop()
      continue
    }
    const attributes = Object.fromEntries(
      [...match[2].matchAll(/([\w:-]+)="([^"]*)"/g)].map((item) => [item[1], decode(item[2])]),
    )
    const bounds = attributes.bounds?.match(/^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/)
    const node = {
      ...attributes,
      center: bounds
        ? [
            Math.round((Number(bounds[1]) + Number(bounds[3])) / 2),
            Math.round((Number(bounds[2]) + Number(bounds[4])) / 2),
          ]
        : undefined,
    }
    node.clickTarget = attributes.clickable === 'true' ? node.center : stack.at(-1)?.clickTarget
    nodes.push(node)
    if (!match[3]) stack.push(node)
  }
  return nodes
}
export function screenshot(name) {
  const file = join(output, basename(name.endsWith('.png') ? name : name + '.png'))
  writeFileSync(file, command(['exec-out', 'screencap', '-p'], true))
  return file
}
export async function tapText(text, timeout = 15_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const nodes = hierarchy().filter(
      (node) =>
        (node.text === text || node['content-desc'] === text) &&
        node.center &&
        node.enabled !== 'false',
    )
    const node = nodes.find((item) => item.clickTarget) || nodes.at(-1)
    if (node) {
      command(['shell', 'input', 'tap', ...(node.clickTarget || node.center).map(String)])
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  throw new Error(`UI action not found: ${text}`)
}
export async function waitForText(text, timeout = 20_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (
      hierarchy().some((node) => node.text?.includes(text) || node['content-desc']?.includes(text))
    )
      return
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  throw new Error(`UI state not found: ${text}`)
}
export function inputAscii(text, replace = false) {
  if (!/^[A-Za-z0-9 .,;:()_\/-]+$/.test(text)) throw new Error('QA input must use plain ASCII text')
  const field = hierarchy().find(
    (node) =>
      node.package === 'ai.coloop.mobile' &&
      node.class === 'android.widget.EditText' &&
      node.enabled !== 'false' &&
      node.center,
  )
  if (!field) throw new Error('No enabled text field in the current app screen')
  command(['shell', 'input', 'tap', ...field.center.map(String)])
  if (replace) {
    command(['shell', 'input', 'keycombination', '113', '29'])
    command(['shell', 'input', 'keyevent', '67'])
  }
  command(['shell', 'input', 'text', text.replace(/ /g, '%s')])
}
export function openPairing(file) {
  const uri = readFileSync(resolve(file), 'utf8').trim()
  if (!/^coloop:\/\/pair\?data=[A-Za-z0-9_-]+$/.test(uri) || uri.length > 16_384)
    throw new Error('Private pairing file is not a valid Coloop deep link')
  // Feed the fixture deep link over stdin rather than exposing it in host-process argv.
  command(
    ['shell'],
    false,
    `am start -a android.intent.action.VIEW -d '${uri}' -n ai.coloop.mobile/.MainActivity\nexit\n`,
  )
}
export function scrollContent() {
  const scrollable = hierarchy().find(
    (node) => node.package === 'ai.coloop.mobile' && node.scrollable === 'true' && node.center,
  )
  const bounds = scrollable?.bounds.match(/^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/)
  if (!bounds) throw new Error('No scrollable app content in the current screen')
  const x = Math.round((Number(bounds[1]) + Number(bounds[3])) / 2)
  const top = Number(bounds[2]),
    bottom = Number(bounds[4])
  command([
    'shell',
    'input',
    'swipe',
    String(x),
    String(Math.round(top + (bottom - top) * 0.8)),
    String(x),
    String(Math.round(top + (bottom - top) * 0.2)),
    '350',
  ])
}
export function saveDisplaySettings() {
  const file = join(output, 'original-display-settings.json')
  if (!existsSync(file))
    writeFileSync(
      file,
      JSON.stringify(
        {
          fontScale: command(['shell', 'settings', 'get', 'system', 'font_scale']).trim(),
          night: command(['shell', 'settings', 'get', 'secure', 'ui_night_mode']).trim(),
          nightMode: command(['shell', 'cmd', 'uimode', 'night']).trim(),
        },
        null,
        2,
      ),
    )
}
export function setDisplay({ fontScale, night }) {
  saveDisplaySettings()
  if (fontScale !== undefined) {
    if (![1, 1.3, 1.5, 2].includes(Number(fontScale))) throw new Error('Unsupported QA font scale')
    command(['shell', 'settings', 'put', 'system', 'font_scale', String(fontScale)])
  }
  if (night !== undefined) {
    if (!['yes', 'no', 'auto'].includes(night)) throw new Error('Unsupported QA night mode')
    command(['shell', 'cmd', 'uimode', 'night', night])
  }
}
export function restoreDisplaySettings() {
  const file = join(output, 'original-display-settings.json')
  if (!existsSync(file)) return
  const prior = JSON.parse(readFileSync(file, 'utf8'))
  if (prior.fontScale === 'null') command(['shell', 'settings', 'delete', 'system', 'font_scale'])
  else command(['shell', 'settings', 'put', 'system', 'font_scale', prior.fontScale])
  const night =
    prior.night === 'null'
      ? prior.nightMode?.match(/Night mode:\s*(yes|no|auto)/i)?.[1] || 'no'
      : { 0: 'auto', 1: 'no', 2: 'yes' }[prior.night] || 'auto'
  command(['shell', 'cmd', 'uimode', 'night', night])
  if (prior.night === 'null') command(['shell', 'settings', 'delete', 'secure', 'ui_night_mode'])
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const [action, ...args] = process.argv.slice(2)
  try {
    if (action === 'install') command(['install', '-r', resolve(args[0])])
    else if (action === 'open')
      command(['shell', 'am', 'start', '-n', 'ai.coloop.mobile/.MainActivity'])
    else if (action === 'pair') openPairing(args[0])
    else if (action === 'tap') await tapText(args.join(' '))
    else if (action === 'wait') await waitForText(args.join(' '))
    else if (action === 'type') inputAscii(args.join(' '))
    else if (action === 'replace') inputAscii(args.join(' '), true)
    else if (action === 'back') command(['shell', 'input', 'keyevent', '4'])
    else if (action === 'scroll') scrollContent()
    else if (action === 'capture') console.log(screenshot(args[0]))
    else if (action === 'display') setDisplay({ night: args[0], fontScale: args[1] })
    else if (action === 'restore') restoreDisplaySettings()
    else if (action === 'inspect')
      console.log(
        JSON.stringify(
          hierarchy()
            .filter((node) => node.text || node['content-desc'])
            .map((node) => ({
              text: node.text?.replace(/coloop:\/\/pair\?data=\S+/g, '[private pairing link]'),
              description: node['content-desc'],
              bounds: node.bounds,
              enabled: node.enabled,
              class: node.class,
            })),
          null,
          2,
        ),
      )
    else
      throw new Error(
        'Use install/open/pair/tap/wait/type/replace/back/scroll/capture/display/restore/inspect',
      )
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
