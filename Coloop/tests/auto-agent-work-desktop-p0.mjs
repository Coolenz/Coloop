// Real desktop Hook P0. The operator creates/reviews the separate test chat; this script never does.
// Run: node scripts/with-workspace-cache.mjs tests/auto-agent-work-desktop-p0.mjs
// stdin: status | finish  (finish removes only this run's Hooks and closes the receiver).
import { build } from 'esbuild'
import { randomUUID, createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, lstat, rm } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createInterface } from 'node:readline'
import { workspaceCacheEnvironment } from '../scripts/with-workspace-cache.mjs'

const root = resolve(import.meta.dirname, '..')
if (process.argv.length !== 2) throw Error('NO_ARGUMENTS_EXPECTED')
if (process.platform !== 'win32' || root.toLowerCase() !== 'd:\\coloop')
  throw Error('DESKTOP_P0_REQUIRES_D_COLOOP_ON_WINDOWS')
const cacheEnv = workspaceCacheEnvironment(root)
for (const key of Object.keys(process.env)) if (!(key in cacheEnv)) delete process.env[key]
Object.assign(process.env, cacheEnv)
const cacheRoot = join(root, '.cache', 'auto-agent-work-desktop-p0')
await mkdir(cacheRoot, { recursive: true })
const profile = await mkdtemp(join(cacheRoot, 'run-'))
const reportDirectory = join(root, '.qa', 'auto-agent-work-desktop-p0')
await mkdir(reportDirectory, { recursive: true })
const runId = randomUUID()
const firstNonce = `COLOOP_DESKTOP_P0_FIRST_${randomUUID()}`
const secondNonce = `COLOOP_DESKTOP_P0_SECOND_${randomUUID()}`
const prompt = `这是 Coloop 桌面原生 Hook 验收的独立测试会话。本轮只回复以下一行文本，无需使用工具、文件或网络操作：\n${firstNonce}`
const reportPath = join(reportDirectory, `${runId}.json`)
const registryPath = join(root, '.codex', 'coloop-auto-work-hooks.json')
const configPath = join(root, '.codex', 'hooks.json')
const report = {
  version: 1, runId, startedAt: new Date().toISOString(), scope: 'real_desktop_native_hooks',
  status: 'starting', passed: false, initialNonce: firstNonce, expectedContinuationNonce: secondNonce,
  configPath, trustBypass: false, createsChat: false, sendsModelApiRequest: false,
  binding: null, action: null, evidence: [], ignoredEvents: 0, cleanup: 'pending',
}
let adapter
let installer
let installedRegistry
let installAttempted = false
let baselineConfig
let bound
let action
let attempted = false
let claimed = false
let submitted = false
let receiptConfirmed = false
let progressAfterClaim = false
let secondStop = false
let firstReplyMatched = false
let secondReplyMatched = false
let stopping = false
let fatal = false
let pendingAck = Promise.resolve()
const save = () => writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n')
const emit = (type, detail = {}) => process.stdout.write(JSON.stringify({ type, ...detail }) + '\n')
const readOptional = async (path) => {
  try { return await readFile(path, 'utf8') } catch (error) { if (error.code === 'ENOENT') return undefined; throw error }
}
const fail = (reason) => {
  fatal = true
  report.status = 'failed'
  report.failure = reason
  if (bound) adapter?.invalidate(bound.id)
  save()
  emit('failure', { reason, reportPath })
}
function checkResult() {
  report.checks = { firstReplyMatched, claimed, submitted, progressAfterClaim, receiptConfirmed, secondStop, secondReplyMatched }
  if (!fatal && !report.passed && Object.values(report.checks).every(Boolean)) {
    report.status = 'passed'
    report.passed = true
    report.completedAt = new Date().toISOString()
    emit('passed', { nativeSessionId: bound.nativeSessionId, turnId: bound.turnId, reportPath })
  }
  save()
}
function observe(event, session) {
  if (stopping || report.passed || event.agentId || event.parentTurnId) return
  if (!bound) {
    if (event.nativeName !== 'UserPromptSubmit' || !event.payload.prompt?.includes(firstNonce)) {
      report.ignoredEvents++
      return
    }
    if (!event.turnId || session.workspace.toLowerCase() !== root.toLowerCase()) return
    bound = { id: session.id, nativeSessionId: session.sessionId, instanceId: session.instanceId, turnId: event.turnId }
    report.binding = bound
    report.status = 'bound'
    installer.markObserved(root)
    emit('bound', { ...bound, reportPath })
  } else if (session.id !== bound.id || session.sessionId !== bound.nativeSessionId || session.instanceId !== bound.instanceId) {
    report.ignoredEvents++
    return
  } else if (event.nativeName === 'UserPromptSubmit' && event.origin !== 'coloop') {
    fail('HUMAN_INPUT_AFTER_BINDING')
    return
  }
  if (fatal) return
  report.evidence.push({
    id: event.id, name: event.nativeName, revision: event.revision, at: event.at,
    nativeSessionId: session.sessionId, turnId: event.turnId,
    stopHookActive: event.payload.stop_hook_active, actionId: event.actionId,
    containsFirstNonce: event.payload.last_assistant_message?.includes(firstNonce) ?? false,
    containsSecondNonce: event.payload.last_assistant_message?.includes(secondNonce) ?? false,
  })
  report.evidence = report.evidence.slice(-60)
  if (event.turnId && event.turnId !== bound.turnId) { fail('BOUND_TURN_CHANGED'); return }
  if (event.nativeName === 'Interrupt' || event.nativeName === 'SessionEnd') {
    if (!report.passed) fail('TEST_SESSION_INTERRUPTED_OR_CLOSED')
    return
  }
  if (claimed && event.nativeName === 'PreModelRequest') progressAfterClaim = true
  if (event.nativeName !== 'Stop') { checkResult(); return }
  if (!attempted) {
    attempted = true
    firstReplyMatched = event.payload.last_assistant_message?.includes(firstNonce) ?? false
    action = {
      actionId: randomUUID(), sessionId: session.id, turnId: bound.turnId,
      taskVersion: 1, eventRevision: event.revision,
      reason: '', expiresAt: new Date(Date.now() + 30000).toISOString(),
    }
    action.reason = `[Coloop Auto Agent Work:${action.actionId}]\n继续本次独立验收。只回复以下一行文本，无需使用工具、文件或网络操作：\n${secondNonce}`
    report.action = { id: action.actionId, status: 'prepared', stopRevision: event.revision }
    report.status = 'waiting_continuation'
    save()
    pendingAck = adapter.prepareAndWaitContinuation(action).then((wasClaimed) => {
      report.action.ack = wasClaimed
      if (!wasClaimed) fail('NATIVE_STOP_NOT_CLAIMED_NO_RETRY')
      else { checkResult(); emit('claim_ack', { claimed: true, nativeSessionId: bound.nativeSessionId }) }
    }).catch(() => fail('NATIVE_ACK_FAILED_NO_RETRY'))
  } else {
    secondStop = submitted && progressAfterClaim && event.payload.stop_hook_active === true
    secondReplyMatched = event.payload.last_assistant_message?.includes(secondNonce) ?? false
    checkResult()
    emit('second_stop', { sameSession: true, sameTurn: true, secondReplyMatched, receiptConfirmed, reportPath })
  }
}
async function cleanup(reason) {
  if (stopping) return
  stopping = true
  report.finishReason = reason
  adapter?.stop()
  await pendingAck.catch(() => {})
  const errors = []
  try {
    if (installAttempted) {
      const currentRegistry = await readOptional(registryPath)
      if (currentRegistry === installedRegistry && installedRegistry !== undefined) {
        await installer.uninstall(root)
      } else if (currentRegistry !== undefined) {
        // Never uninstall definitions now owned by another Coloop instance.
        throw Error('HOOK_REGISTRY_CHANGED_CLEANUP_REQUIRES_REVIEW')
      }
      const current = JSON.parse((await readOptional(configPath)) ?? '{}')
      const baseline = JSON.parse(baselineConfig ?? '{}')
      const preserved = Object.entries(baseline.hooks ?? {}).every(([name, groups]) =>
        groups.every((group) => (current.hooks?.[name] ?? []).some((candidate) => JSON.stringify(candidate) === JSON.stringify(group))))
      if (!preserved) throw Error('EXISTING_HOOK_PRESERVATION_CHECK_FAILED')
      report.existingHooksPreserved = true
    }
  } catch (error) { errors.push(error.message) }
  try { await adapter?.dispose() } catch { errors.push('ADAPTER_DISPOSE_FAILED') }
  try {
    const canonicalCache = await realpath(cacheRoot)
    const canonicalProfile = await realpath(profile)
    const inside = relative(canonicalCache, canonicalProfile)
    if (!inside || inside === '..' || inside.startsWith('..' + sep) || isAbsolute(inside) || (await lstat(profile)).isSymbolicLink())
      throw Error('PROFILE_CLEANUP_PATH_INVALID')
    await rm(canonicalProfile, { recursive: true, force: true })
  } catch (error) { errors.push(error.message) }
  report.cleanup = errors.length ? 'incomplete' : 'complete'
  report.cleanupErrors = errors
  report.finishedAt = new Date().toISOString()
  if (!report.passed) report.status = 'not_passed'
  save()
  emit('finished', { passed: report.passed, cleanup: report.cleanup, errors, reportPath })
  if (!report.passed || errors.length) process.exitCode = 1
}

