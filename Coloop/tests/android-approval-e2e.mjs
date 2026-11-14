// Dedicated emulator, encrypted production gateway, synthetic pending approvals.
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'

const root = resolve(import.meta.dirname, '..')
const output = join(root, '.qa', 'android-approval-' + Date.now())
await mkdir(output, { recursive: true })
process.env.COLOOP_ANDROID_QA_DIR = output
const ui = await import('../scripts/android-phone-qa.mjs')
const adb = join(root, '.cache/android-toolchain/sdk/platform-tools/adb.exe')
const serial = process.env.COLOOP_ANDROID_SERIAL || 'emulator-5554'
assert.ok(serial.startsWith('emulator-'), 'Use a dedicated emulator for synthetic pairing')
const command = (args) => execFileSync(adb, ['-s', serial, ...args], { windowsHide: true, timeout: 60000, encoding: 'utf8' })
const bundle = join(output, 'gateway.mjs')
await build({ entryPoints: [join(root, 'src/main/services/remote-gateway.ts')], outfile: bundle, bundle: true, platform: 'node', format: 'esm' })
const { RemoteGatewayService } = await import(pathToFileURL(bundle).href)
let approval
const decisions = []
const nextApproval = () => ({ taskId: randomUUID(), questionId: randomUUID(), title: '整理课程资料 · 审批验收', question: '是否允许本次文件操作？', toolName: 'coloop_workspace', callId: randomUUID(), details: '{ "operation": "write_text", "path": "课程笔记.md" }' })
const gateway = new RemoteGatewayService({
  directory: join(output, 'profile'), encrypt: text => Buffer.from(text).toString('base64'), decrypt: text => Buffer.from(text, 'base64').toString(), onChange() {},
  hostName: '审批验收电脑',
  getSnapshot: () => ({ hostName: '审批验收电脑', approval, sessionControl: { stopped: false, controlActive: false, unconfirmedCount: 0, sessions: [], commands: [] }, progress: [] }),
  command: async () => { throw new Error('No session commands in this fixture') }, stop: async () => {}, resume: async () => {},
  answerApproval(input) {
    assert.equal(input.questionId, approval?.questionId)
    assert.equal(input.taskId, approval?.taskId)
    decisions.push(input.decision)
    approval = undefined
  },
})
let port
try {
  command(['install', '-r', join(root, 'android/app/build/outputs/apk/debug/app-debug.apk')])
  const { url } = await gateway.start()
  port = new URL(url).port
  command(['reverse', `tcp:${port}`, `tcp:${port}`])
  const invitation = gateway.createPairing('https://approval-fixture.invalid')
  invitation.payload.endpoint = `http://127.0.0.1:${port}`
  const pairing = join(output, 'pairing.txt')
  await writeFile(pairing, 'coloop://pair?data=' + Buffer.from(JSON.stringify(invitation.payload)).toString('base64url'))
  ui.openPairing(pairing)
  await ui.tapText('连接电脑')
  await ui.waitForText('电脑端需要更新')
  approval = nextApproval()
  await ui.waitForText('需要你批准操作')
  ui.screenshot('approval')
  await ui.tapText('允许本次')
  for (let n = 0; n < 100 && decisions.length < 1; n++) await new Promise(resolve => setTimeout(resolve, 100))
  assert.deepEqual(decisions, ['allowed-once'])
  await new Promise(resolve => setTimeout(resolve, 4000))
  assert.ok(!ui.hierarchy().some(node => node.text === '需要你批准操作'))
  approval = nextApproval()
  await ui.waitForText('需要你批准操作')
  await ui.tapText('拒绝本次')
  for (let n = 0; n < 100 && decisions.length < 2; n++) await new Promise(resolve => setTimeout(resolve, 100))
  assert.deepEqual(decisions, ['allowed-once', 'rejected'])
  await new Promise(resolve => setTimeout(resolve, 4000))
  assert.ok(!ui.hierarchy().some(node => node.text === '需要你批准操作'))
  // A desktop decision removes the shared request on the next mobile poll.
  approval = nextApproval()
  await ui.waitForText('需要你批准操作')
  approval = undefined
  await new Promise(resolve => setTimeout(resolve, 4000))
  assert.ok(!ui.hierarchy().some(node => node.text === '需要你批准操作'))
  ui.screenshot('resolved')
  await writeFile(join(output, 'report.json'), JSON.stringify({ ok: true, decisions, crossSurfaceRemoval: true, scope: 'Dedicated emulator and encrypted production RPC with synthetic approval state' }, null, 2))
  console.log(JSON.stringify({ ok: true, output }))
} finally {
  await gateway.dispose()
  if (port) command(['reverse', '--remove', `tcp:${port}`])
  for (const name of ['profile', 'pairing.txt', 'gateway.mjs']) await rm(join(output, name), { recursive: true, force: true })
}
