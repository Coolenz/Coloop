/** Explicitly enrolled, private local-only snapshot tool. Not an ordinary plugin overlay. */
import { dirname, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { lstat, mkdir, rename, unlink, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { renameSync, unlinkSync, writeFileSync } from "node:fs"
import { canonical, createManagedReadTool, loadEnrollment, managedRouteChecks, projectManagedReadMessages, sha256, verifyConfigFile } from "../agent/coloop_managed_core.mjs"

const PROVIDER = "rkllm"
const BASE = "http://127.0.0.1:8088/v1"
const AGENT = "rk-coloop-managed"
const fail = code => { throw new Error(code) }
const permissions = { "*": "deny", coloop_read: "ask", question: "allow" }
const privacy = { "X-RK-Privacy": "metadata-only", "X-RK-Cache": "off" }
const same = (left, right) => canonical(left) === canonical(right)
const onlyKeys = (value, fields) => value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every(key => fields.includes(key))
const run = promisify(execFile)

export default async function ColoopManagedPlugin(input) {
  const connection = process.env.COLOOP_MANAGED_CONNECTION
  if (!connection) return {}
  const applicationRoot = dirname(dirname(fileURLToPath(import.meta.url)))
  const initial = await loadEnrollment(connection), enrollmentHash = canonical(initial)
  // Model identity is pinned by the host-enrolled config hash, never by an env override.
  const pinnedConfig = await verifyConfigFile(initial)
  const MODEL = pinnedConfig?.model?.match(/^rkllm\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/)?.[1]
  if (!MODEL) fail("UNSAFE_MANAGED_MODEL")
  const expectedPlugins = ["coloop-hook.mjs", "coloop-managed.mjs"].map(name => pathToFileURL(`${applicationRoot}/plugins/${name}`).href)
  let effective, effectiveHash, stopped = false
  const leases = new Map()
  const progressHistory = new Map(), progressSeen = new Set()
  const activityArgs = ["--root", applicationRoot, "--owner-pid", String(process.pid), "--enrollment-id", initial.enrollmentId]
  async function memory(args, timeout, signal) {
    const { stdout } = await run("python3", [`${applicationRoot}/agent/coloop_managed_activity.py`, ...activityArgs, ...args], { timeout, signal, maxBuffer: 4096, env: process.env })
    const result = JSON.parse(stdout)
    if (typeof result.enabled !== "boolean") fail("INVALID_MANAGED_ACTIVITY_RESULT")
    return result
  }
  function state(sessionId) {
    let entry = leases.get(sessionId)
    if (!entry) {
      if (leases.size >= 64) fail("MANAGED_ACTIVITY_CAPACITY")
      entry = { id: `coloop-managed-${process.pid}-${sha256(initial.enrollmentId + "\0" + sessionId).slice(0, 24)}`, active: false, chain: Promise.resolve(), generation: 0, updated: 0 }
      leases.set(sessionId, entry)
    }
    return entry
  }
  function mark(entry, active) {
    entry.active = active
    entry.updated = Date.now()
    entry.chain = entry.chain.catch(() => {}).then(() => memory(["--session-id", entry.id, "--active", String(active)], 7000))
    return entry.chain
  }
  async function foreground(sessionId) {
    if (stopped) fail("MANAGED_SOURCE_STOPPED")
    const entry = state(sessionId), generation = ++entry.generation
    entry.readiness?.abort()
    entry.readiness = new AbortController()
    await mark(entry, true)
    if (!entry.active || entry.generation !== generation || stopped) fail("MANAGED_FOREGROUND_CANCELLED")
    await memory(["--ready-only"], 190000, entry.readiness.signal)
    if (!entry.active || entry.generation !== generation || stopped) fail("MANAGED_FOREGROUND_CANCELLED")
  }
  function release(sessionId) {
    const entry = leases.get(sessionId)
    if (!entry) return Promise.resolve()
    entry.generation++
    entry.readiness?.abort()
    return mark(entry, false).finally(() => { if (!entry.active && leases.get(sessionId) === entry) leases.delete(sessionId) })
  }
  const heartbeat = setInterval(() => {
    for (const entry of leases.values()) if (entry.active && Date.now() - entry.updated >= 25000) void mark(entry, true).catch(() => {})
  }, 30000)
  heartbeat.unref?.()

  function validateEffective(config) {
    if (config?.instructions !== undefined && (!Array.isArray(config.instructions) || config.instructions.length !== 0)) fail("UNSAFE_MANAGED_INSTRUCTIONS")
    if (!config || config.share !== "disabled" || config.autoupdate !== false || !same(config.enabled_providers, [PROVIDER]) || config.model !== `${PROVIDER}/${MODEL}` || config.small_model !== `${PROVIDER}/${MODEL}` || config.default_agent !== AGENT || !same(config.plugin, expectedPlugins) || !same(config.mcp ?? {}, {}) || !same(config.permission, permissions) || !same(config.compaction, { auto: false, prune: false })) fail("UNSAFE_MANAGED_CONFIGURATION")
    if (!onlyKeys(config.provider, [PROVIDER]) || !config.provider[PROVIDER]) fail("UNSAFE_MANAGED_PROVIDER")
    const provider = config.provider[PROVIDER], options = provider.options, model = provider.models?.[MODEL]
    if (!onlyKeys(provider, ["npm", "name", "options", "models"]) || provider.npm !== "@ai-sdk/openai-compatible" || !onlyKeys(options, ["baseURL", "apiKey", "timeout", "headers"]) || options.baseURL !== BASE || !same(options.headers, privacy) || !onlyKeys(provider.models, [MODEL]) || !model || !same(model.headers, privacy)) fail("UNSAFE_MANAGED_PROVIDER")
    if (!onlyKeys(config.agent, ["title", "summary", AGENT]) || config.agent.title?.disable !== true || config.agent.summary?.disable !== true || !same(config.agent[AGENT]?.permission, permissions)) fail("UNSAFE_MANAGED_AGENT")
  }
  async function current() {
    if (process.env.RK_AGENT_ROOT !== applicationRoot || process.env.OPENCODE_CONFIG !== initial.configPath || process.env.OPENCODE_CONFIG_CONTENT) fail("UNSAFE_MANAGED_ENVIRONMENT")
    const enrollment = await loadEnrollment(connection)
    if (canonical(enrollment) !== enrollmentHash) fail("MANAGED_ENROLLMENT_CHANGED")
    await verifyConfigFile(enrollment)
    if (!effective) fail("MANAGED_CONFIG_NOT_READY")
    validateEffective(effective)
    if (canonical(effective) !== effectiveHash) fail("MANAGED_EFFECTIVE_CONFIG_CHANGED")
    if (resolve(input.directory) !== initial.root) fail("MANAGED_WORKSPACE_MISMATCH")
  }
  function modelRoute(model, provider, agent) {
    const checks = managedRouteChecks({ model, provider, agent }, { agentId: AGENT, providerId: PROVIDER, modelId: MODEL, npm: "@ai-sdk/openai-compatible", baseURL: BASE, headers: privacy })
    const failed = Object.keys(checks).find(key => !checks[key])
    if (failed) fail("MANAGED_MODEL_ROUTE_CHANGED_" + failed.toUpperCase())
  }
  async function privateDirectory(path) {
    await mkdir(path, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error })
    const info = await lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077)) fail("PRIVATE_MANAGED_PROGRESS_REQUIRED")
  }
  async function onProgress(value) {
    if (!progressSeen.has(value.attemptId)) {
      if (progressSeen.size >= 1000) fail("MANAGED_PROGRESS_CAPACITY")
      progressSeen.add(value.attemptId)
    }
    const history = [...(progressHistory.get(value.attemptId) ?? []), { stage: value.stage, scanOpenCount: value.scanOpenCount, scanBytes: value.scanBytes, releaseCount: value.releaseCount, releaseBytes: value.releaseBytes, routeVerified: value.routeVerified, permitVerified: value.permitVerified, elapsedMs: value.elapsedMs, ...(value.reasonCode ? { reasonCode: value.reasonCode } : {}) }].slice(-16)
    progressHistory.set(value.attemptId, history)
    const base = `${applicationRoot}/.runtime/coloop-managed`
    await privateDirectory(base)
    await privateDirectory(`${base}/progress`)
    const folder = `${base}/progress/${process.pid}`
    await privateDirectory(folder)
    const path = `${folder}/${value.attemptId}.json`, pending = path + "." + randomUUID() + ".pending"
    try {
      await writeFile(pending, JSON.stringify({ ...value, history }), { mode: 0o600, flag: "wx" })
      await rename(pending, path)
    } finally { await unlink(pending).catch(() => {}) }
    if (["released", "blocked"].includes(value.stage) && value.reasonCode) progressHistory.delete(value.attemptId)
    if (value.stage === "released") progressHistory.delete(value.attemptId)
  }
  function onCommit(value) {
    const history = [...(progressHistory.get(value.attemptId) ?? []), { stage: value.stage, scanOpenCount: value.scanOpenCount, scanBytes: value.scanBytes, releaseCount: value.releaseCount, releaseBytes: value.releaseBytes, routeVerified: value.routeVerified, permitVerified: value.permitVerified, elapsedMs: value.elapsedMs }].slice(-16)
    const path = `${applicationRoot}/.runtime/coloop-managed/progress/${process.pid}/${value.attemptId}.json`
    const pending = path + "." + randomUUID() + ".pending"
    try {
      // All directories were verified by the awaited pre-commit report. Tiny
      // metadata-only synchronous commit closes the callback/return race.
      writeFileSync(pending, JSON.stringify({ ...value, history }), { mode: 0o600, flag: "wx" })
      renameSync(pending, path)
    } finally { try { unlinkSync(pending) } catch {} }
    progressHistory.delete(value.attemptId)
  }
  const tool = createManagedReadTool({ enrollment: initial, loadCurrent: () => loadEnrollment(connection), guard: current, onProgress, onCommit })
  return {
    config: async config => {
      validateEffective(config)
      effective = config
      effectiveHash = canonical(config)
      await verifyConfigFile(initial)
    },
    "chat.message": async info => {
      await current()
      if ((info.agent ?? AGENT) !== AGENT || (info.model && (info.model.providerID !== PROVIDER || info.model.modelID !== MODEL))) fail("MANAGED_MODEL_ROUTE_CHANGED")
      await foreground(info.sessionID)
    },
    "experimental.chat.system.transform": async info => {
      await current()
      if (info.model?.providerID !== PROVIDER || (info.model?.id ?? info.model?.modelID) !== MODEL) fail("MANAGED_MODEL_ROUTE_CHANGED")
    },
    "experimental.chat.messages.transform": async (_info, output) => {
      await current()
      const projected = projectManagedReadMessages(output.messages)
      // The fixed SDK consumes its original msgs array after this hook and
      // ignores a replacement output.messages property. Splice only cloned
      // presentation messages into that local array; no DB/API writes occur.
      if (projected !== output.messages) output.messages.splice(0, output.messages.length, ...projected)
    },
    "chat.params": async (info, output) => {
      await current()
      modelRoute(info.model, info.provider, info.agent)
      for (const key of ["baseURL", "baseUrl", "endpoint", "url", "proxy", "fetch"]) if (Object.hasOwn(output.options ?? {}, key)) fail("MANAGED_MODEL_ROUTE_CHANGED")
    },
    "chat.headers": async (info, output) => {
      await current()
      modelRoute(info.model, info.provider, info.agent)
      for (const key of Object.keys(output.headers)) if (!["x-rk-privacy", "x-rk-cache"].includes(key.toLowerCase())) fail("MANAGED_MODEL_HEADERS_CHANGED")
      output.headers["X-RK-Privacy"] = "metadata-only"
      output.headers["X-RK-Cache"] = "off"
    },
    tool: { coloop_read: tool },
    event: async ({ event }) => {
      const value = event.properties
      try {
        if (event.type === "session.status" && value.status?.type === "idle") await release(value.sessionID)
        if (event.type === "session.deleted" || event.type === "session.error") await release(value.sessionID ?? value.info?.id)
      } catch { console.warn("[ColoopManaged] MEMORY_LEASE_RELEASE_FAILED") }
    },
    dispose: async () => {
      stopped = true
      clearInterval(heartbeat)
      await Promise.allSettled([...leases.keys()].map(release))
    },
  }
}