try {
  const priorRegistry = await readOptional(registryPath)
  if (priorRegistry !== undefined) throw Error('EXISTING_COLOOP_HOOK_REGISTRY_PRESERVED_TEST_NOT_INSTALLED')
  baselineConfig = await readOptional(configPath)
  const entry = join(profile, 'adapter.mjs')
  await build({
    stdin: {
      contents: "export { ChatGPTDesktopAdapter } from './src/main/services/chatgpt-desktop-adapter.ts'; export { AutoAgentWorkHooks } from './src/main/services/auto-agent-work-hooks.ts';",
      resolveDir: root, sourcefile: 'desktop-p0-entry.ts', loader: 'ts',
    },
    outfile: entry, bundle: true, packages: 'external', platform: 'node', format: 'esm', target: 'node24', logLevel: 'silent',
  })
  const { ChatGPTDesktopAdapter, AutoAgentWorkHooks } = await import(pathToFileURL(entry).href)
  installer = new AutoAgentWorkHooks()
  adapter = new ChatGPTDesktopAdapter({
    workspaceRoots: () => [root], onEvent: observe,
    claimContinuation: (candidate, event) => {
      if (stopping || fatal || claimed || !bound || !action || candidate.actionId !== action.actionId ||
        candidate.sessionId !== bound.id || candidate.turnId !== bound.turnId || candidate.eventRevision !== event.revision ||
        event.sessionId !== bound.id || event.turnId !== bound.turnId || candidate.reason !== action.reason) return false
      claimed = true
      report.action.status = 'claimed'
      report.action.claimedAt = new Date().toISOString()
      // The reservation is persisted before the adapter may emit any Stop control response.
      writeFileSync(join(profile, 'action-ledger.json'), JSON.stringify({ ...report.action, nativeSessionId: bound.nativeSessionId }))
      save()
      return true
    },
    onNativeContinuation: (receipt) => {
      if (!action || receipt.actionId !== action.actionId || receipt.sessionId !== bound?.id) return
      report.action.status = receipt.status
      if (receipt.status === 'submitted') submitted = true
      if (receipt.status === 'confirmed') receiptConfirmed = true
      checkResult()
    },
  })
  const connection = await adapter.start({ connectionDirectory: join(profile, 'connection') })
  installAttempted = true
  try {
    await installer.install({ workspace: root, nodePath: process.execPath, scriptPath: join(root, 'resources', 'auto-agent-work-hook.mjs'), connectionPath: connection.connectionPath })
  } finally {
    const registry = await readOptional(registryPath)
    if (registry && JSON.parse(registry).entries.every((item) => item.group.hooks.every((hook) => hook.command.includes(connection.connectionPath))))
      installedRegistry = registry
  }
  report.status = 'waiting_for_prompt'
  report.hookDefinitionDigest = createHash('sha256').update(installedRegistry).digest('hex')
  save()
  emit('ready', { prompt, configPath, reportPath, profile, trust: 'review_required', finishCommand: 'finish', statusCommand: 'status' })
  const input = createInterface({ input: process.stdin, terminal: false })
  await new Promise((resolveFinish) => {
    let finishing = false
    const finish = (reason) => {
      if (finishing) return
      finishing = true
      void cleanup(reason).finally(() => { input.close(); resolveFinish() })
    }
    input.on('line', (line) => {
      if (line.trim() === 'finish') finish('stdin_finish')
      else if (line.trim() === 'status') emit('status', { status: report.status, binding: report.binding, action: report.action, checks: report.checks, reportPath })
      else emit('invalid_command', { allowed: ['status', 'finish'] })
    })
    input.on('close', () => finish('stdin_closed'))
    process.once('SIGINT', () => finish('SIGINT'))
    process.once('SIGTERM', () => finish('SIGTERM'))
  })
} catch (error) {
  report.failure = error.message
  report.status = 'failed'
  emit('startup_failed', { error: error.message, reportPath })
  await cleanup('startup_failed')
}
