/**
 * Native OpenCode 1.19.5 observation bridge, without OCR or extra dependencies.
 * OpenCode MIT API reference: 810c0eba1a7348036f8bdf61e6632d0c36c6876c.
 * Session mirroring design reference: HumanLayer (Apache-2.0),
 * 316e74ef9af0b7b3d64ac45b5eb93415b3ed2204. No HumanLayer runtime/code is bundled.
 * Native event callbacks observe; the source's own pending Deferred waits for replies.
 */
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { Agent, request } from "node:http"
import { performance } from "node:perf_hooks"
import { isManagedEvidence, validateEnrollment, verifyConfigFile, verifyManagedPermit, registerManagedPermit, revokeManagedPermit } from "../agent/coloop_managed_core.mjs"

const ID = /^[A-Za-z0-9._:-]{1,128}$/
const CHOICE = /^[A-Za-z0-9_-]{1,64}$/
const HASH = /^[a-f0-9]{64}$/
const REASON = /^[A-Z][A-Z0-9_]{0,79}$/
const TRANSIENT = new Set(["MODEL_BUSY", "REQUEST_IN_PROGRESS", "REVIEW_UNAVAILABLE", "REVIEW_TIMEOUT"])
const MAX_SESSIONS = 64
const MAX_QUEUE = 128
const MAX_SCOPE_QUEUE_BYTES = 65536
const MAX_TOTAL_QUEUE_BYTES = 262144
const MAX_RETIRED_SCOPES = 64
const MAX_TEXT_BYTES = 2048
const secret = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._~+/-]{8,})|(?:api[_-]?key|password|passwd|access[_-]?token|secret|密码|口令)["']?\s*[=:：]\s*["']?[^\s"',;}{]+|\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@|\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b|(?<!\d)1[3-9]\d{9}(?!\d)|(?<!\d)\d{17}[\dX](?!\d)/i
const secretKey = /(?:api[_-]?key|password|passwd|access[_-]?token|secret|密码|口令)/i

function canonical(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value)
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`
  throw new Error("INVALID_JSON")
}
function digest(value) { return createHash("sha256").update(canonical(value)).digest("hex") }
function parsed(raw) {
  const result = JSON.parse(raw)
  const stack = []
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === "{" || raw[i] === "[") stack.push(raw[i] === "{" ? new Set() : null)
    else if (raw[i] === "}" || raw[i] === "]") stack.pop()
    else if (raw[i] === '"') {
      const start = i++
      for (; i < raw.length; i++) { if (raw[i] === "\\") i++; else if (raw[i] === '"') break }
      let next = i + 1
      while (/\s/.test(raw[next] ?? "") && next < raw.length) next++
      if (raw[next] === ":") {
        const key = JSON.parse(raw.slice(start, i + 1)), keys = stack.at(-1)
        if (!keys || keys.has(key)) throw new Error("DUPLICATE_JSON_KEY")
        keys.add(key)
      }
    }
  }
  return result
}
function exact(value, required, optional = []) {
  return value && typeof value === "object" && !Array.isArray(value) && required.every(k => Object.hasOwn(value, k)) && Object.keys(value).every(k => required.includes(k) || optional.includes(k))
}
function loopback(value) {
  const url = new URL(value)
  if (url.hostname === "localhost") url.hostname = "127.0.0.1"
  if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("LOOPBACK_REQUIRED")
  return url
}
function clean(value) {
  if (typeof value !== "string") return ""
  const text = value.slice(0, 8192).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "")
  if (/<\/?think>/i.test(text)) return "[reasoning content omitted]"
  if (secret.test(text)) return "[sensitive content omitted]"
  const buffer = Buffer.from(text, "utf8")
  if (buffer.length <= MAX_TEXT_BYTES && value.length <= 8192) return text
  const marker = "\n[TRUNCATED_UNTRUSTED_OBSERVATION]"
  let end = Math.min(buffer.length, MAX_TEXT_BYTES - Buffer.byteLength(marker))
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--
  return buffer.subarray(0, end).toString("utf8") + marker
}
function inputText(args) {
  let sensitive = false, visited = 0
  try {
    const rendered = JSON.stringify(args, (key, value) => {
      if (secretKey.test(key) && value !== undefined && value !== null && value !== "") sensitive = true
      if (typeof value === "string" && secret.test(value.slice(0, 8192))) sensitive = true
      if (++visited > 256) return "[OMITTED_INPUT_BUDGET]"
      return typeof value === "string" && value.length > 8192 ? clean(value) : value
    })
    return sensitive ? "[sensitive content omitted]" : clean(rendered)
  } catch { return "[unserializable tool input omitted]" }
}
function httpJson(base, path, agent, { body, authorization, signal, timeout = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const encoded = body === undefined ? undefined : Buffer.from(JSON.stringify(body))
    if (encoded && encoded.length > 32768) { reject(new Error("PAYLOAD_LIMIT")); return }
    let settled = false
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener("abort", abort)
      pending.destroy()
      error ? reject(error) : resolve(value)
    }
    const pending = request(new URL(path, base), {
      method: encoded ? "POST" : "GET", agent,
      headers: { "content-type": "application/json", ...(authorization ? { authorization } : {}), ...(encoded ? { "content-length": encoded.length } : {}) },
    }, response => {
      if (response.statusCode !== 200 || !/^application\/json(?:;|$)/i.test(response.headers["content-type"] ?? "")) { response.resume(); finish(new Error("HTTP_NOT_ACCEPTED")); return }
      const chunks = []; let size = 0
      response.on("data", chunk => { size += chunk.length; if (size > 1048576) finish(new Error("RESPONSE_LIMIT")); else chunks.push(chunk) })
      response.once("error", () => finish(new Error("HTTP_TRANSPORT")))
      response.once("aborted", () => finish(new Error("HTTP_TRANSPORT")))
      response.once("end", () => { try { finish(undefined, parsed(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)))) } catch { finish(new Error("INVALID_JSON")) } })
    })
    const abort = () => finish(new Error("REQUEST_CANCELLED"))
    const timer = setTimeout(() => finish(new Error("HTTP_TIMEOUT")), timeout)
    pending.once("error", () => finish(new Error("HTTP_TRANSPORT")))
    if (signal?.aborted) { abort(); return }
    signal?.addEventListener("abort", abort, { once: true })
    pending.end(encoded)
  })
}

async function sdkJson(core, sourceFetch, directory, path, { body, signal, controlAction } = {}) {
  // The normal TUI uses an in-process fetch and its serverUrl is only a placeholder.
  // Keep the provided SDK transport; never reconnect to localhost:4096 ourselves.
  const controlPaths = {
    send_message: /^\/session\/[A-Za-z0-9._:%-]{1,384}\/prompt_async$/,
    abort_turn: /^\/session\/[A-Za-z0-9._:%-]{1,384}\/abort$/,
    get_message: /^\/session\/[A-Za-z0-9._:%-]{1,384}\/message\/[A-Za-z0-9._:%-]{1,384}$/,
    get_status: /^\/session\/status$/,
  }
  if (controlAction ? !controlPaths[controlAction]?.test(path) : !/^\/(?:question|permission)(?:\/[A-Za-z0-9._:%-]{1,384}\/(?:reply|reject))?$/.test(path)) throw new Error("INVALID_SOURCE_PATH")
  const expectedStatus = controlAction === "send_message" ? 204 : 200
  const method = controlAction === "abort_turn" ? "POST" : body === undefined ? "GET" : "POST"
  const encoded = body === undefined ? undefined : JSON.stringify(body)
  if (encoded && Buffer.byteLength(encoded) > 32768) throw new Error("PAYLOAD_LIMIT")
  const controller = new AbortController()
  const transports = new Set()
  let reader, timedOut = false, rejectAbort
  const cancelled = new Promise((_, reject) => { rejectAbort = reject })
  const abort = () => controller.abort()
  const onAbort = () => {
    rejectAbort(new Error(timedOut ? "HTTP_TIMEOUT" : "REQUEST_CANCELLED"))
    for (const transport of transports) transport.controller.abort()
    if (reader) void reader.cancel().catch(() => {})
  }
  controller.signal.addEventListener("abort", onAbort, { once: true })
  signal?.addEventListener("abort", abort, { once: true })
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, 5000)
  if (signal?.aborted) controller.abort()
  const operation = async () => {
    controller.signal.throwIfAborted()
    const result = await core.request({
      url: path, method, query: { directory },
      ...(encoded === undefined ? {} : { body, bodySerializer: JSON.stringify, headers: { "content-type": "application/json" } }),
      signal: controller.signal, redirect: "error", parseAs: "stream", responseStyle: "fields", throwOnError: false,
      fetch: async request => {
        // SDK 1.19.5 rewrites GET Requests; do not depend on cancellation through
        // that derived Request chain. Own a directly signalled transport Request
        // and retain it until fetch settles, including an uncooperative fetch.
        const transport = { controller: new AbortController(), request: undefined }
        transport.request = new Request(request, { signal: transport.controller.signal, redirect: "error" })
        transports.add(transport)
        if (controller.signal.aborted) transport.controller.abort()
        let response
        try {
          transport.controller.signal.throwIfAborted()
          response = await sourceFetch(transport.request)
        } finally { transports.delete(transport) }
        if (controller.signal.aborted || response.status !== expectedStatus || response.redirected || (expectedStatus !== 204 && !/^application\/json(?:;|$)/i.test(response.headers.get("content-type") ?? ""))) {
          await response.body?.cancel().catch(() => {})
          throw new Error("HTTP_NOT_ACCEPTED")
        }
        const length = Number(response.headers.get("content-length"))
        if (Number.isFinite(length) && length > 1048576) {
          await response.body?.cancel().catch(() => {})
          throw new Error("RESPONSE_LIMIT")
        }
        return response
      },
    })
    controller.signal.throwIfAborted()
    if (expectedStatus === 204 && result?.response?.status === 204) return undefined
    if (!result || result.response?.status !== 200 || typeof result.data?.getReader !== "function") throw new Error("HTTP_NOT_ACCEPTED")
    reader = result.data.getReader()
    const chunks = []; let size = 0
    for (;;) {
      const { done, value } = await reader.read()
      controller.signal.throwIfAborted()
      if (done) break
      size += value.byteLength
      if (size > 1048576) throw new Error("RESPONSE_LIMIT")
      chunks.push(value)
    }
    try { return parsed(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))) }
    catch { throw new Error("INVALID_JSON") }
  }
  try { return await Promise.race([operation(), cancelled]) }
  finally {
    clearTimeout(timer)
    signal?.removeEventListener("abort", abort)
    controller.signal.removeEventListener("abort", onAbort)
    controller.abort()
    for (const transport of transports) transport.controller.abort()
    if (reader) { void reader.cancel().catch(() => {}); try { reader.releaseLock() } catch {} }
  }
}

export default async function ColoopHook(input) {
  const file = process.env.COLOOP_HOOK_CONNECTION || (process.env.APPDATA ? join(process.env.APPDATA, "coloop/agent-coordinator/connection.json") : undefined)
  let config, core, sourceFetch
  try {
    if (!file) return {}
    core = input.client?._client
    if (typeof core?.request !== "function" || typeof core?.getConfig !== "function") return {}
    sourceFetch = core.getConfig().fetch
    if (typeof sourceFetch !== "function") return {}
    const raw = await readFile(file, "utf8")
    if (Buffer.byteLength(raw) > 8192) return {}
    config = parsed(raw)
    config.url = loopback(config.url)
    if (typeof config.token !== "string" || config.token.length < 32 || config.token.length > 512 || /\s/.test(config.token)) return {}
    config.workspace ??= input.directory
    if (typeof config.workspace !== "string" || !config.workspace || config.workspace.length > 1024 || /[\x00-\x1f]/.test(config.workspace)) return {}
    config.sourceId ??= `opencode:${digest(input.directory).slice(0, 32)}`
    if (!ID.test(config.sourceId)) return {}
    if (config.managed) config.managed = validateEnrollment(config.managed)
  } catch { return {} }

  const instanceId = randomUUID(), agent = new Agent({ keepAlive: true, maxSockets: 8 })
  const sessions = new Map(), closed = new Set(), roles = new Map(), messageStates = new Map(), callStates = new Map(), jobs = new Map()
  const retired = new Set(), diagnostics = new Set()
  let disposed = false, queuedCount = 0, queuedBytes = 0
  const contextSymbol = Symbol.for("coloop.managed.context.v1")
  const managedContext = ({ sessionId, messageId }) => {
    const owner = messageStates.get(messageId)
    if (disposed || !owner || owner.sessionId !== sessionId || owner.retired || owner.broken || sessions.get(sessionId) !== owner) return undefined
    return { instanceId, taskId: owner.taskId }
  }
  if (config.managed) globalThis[contextSymbol] = managedContext
  const source = (path, options) => sdkJson(core, sourceFetch, input.directory, path, options)
  const local = (path, body, signal, timeout) => httpJson(config.url, path, agent, { body, signal, timeout, authorization: `Bearer ${config.token}` })
  // Control is independent of the observation/approval queue. Native user input
  // is intentionally sent verbatim; observation redaction must not rewrite it.
  const controlSessions = new Map(), controlLedger = new Map()
  const controlController = new AbortController()
  const controlHost = process.platform === "win32" ? "windows" : process.platform === "linux" ? "rk" : "other"
  let controlTimer, controlWork, controlRunning = false
  const controlIdentity = { version: 1, source: "opencode", sourceId: config.sourceId, instanceId }
  function scheduleControl(delay = 50) {
    if (disposed || controlTimer || controlRunning) return
    controlTimer = setTimeout(() => {
      controlTimer = undefined
      controlWork = tickControl().catch(() => {})
    }, delay)
    controlTimer.unref?.()
  }
  function updateControl(sessionId, value = "idle", title) {
    if (!ID.test(sessionId ?? "") || disposed) return
    let current = controlSessions.get(sessionId)
    if (!current) {
      if (controlSessions.size >= MAX_SESSIONS + MAX_RETIRED_SCOPES) {
        const stale = [...controlSessions].find(([, entry]) => entry.state === "closed" && !entry.dirty)
        if (!stale) return
        controlSessions.delete(stale[0])
      }
      current = { state: value, dirty: true, registered: false, lastRegister: 0 }
      controlSessions.set(sessionId, current)
    }
    if (current.state === "closed" && value !== "closed") return
    if (current.state !== value) { current.state = value; current.dirty = true }
    if (typeof title === "string") {
      const safeTitle = clean(title).slice(0, 160)
      if (safeTitle && current.title !== safeTitle) { current.title = safeTitle; current.dirty = true }
    }
    scheduleControl()
  }
  async function reportControl(entry) {
    await local("/v1/control/report", { ...controlIdentity, sessionId: entry.command.sessionId,
      commandId: entry.command.commandId, ...entry.result }, controlController.signal, 1500)
    entry.reported = true
  }
  function validCommand(command) {
    if (!exact(command, ["commandId", "sessionId", "instanceId", "action", "expiresAt"], ["text", "messageId"]) ||
        !ID.test(command.commandId) || !ID.test(command.sessionId) || [".", ".."].includes(command.sessionId) || command.instanceId !== instanceId ||
        !["send_message", "abort_turn"].includes(command.action) || typeof command.expiresAt !== "string" ||
        !Number.isFinite(Date.parse(command.expiresAt))) return false
    if (command.action === "abort_turn") return command.text === undefined && command.messageId === undefined
    return typeof command.text === "string" && command.text.trim().length > 0 && Buffer.byteLength(command.text) <= 24000 &&
      (command.messageId === undefined || (typeof command.messageId === "string" && ID.test(command.messageId) && ![".", ".."].includes(command.messageId)))
  }
  const controlSource = (path, controlAction, body) => source(path, { controlAction, body, signal: controlController.signal })
  async function confirmControl(command, messageId) {
    const until = performance.now() + 1500
    do {
      controlController.signal.throwIfAborted()
      try {
        if (command.action === "send_message") {
          const message = await controlSource(`/session/${encodeURIComponent(command.sessionId)}/message/${encodeURIComponent(messageId)}`, "get_message")
          if (message?.info?.id === messageId && message.info.sessionID === command.sessionId && message.info.role === "user" &&
              Array.isArray(message.parts) && message.parts.some(part => part.type === "text" && part.text === command.text)) return true
        } else {
          const statuses = await controlSource("/session/status", "get_status")
          if (statuses && typeof statuses === "object" && !Array.isArray(statuses) &&
              (!Object.hasOwn(statuses, command.sessionId) || statuses[command.sessionId]?.type === "idle")) {
            updateControl(command.sessionId, "idle")
            return true
          }
        }
      } catch { controlController.signal.throwIfAborted() }
      await new Promise(resolve => { const timer = setTimeout(resolve, 75); timer.unref?.() })
    } while (performance.now() < until)
    return false
  }
  async function executeControl(command) {
    if (!validCommand(command)) return
    const hash = digest(command), previous = controlLedger.get(command.commandId)
    if (previous) {
      // A conflicting envelope cannot reuse an ID to execute another action.
      if (previous.hash === hash) await reportControl(previous)
      return
    }
    if (controlLedger.size >= 1024) return // Never evict an executed ID and make a replay executable.
    const entry = { command: { commandId: command.commandId, sessionId: command.sessionId }, hash, result: { status: "accepted" }, reported: false }
    controlLedger.set(command.commandId, entry)
    let dispatched = false
    try {
      const current = controlSessions.get(command.sessionId)
      if (!current?.registered || current.state === "closed") throw new Error("CONTROL_SESSION_UNAVAILABLE")
      if (Date.parse(command.expiresAt) <= Date.now()) throw new Error("CONTROL_COMMAND_EXPIRED")
      if (Date.parse(command.expiresAt) > Date.now() + 300000) throw new Error("CONTROL_COMMAND_LIFETIME")
      // If receipt delivery fails, do not issue the native action. Repeated
      // polls only retry the final report, never this POST.
      await reportControl(entry)
      if (disposed || Date.parse(command.expiresAt) <= Date.now()) throw new Error("CONTROL_COMMAND_EXPIRED")
      if (controlSessions.get(command.sessionId)?.state === "closed") throw new Error("CONTROL_SESSION_UNAVAILABLE")
      const path = `/session/${encodeURIComponent(command.sessionId)}`
      const messageId = command.action === "send_message" ? command.messageId ?? `msg_${digest({ instanceId, commandId: command.commandId }).slice(0, 26)}` : undefined
      if (messageId) entry.result.messageId = messageId
      dispatched = true
      if (command.action === "send_message") {
        await controlSource(`${path}/prompt_async`, "send_message", { messageID: messageId, parts: [{ type: "text", text: command.text }] })
      } else {
        const accepted = await controlSource(`${path}/abort`, "abort_turn")
        if (accepted !== true) { dispatched = false; throw new Error("CONTROL_ABORT_REJECTED") }
      }
      entry.result.status = await confirmControl(command, messageId) ? "confirmed" : "unknown"
      if (entry.result.status === "unknown") entry.result.errorCode = "CONTROL_RESULT_UNCONFIRMED"
    } catch (error) {
      entry.result.status = dispatched ? "unknown" : "failed"
      entry.result.errorCode = REASON.test(error?.message ?? "") ? error.message : "CONTROL_SOURCE_UNAVAILABLE"
    }
    entry.reported = false
    if (!disposed) await reportControl(entry).catch(() => {})
  }
  async function tickControl() {
    if (disposed || controlRunning) return
    controlRunning = true
    try {
      // Heartbeats preserve source state; they never infer idle from the lack
      // of a text update or from a successful network request.
      for (const [sessionId, entry] of controlSessions) {
        if (!entry.dirty && performance.now() - entry.lastRegister < 20000) continue
        const state = entry.state, title = entry.title
        await local("/v1/control/register", { ...controlIdentity, sessionId, workspace: config.workspace,
          host: controlHost, capabilities: ["send_message", "abort_turn"], state,
          ...(title ? { title } : {}) }, controlController.signal, 1500)
        entry.registered = true; entry.lastRegister = performance.now()
        entry.dirty = entry.state !== state || entry.title !== title
      }
      for (const entry of controlLedger.values()) if (!entry.reported) await reportControl(entry)
      if (![...controlSessions.values()].some(entry => entry.registered && entry.state !== "closed")) return
      const response = await local("/v1/control/poll", controlIdentity, controlController.signal, 1500)
      if (!exact(response, ["version", "commands"]) || response.version !== 1 || !Array.isArray(response.commands) || response.commands.length > 16) return
      for (const command of response.commands) {
        if (disposed) break
        await executeControl(command)
      }
    } finally { controlRunning = false; if (controlSessions.size && !disposed) scheduleControl(1000) }
  }
  function diagnostic(code) {
    if (diagnostics.has(code)) return
    diagnostics.add(code)
    // Fixed codes only: a full queue must remain observable without logging data.
    console.warn(`[ColoopHook] ${code}`)
  }
  function fresh(sessionId, taskId) {
    return { sessionId, taskId, sequence: 0, queue: new Map(), pending: new Map(), inFlight: 0, queuedBytes: 0, chain: Promise.resolve(), busy: false, broken: false, retired: false, used: false, touched: performance.now() }
  }
  function release(s, item) {
    if (item.released) return
    item.released = true
    queuedCount--; queuedBytes -= item.bytes; s.queuedBytes -= item.bytes
    if (s.pending.get(item.key) === item) s.pending.delete(item.key)
    if (s.queue.get(item.key) === item) s.queue.delete(item.key)
    item.payload = undefined
  }
  function clearQueued(s) {
    clearTimeout(s.timer); s.timer = undefined
    for (const item of [...s.pending.values()]) release(s, item)
    s.queue.clear()
  }
  function breakScope(s, reason) {
    s.broken = true; s.failureReason ??= reason
    clearQueued(s); cancel(s.sessionId)
    diagnostic(reason)
  }
  function rememberClosed(sessionId) {
    closed.add(sessionId)
    if (closed.size > 1000) closed.delete(closed.values().next().value)
  }
  function retire(s, discard = true) {
    if (retired.size >= MAX_RETIRED_SCOPES) return false
    s.retired = true; s.busy = false
    cancel(s.sessionId)
    if (discard) clearQueued(s)
    else void flush(s)
    if (!s.used) return true
    // At most 64 fixed-size close packets exist outside the 128-packet data
    // budget. Each waits only for that scope's already bounded in-flight chain.
    retired.add(s)
    s.chain = s.chain.catch(() => {}).then(async () => {
      await observed(s, "closed", { state: "closed" })
    }).catch(() => { s.broken = true }).finally(() => { retired.delete(s) })
    return true
  }
  function state(sessionId, taskId) {
    if (typeof sessionId !== "string" || !ID.test(sessionId) || closed.has(sessionId) || disposed) return undefined
    let s = sessions.get(sessionId)
    if (!s) {
      if (sessions.size >= MAX_SESSIONS) {
        const idle = [...sessions.values()].filter(value => !value.busy && !value.inFlight && !value.pending.size && ![...jobs.values()].some(job => !job.done && job.sessionId === value.sessionId)).sort((a, b) => a.touched - b.touched)[0]
        if (!idle || !retire(idle)) { diagnostic("HOOK_SESSION_CAPACITY"); return undefined }
        sessions.delete(idle.sessionId); rememberClosed(idle.sessionId)
        updateControl(idle.sessionId, "closed")
      }
      s = fresh(sessionId, taskId && ID.test(taskId) ? taskId : sessionId)
      sessions.set(sessionId, s)
      updateControl(sessionId)
    }
    if (taskId && ID.test(taskId) && s.taskId !== taskId) {
      const previous = s
      if (!retire(previous)) { breakScope(previous, "HOOK_SESSION_CAPACITY"); return undefined }
      // An old in-flight packet retains its old task; never relabel its text as the new task.
      s = fresh(sessionId, taskId)
      sessions.set(sessionId, s)
    }
    s.touched = performance.now()
    return s
  }
  function envelope(s, kind, payload) {
    s.used = true
    return { version: 1, source: "opencode", sourceId: config.sourceId, instanceId, sessionId: s.sessionId, taskId: s.taskId, sequence: ++s.sequence, eventId: randomUUID(), kind, workspace: config.workspace, payload }
  }
  async function observed(s, kind, payload) {
    const message = envelope(s, kind, payload)
    const receipt = await local("/v1/hooks", message, undefined, 1500)
    if (!receipt || receipt.version !== 1 || receipt.sourceId !== message.sourceId || receipt.instanceId !== instanceId || receipt.eventId !== message.eventId || receipt.sequence !== message.sequence) throw new Error("HOOK_RECEIPT_MISMATCH")
  }
  function flush(s) {
    clearTimeout(s.timer); s.timer = undefined
    const entries = [...s.queue.values()]; s.queue.clear()
    if (entries.length) s.chain = s.chain.then(async () => {
      for (const item of entries) {
        if (item.released) continue
        if (disposed) { release(s, item); continue }
        if (s.pending.get(item.key) === item) s.pending.delete(item.key)
        s.inFlight++
        try { await observed(s, item.kind, item.payload) }
        catch { breakScope(s, "CONTEXT_DELIVERY_FAILED") }
        finally { s.inFlight--; release(s, item) }
      }
    }).catch(() => { breakScope(s, "CONTEXT_DELIVERY_FAILED") })
    return s.chain
  }
  function queue(s, kind, payload, key = randomUUID()) {
    if (!s || s.retired || disposed) return
    const control = kind === "compacted" || (kind === "status" && ["idle", "closed", "error", "approval.pending"].includes(payload.state))
    if (s.broken && !control) return
    s.used = true
    const previous = s.pending.get(key), size = Buffer.byteLength(JSON.stringify({ kind, payload }))
    const delta = size - (previous?.bytes ?? 0)
    if ((!previous && queuedCount >= MAX_QUEUE) || s.queuedBytes + delta > MAX_SCOPE_QUEUE_BYTES || queuedBytes + delta > MAX_TOTAL_QUEUE_BYTES) { breakScope(s, "HOOK_QUEUE_LIMIT"); return }
    if (previous) {
      previous.kind = kind; previous.payload = payload; previous.bytes = size
      queuedBytes += delta; s.queuedBytes += delta
      return
    }
    const item = { key, kind, payload, bytes: size, released: false }
    queuedCount++; queuedBytes += size; s.queuedBytes += size
    s.pending.set(key, item); s.queue.set(key, item)
    if (!s.timer) s.timer = setTimeout(() => { void flush(s) }, 10)
  }
  function cancel(sessionId, id) {
    for (const job of jobs.values()) if (job.sessionId === sessionId && (!id || job.id === id)) job.controller.abort()
  }
  function normalize(kind, pending) {
    if (!pending || typeof pending.id !== "string" || typeof pending.sessionID !== "string" || !ID.test(pending.id) || !ID.test(pending.sessionID)) return undefined
    const result = { kind, id: pending.id, sessionId: pending.sessionID, originalDigest: digest(pending) }
    if (kind === "permission") {
      if (typeof pending.permission !== "string" || pending.permission.length > 80 || !Array.isArray(pending.patterns) || !pending.patterns.length || pending.patterns.length > 20 || !pending.patterns.every(p => typeof p === "string" && p.length > 0 && p.length <= 1024)) return undefined
      const metadata = pending.metadata
      if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined
      const keys = Object.keys(metadata)
      if (pending.permission === "coloop_read" && keys.length === 1 && keys[0] === "coloop") {
        if (!config.managed || !isManagedEvidence(metadata.coloop) || metadata.coloop.sessionId !== pending.sessionID ||
            metadata.coloop.enrollmentId !== config.managed.enrollmentId) return undefined
        result.tool = pending.permission; result.patterns = pending.patterns; result.managed = metadata.coloop
        return result
      }
      if (keys.length && (keys.length !== 1 || keys[0] !== "command" || typeof metadata.command !== "string" || metadata.command.length > 8000)) return undefined
      result.tool = pending.permission; result.patterns = pending.patterns
      if (keys.length) result.command = metadata.command
    } else {
      if (!Array.isArray(pending.questions) || pending.questions.length !== 1) return undefined
      const q = pending.questions[0]
      if (q.multiple || typeof q.question !== "string" || !q.question || q.question.length > 4000 || !Array.isArray(q.options) || q.options.length < 1 || q.options.length > 20) return undefined
      const choices = q.options.map((o, i) => ({ id: String(i), label: o.label, description: o.description }))
      if (!choices.every(o => typeof o.label === "string" && o.label.length > 0 && o.label.length <= 200 && typeof o.description === "string" && o.description.length <= 800) || new Set(choices.map(o => o.label)).size !== choices.length) return undefined
      result.question = q.question; result.choices = choices
    }
    return result
  }
  function verify(response, sent, approval) {
    if (!exact(response, ["version", "sourceId", "instanceId", "eventId", "sequence", "originalDigest", "reviewEvent", "decision", "metrics"]) || response.version !== 1 || response.sourceId !== sent.sourceId || response.instanceId !== instanceId || response.eventId !== sent.eventId || response.sequence !== sent.sequence || response.originalDigest !== approval.originalDigest) throw new Error("REVIEW_BINDING_MISMATCH")
    const e = response.reviewEvent, d = response.decision
    if (!exact(e, ["version", "id", "sessionId", "kind", "workspace", "createdAt", "expiresAt", "contextRef"], ["tool", "patterns", "command", "question", "choices", "managed"]) || e.version !== 1 || !HASH.test(e.contextRef) || e.id !== approval.id || e.sessionId !== approval.sessionId || e.kind !== approval.kind || e.workspace !== sent.workspace) throw new Error("REVIEW_EVENT_MISMATCH")
    for (const key of ["tool", "patterns", "command", "question", "choices", "managed"]) if (canonical(e[key] ?? null) !== canonical(approval[key] ?? null)) throw new Error("REVIEW_EVENT_MISMATCH")
    const lifetime = Date.parse(e.expiresAt) - Date.parse(e.createdAt)
    if (!Number.isFinite(lifetime) || lifetime <= 0 || lifetime > 180000) throw new Error("INVALID_REVIEW_LIFETIME")
    if (!exact(d, ["version", "id", "sessionId", "requestHash", "decision", "reasonCode", "source", "expiresAt"], ["choiceId", "permit"]) || d.version !== 1 || d.id !== approval.id || d.sessionId !== approval.sessionId || d.requestHash !== digest(e) || d.expiresAt !== e.expiresAt || !["allow", "deny", "select", "defer"].includes(d.decision) || !["policy", "rk"].includes(d.source) || !REASON.test(d.reasonCode) || (d.permit && (d.decision !== "allow" || !approval.managed))) throw new Error("INVALID_REVIEW_DECISION")
    if (d.decision === "select") {
      if (approval.kind !== "question" || !CHOICE.test(d.choiceId) || !approval.choices.some(c => c.id === d.choiceId)) throw new Error("INVALID_SELECTION")
    } else if (Object.hasOwn(d, "choiceId") || (approval.kind === "question" && d.decision === "allow")) throw new Error("INVALID_SELECTION")
    return { eventHash: digest(e), decision: d, lifetime }
  }
  async function approval(s, kind, pending) {
    const started = performance.now(), key = `${kind}:${pending.sessionID}:${pending.id}`
    if (jobs.has(key) || disposed) return
    if (jobs.size >= 1000) {
      for (const [k, value] of jobs) if (value.done) { jobs.delete(k); break }
      if (jobs.size >= 1000) return
    }
    const controller = new AbortController(), job = { controller, sessionId: pending.sessionID, id: pending.id }
    jobs.set(key, job)
    let reasonCode = "UNSUPPORTED_APPROVAL", result, sent, reviewMs = 0, sourceConsumeMs = 0, completed = false, managedSnapshot, appliedDecision, replyStarted = false
    try {
      const request = normalize(kind, pending)
      if (!request) return
      managedSnapshot = request.managed?.snapshotId
      if (request.managed && (request.managed.instanceId !== instanceId || request.managed.taskId !== s.taskId ||
          request.managed.pid !== process.pid || s.retired || s.broken)) throw new Error("MANAGED_CONTEXT_CHANGED")
      await flush(s)
      if (s.broken || controller.signal.aborted) { reasonCode = s.failureReason ?? "CONTEXT_DELIVERY_FAILED"; return }
      sent = envelope(s, "approval", { approval: request })
      const reviewStart = performance.now(); let firstHash
      for (;;) {
        result = verify(await local("/v1/hooks/review", sent, controller.signal, 95000), sent, request)
        reviewMs = performance.now() - reviewStart
        firstHash ??= result.eventHash
        if (result.eventHash !== firstHash || reviewMs >= result.lifetime) throw new Error("REVIEW_EXPIRED_OR_CHANGED")
        reasonCode = result.decision.reasonCode
        if (result.decision.decision !== "defer" || !TRANSIENT.has(reasonCode)) break
        await new Promise(resolve => setTimeout(resolve, 250))
        controller.signal.throwIfAborted()
      }
      let d = result.decision
      if (d.decision === "defer") {
        if (!request.managed || controller.signal.aborted || s.retired || s.broken) return
        // This explicitly enrolled unattended tool fails closed instead of
        // leaving its private snapshot waiting for a human indefinitely.
        reasonCode = "MANAGED_UNATTENDED_DENY"
        d = { ...d, decision: "deny", source: "policy" }
      }
      appliedDecision = d
      if (d.decision === "allow" && !request.managed) { reasonCode = "UNVERIFIED_AGENT_DATA_ROUTE"; return }
      const consumeStart = performance.now()
      const live = await source(`/${kind}`, { signal: controller.signal })
      const matched = Array.isArray(live) ? live.filter(p => p.id === pending.id && p.sessionID === pending.sessionID) : []
      if (matched.length !== 1 || digest(matched[0]) !== request.originalDigest) throw new Error("PENDING_CHANGED_OR_CONSUMED")
      if (performance.now() - reviewStart >= result.lifetime || controller.signal.aborted) throw new Error("REVIEW_EXPIRED_OR_CHANGED")
      let suffix = "reject", body
      if (kind === "permission") {
        if (d.decision === "allow" && request.managed) {
          await verifyConfigFile(config.managed)
          if (input.directory !== config.managed.root || !verifyManagedPermit(d.permit, config.managed, request.managed,
              { requestHash: d.requestHash, sessionId: pending.sessionID }) ||
              !registerManagedPermit(d.permit, config.managed, request.managed,
                { requestHash: d.requestHash, sessionId: pending.sessionID }, result.lifetime - (performance.now() - reviewStart)))
            throw new Error("INVALID_MANAGED_PERMIT")
          suffix = "reply"; body = { reply: "once" }
        } else {
          if (d.decision !== "deny") throw new Error("INVALID_SELECTION")
          suffix = "reply"; body = { reply: "reject" }
        }
      } else if (d.decision === "select") {
        suffix = "reply"; body = { answers: [[request.choices.find(c => c.id === d.choiceId).label]] }
      }
      // One POST only: a transport failure after it begins is an ambiguous result.
      const path = `/${kind}/${encodeURIComponent(pending.id)}/${suffix}`
      replyStarted = true
      const accepted = await source(path, { body: body ?? {}, signal: controller.signal })
      if (accepted !== true) throw new Error("REPLY_NOT_ACCEPTED")
      const after = await source(`/${kind}`, { signal: controller.signal })
      if (!Array.isArray(after) || after.some(p => p.id === pending.id && p.sessionID === pending.sessionID)) throw new Error("REPLY_NOT_CONSUMED")
      sourceConsumeMs = performance.now() - consumeStart; completed = true
    } catch (error) {
      reasonCode = s.failureReason ?? (REASON.test(error?.message ?? "") ? error.message : "HOOK_REVIEW_UNAVAILABLE")
      if (managedSnapshot && !replyStarted && !controller.signal.aborted && !s.retired && !s.broken) {
        try {
          const request = normalize(kind, pending)
          const live = await source('/permission', { signal: controller.signal })
          const matches = Array.isArray(live) ? live.filter(p => p.id === pending.id && p.sessionID === pending.sessionID) : []
          if (request && matches.length === 1 && digest(matches[0]) === request.originalDigest) {
            revokeManagedPermit(managedSnapshot)
            replyStarted = true
            const tick = performance.now()
            const accepted = await source(`/permission/${encodeURIComponent(pending.id)}/reply`, { body: { reply: 'reject' }, signal: controller.signal })
            const after = await source('/permission', { signal: controller.signal })
            if (accepted === true && Array.isArray(after) && !after.some(p => p.id === pending.id && p.sessionID === pending.sessionID)) {
              completed = true; sourceConsumeMs = performance.now() - tick
              appliedDecision = { decision: 'deny', source: 'policy' }; reasonCode = 'MANAGED_REVIEW_FAILURE_DENY'
            }
          }
        } catch { /* The owned tool remains bounded by its local ask deadline. */ }
      }
    }
    finally {
      job.done = true
      if (!completed && managedSnapshot) revokeManagedPermit(managedSnapshot)
      const request = (() => { try { return normalize(kind, pending) } catch { return undefined } })()
      if (!disposed) queue(s, "status", {
        state: completed ? "approval.completed" : "approval.pending", reasonCode,
        ...(appliedDecision ? { decision: appliedDecision.decision, source: appliedDecision.source } : result ? { decision: result.decision.decision, source: result.decision.source } : {}),
        ...(request ? { originalDigest: request.originalDigest } : {}),
        ...(sent ? { relatedEventId: sent.eventId } : {}),
        metrics: { hookToConsumedMs: performance.now() - started, reviewMs, sourceConsumeMs },
      })
    }
  }
  function runApproval(s, kind, pending) { void approval(s, kind, pending).catch(() => {}) }
  const heartbeat = setInterval(() => {
    for (const s of sessions.values()) if (s.busy) queue(s, "status", { state: "busy" }, "heartbeat")
  }, 30000)
  heartbeat.unref?.()
  return {
    "chat.message": async (info, output) => {
      try {
        const taskId = info.messageID ?? output.message?.id ?? info.sessionID
        closed.delete(info.sessionID)
        const s = state(info.sessionID, taskId)
        if (!s) return
        s.busy = true
        updateControl(info.sessionID, "running")
        const messageId = ID.test(taskId) ? taskId : undefined
        if (messageId) { roles.set(messageId, "user"); messageStates.set(messageId, s) }
        if (roles.size > 512) { const key = roles.keys().next().value; roles.delete(key); messageStates.delete(key) }
        for (const part of output.parts ?? []) if (part.type === "text") {
          const text = clean(part.text)
          if (text) queue(s, "message", { text, role: "user", ...(messageId ? { messageId } : {}), ...(ID.test(part.id ?? "") ? { partId: part.id } : {}) }, `user:${messageId}:${part.id ?? "text"}`)
        }
      } catch { /* Observing a message cannot break the source Agent. */ }
    },
    "tool.execute.before": async (info, output) => {
      try {
        const s = state(info.sessionID)
        if (s && typeof info.callID === "string" && ID.test(info.callID)) {
          callStates.set(`${info.sessionID}\0${info.callID}`, s)
          if (callStates.size > 512) callStates.delete(callStates.keys().next().value)
          queue(s, "tool.before", { tool: clean(info.tool), state: "running", text: inputText(output.args) })
        }
      } catch {}
    },
    "tool.execute.after": async (info, output) => {
      try {
        const key = `${info.sessionID}\0${info.callID}`, owner = callStates.get(key)
        callStates.delete(key)
        if (owner) queue(owner, "tool.after", { tool: clean(info.tool), state: "completed", text: clean(output.output) })
      } catch {}
    },
    event: async ({ event }) => {
      try {
        const p = event.properties ?? {}, sessionId = p.sessionID ?? p.info?.sessionID ?? p.part?.sessionID ?? (event.type.startsWith("session.") ? p.info?.id : undefined)
        // A failed/aborted turn retires its approval context, not the native
        // session. Preserve the old Hook tombstone while projecting genuine
        // source status independently into the control registry.
        if (event.type === "session.deleted") updateControl(sessionId, "closed")
        else if (event.type === "session.status" && controlSessions.has(sessionId)) {
          if (p.status?.type === "idle") updateControl(sessionId, "idle")
          else if (["busy", "retry"].includes(p.status?.type)) updateControl(sessionId, "running")
        }
        const s = state(sessionId)
        if (!s) return
        if (event.type === "permission.asked" || event.type === "question.asked") {
          updateControl(sessionId, "awaiting_input")
          const owner = p.tool?.callID ? callStates.get(`${sessionId}\0${p.tool.callID}`) : s
          if (owner && !owner.retired) runApproval(owner, event.type.startsWith("permission") ? "permission" : "question", p)
        }
        else if (event.type === "permission.replied" || event.type === "question.replied" || event.type === "question.rejected") {
          // A reply may be our own POST. The subsequent GET still verifies consumption.
          queue(s, "status", { state: "approval.replied" })
          updateControl(sessionId, s.busy ? "running" : "idle")
        } else if (event.type === "message.updated" && ID.test(p.info?.id ?? "") && ["user", "assistant"].includes(p.info?.role)) {
          const owner = p.info.role === "user" ? messageStates.get(p.info.id) : p.info.parentID ? messageStates.get(p.info.parentID) : s
          if (owner) { roles.set(p.info.id, p.info.role); messageStates.set(p.info.id, owner) }
          if (roles.size > 512) { const key = roles.keys().next().value; roles.delete(key); messageStates.delete(key) }
        } else if (event.type === "message.part.updated" && p.part?.type === "text" && roles.get(p.part.messageID) === "assistant") {
          const owner = messageStates.get(p.part.messageID)
          if (owner) queue(owner, "message", { text: clean(p.part.text), role: "assistant", messageId: p.part.messageID, partId: p.part.id }, `assistant:${p.part.id}`)
        } else if (event.type === "session.status") {
          s.busy = p.status?.type === "busy" || p.status?.type === "retry"
          updateControl(sessionId, s.busy ? "running" : "idle")
          queue(s, "status", { state: p.status?.type === "idle" ? "idle" : "busy" }, "status")
        } else if (event.type === "session.compacted") {
          cancel(sessionId); clearQueued(s); queue(s, "compacted", { state: "compacted" }); void flush(s); s.broken = true
        } else if (event.type === "session.deleted" || event.type === "session.error") {
          updateControl(sessionId, event.type === "session.deleted" ? "closed" : "error")
          if (!retire(s, false)) { breakScope(s, "HOOK_CLOSE_CAPACITY") }
          rememberClosed(sessionId)
          sessions.delete(sessionId)
        } else if (event.type === "session.created" || event.type === "session.updated") {
          const current = controlSessions.get(sessionId)
          updateControl(sessionId, current?.state ?? "idle", p.info?.title)
        }
      } catch { /* Native event host does not await or catch this Promise. */ }
    },
    dispose: async () => {
      if (disposed) return
      disposed = true
      clearInterval(heartbeat)
      clearTimeout(controlTimer)
      controlController.abort()
      await Promise.allSettled([controlWork])
      for (const job of jobs.values()) job.controller.abort()
      await Promise.allSettled([...sessions.values()].map(async s => {
        clearQueued(s); s.busy = false
        await s.chain
        await observed(s, "closed", { state: "closed" })
      }))
      await Promise.allSettled([...retired].map(s => s.chain))
      agent.destroy(); sessions.clear(); retired.clear(); roles.clear(); messageStates.clear(); callStates.clear(); jobs.clear()
      controlSessions.clear(); controlLedger.clear()
      if (globalThis[contextSymbol] === managedContext) delete globalThis[contextSymbol]
    },
  }
}
