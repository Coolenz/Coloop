/** Managed snapshot reads. No model output or manual UI approval can create a permit. */
import { createHash, createHmac, createPublicKey, randomUUID, verify as verifySignature } from "node:crypto"
import { constants } from "node:fs"
import { lstat, open, readFile } from "node:fs/promises"
import { posix } from "node:path"
import { performance } from "node:perf_hooks"

export const PERMITS = Symbol.for("coloop.managed.permits.v1")
export const CONTEXT = Symbol.for("coloop.managed.context.v1")
export const MAX_FILE_BYTES = 65536
export const MAX_RETURN_BYTES = 4096
const MAX_ASK_MS = 180000
const HASH = /^[a-f0-9]{64}$/
const ID = /^[A-Za-z0-9._:-]{1,128}$/
const EXTENSIONS = new Set([".py", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".c", ".cpp", ".h", ".hpp", ".rs", ".go", ".java", ".css", ".html", ".md", ".json", ".toml", ".yaml", ".yml", ".txt"])
const SENSITIVE_PATH = /(?:^|\/)(?:\.env(?:\.[^/]*)?|\.ssh|\.aws|\.azure|\.git|\.runtime|node_modules|\.venv[^/]*|\.npmrc|\.pypirc|\.netrc|agents\.md|id_rsa|id_ed25519|authorized_keys|known_hosts)(?:\/|$)|(?:secret|credential|password|passwd|private[_-]?key|api[_-]?key|access[_-]?token|cookies|keychain|login data)|(?:^|\/)config\/board\.json$/i
const LITERAL_SECRET = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._~+/-]{8,})|\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@|\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b|(?<!\d)1[3-9]\d{9}(?!\d)|(?<!\d)\d{17}[\dX](?!\d)/i
const ASSIGNMENT_SECRET = /(?:api[_-]?key|password|passwd|access[_-]?token|refresh[_-]?token|authorization|client[_-]?secret|secret|session(?:[_-]?(?:id|key|token))?|cookies?|token|密码|口令)["']?\s*[=:：]\s*["']?[^\s"',;}{]+/i
const SECRET_KEYS = new Set(["apikey", "password", "passwd", "accesstoken", "refreshtoken", "authorization", "clientsecret", "secret", "session", "sessionid", "sessionkey", "sessiontoken", "cookie", "cookies", "token", "privatekey", "credential", "credentials", "authtoken", "密码", "口令"])
const REQUIRED_ENROLLMENT = ["version", "enrollmentId", "root", "routeDigest", "proofKey", "approvalPublicKey", "authorityId", "configPath", "configSha256"]
const PERMIT_FIELDS = ["version", "authorityId", "enrollmentId", "snapshotId", "operation", "sha256", "returnedSha256", "returnedBytes", "truncated", "sessionId", "instanceId", "taskId", "requestHash", "expiresAt", "nonce", "signature"]
const EVIDENCE_FIELDS = ["version", "enrollmentId", "operation", "snapshotId", "sessionId", "messageId", "instanceId", "taskId", "relativePath", "sha256", "bytes", "returnedBytes", "returnedSha256", "truncated", "extension", "routeDigest", "pid", "proof"]
const fail = code => { throw new Error(code) }
export const sha256 = value => createHash("sha256").update(value).digest("hex")
/** Fixed SDK exposes an empty catalog URL when provider.options owns baseURL. */
export function managedRouteChecks({ model, provider, agent }, expected) {
  const sameHeaders = value => {
    try { return canonical(value) === canonical(expected.headers) } catch { return false }
  }
  return {
    agent: agent === expected.agentId,
    modelProvider: model?.providerID === expected.providerId,
    model: (model?.id ?? model?.modelID) === expected.modelId,
    apiModel: model?.api?.id === expected.modelId,
    apiPackage: model?.api?.npm === expected.npm,
    apiURL: model?.api?.url === "" || model?.api?.url === expected.baseURL,
    modelHeaders: sameHeaders(model?.headers),
    provider: provider?.id === expected.providerId,
    baseURL: provider?.options?.baseURL === expected.baseURL,
    providerHeaders: sameHeaders(provider?.options?.headers),
  }
}
export function canonical(value) {
  if (value === null || ["string", "boolean"].includes(typeof value)) return JSON.stringify(value)
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`
  fail("INVALID_CANONICAL_VALUE")
}
const exact = (value, fields) => value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key))
export function validateEnrollment(value) {
  if (!exact(value, REQUIRED_ENROLLMENT) || value.version !== 1 || !ID.test(value.enrollmentId) || !ID.test(value.authorityId) || !HASH.test(value.routeDigest) || !HASH.test(value.proofKey) || !HASH.test(value.configSha256) || typeof value.approvalPublicKey !== "string" || !value.approvalPublicKey.startsWith("-----BEGIN PUBLIC KEY-----") || value.approvalPublicKey.length > 1024) fail("INVALID_MANAGED_ENROLLMENT")
  for (const key of ["root", "configPath"]) if (typeof value[key] !== "string" || value[key] === "/" || !value[key].startsWith("/") || value[key].length > 2048 || posix.normalize(value[key]) !== value[key] || /[\\\x00-\x1f]/.test(value[key])) fail("INVALID_MANAGED_ENROLLMENT")
  return { ...value }
}
export async function loadEnrollment(file) {
  if (!file || typeof file !== "string") fail("MANAGED_ENROLLMENT_REQUIRED")
  const info = await lstat(file)
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) || info.size > 16384) fail("PRIVATE_MANAGED_CONNECTION_REQUIRED")
  const outer = JSON.parse(await readFile(file, "utf8"))
  return validateEnrollment(outer.managed)
}
export async function verifyConfigFile(enrollment) {
  const info = await lstat(enrollment.configPath)
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) || info.size > 32768) fail("PRIVATE_MANAGED_CONFIG_REQUIRED")
  const bytes = await readFile(enrollment.configPath)
  if (sha256(bytes) !== enrollment.configSha256) fail("MANAGED_CONFIG_CHANGED")
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
}
export function normalizedRelativePath(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 1024 || value.startsWith("/") || /[\\\x00-\x1f*?\[\]{}:]/.test(value) || value.split("/").some(part => !part || part === "." || part === "..") || posix.normalize(value) !== value) fail("UNSAFE_MANAGED_PATH")
  if (SENSITIVE_PATH.test(value)) fail("SENSITIVE_MANAGED_PATH")
  if (!EXTENSIONS.has(posix.extname(value).toLowerCase())) fail("UNSUPPORTED_MANAGED_EXTENSION")
  return value
}
/** Linux directory descriptors pin every ancestor; no symlink component is followed. */
export async function readLinuxSnapshot(root, relativePath, { onOpen, onBytes, openFile = open, lstatFile = lstat, platform = process.platform, flags = constants } = {}) {
  if (platform !== "linux") fail("MANAGED_LINUX_REQUIRED")
  if (typeof root !== "string" || root === "/" || !root.startsWith("/") || posix.normalize(root) !== root || /[\\\x00-\x1f]/.test(root)) fail("INVALID_MANAGED_ROOT")
  const handles = []
  try {
    let directory = await openFile("/", flags.O_RDONLY | flags.O_DIRECTORY | flags.O_NOFOLLOW)
    handles.push(directory)
    for (const part of root.split("/").filter(Boolean)) {
      directory = await openFile(`/proc/self/fd/${directory.fd}/${part}`, flags.O_RDONLY | flags.O_DIRECTORY | flags.O_NOFOLLOW)
      handles.push(directory)
    }
    const parts = relativePath.split("/")
    for (const part of parts.slice(0, -1)) {
      directory = await openFile(`/proc/self/fd/${directory.fd}/${part}`, flags.O_RDONLY | flags.O_DIRECTORY | flags.O_NOFOLLOW)
      handles.push(directory)
    }
    const anchored = `/proc/self/fd/${directory.fd}/${parts.at(-1)}`
    const expected = await lstatFile(anchored)
    if (!expected.isFile() || expected.isSymbolicLink() || expected.nlink !== 1 || expected.size < 1 || expected.size > MAX_FILE_BYTES) fail("UNSUPPORTED_MANAGED_FILE")
    const file = await openFile(anchored, flags.O_RDONLY | flags.O_NOFOLLOW | flags.O_NONBLOCK)
    handles.push(file)
    await onOpen?.()
    const before = await file.stat()
    if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > MAX_FILE_BYTES || before.dev !== expected.dev || before.ino !== expected.ino) fail("UNSUPPORTED_MANAGED_FILE")
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1)
    let size = 0
    while (size < buffer.length) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, size)
      if (!bytesRead) break
      size += bytesRead
      await onBytes?.(bytesRead)
    }
    const after = await file.stat()
    if (size !== before.size || size > MAX_FILE_BYTES || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || after.dev !== before.dev || after.ino !== before.ino) fail("MANAGED_FILE_CHANGED")
    return Buffer.from(buffer.subarray(0, size))
  } finally { for (const handle of handles.reverse()) await handle.close().catch(() => {}) }
}
function unescapeForScan(value) {
  return value.replace(/\\+u([a-f0-9]{4})/gi, (_match, hex) => String.fromCharCode(parseInt(hex, 16))).replace(/\\+x([a-f0-9]{2})/gi, (_match, hex) => String.fromCharCode(parseInt(hex, 16)))
}
function representations(value) {
  const values = [value.normalize("NFKC").replace(/\p{Cf}/gu, "")]
  for (let i = 0; i < 2; i++) {
    const next = unescapeForScan(values.at(-1)).normalize("NFKC").replace(/\p{Cf}/gu, "")
    if (next === values.at(-1)) break
    values.push(next)
  }
  return values
}
/** Conservative bounded copies only; original returned bytes are never normalized. */
export function scanManagedText(text) {
  let nodes = 0
  const consume = depth => { if (++nodes > 8192 || depth > 32) fail("MANAGED_SCAN_LIMIT") }
  const present = value => value !== null && value !== "" && !(Array.isArray(value) && value.length === 0) && !(value && typeof value === "object" && !Object.keys(value).length)
  const keySensitive = key => {
    const normalized = representations(key).at(-1).normalize("NFKC").replace(/[\s_\-\p{Cf}\x00-\x1f\x7f]/gu, "").toLowerCase()
    return SECRET_KEYS.has(normalized) || /(?:password|passwd|secret|apikey|accesstoken|refreshtoken|authtoken|sessionid|sessionkey|sessiontoken|privatekey|credentials?|cookies?|token)$/.test(normalized)
  }
  function walk(value, depth, strings) {
    consume(depth)
    if (typeof value === "string") { scan(value, depth + 1, strings - 1); return }
    if (Array.isArray(value)) { for (const child of value) walk(child, depth + 1, strings); return }
    if (value && typeof value === "object") for (const [key, child] of Object.entries(value)) {
      consume(depth + 1)
      if (keySensitive(key) && present(child)) fail("SENSITIVE_MANAGED_CONTENT")
      if (LITERAL_SECRET.test(key)) fail("SENSITIVE_MANAGED_CONTENT")
      walk(child, depth + 1, strings)
    }
  }
  function scan(value, depth, strings) {
    consume(depth)
    for (const view of representations(value)) {
      if (LITERAL_SECRET.test(view)) fail("SENSITIVE_MANAGED_CONTENT")
      let parsed, valid = false
      if (strings >= 0) try { parsed = JSON.parse(view); valid = true } catch {}
      if (valid) walk(parsed, depth + 1, strings)
      else if (ASSIGNMENT_SECRET.test(view)) fail("SENSITIVE_MANAGED_CONTENT")
    }
  }
  scan(text, 0, 2)
}
export function checkedSnapshot(input) {
  const bytes = Buffer.from(input)
  if (!bytes.length || bytes.length > MAX_FILE_BYTES || bytes.includes(0)) fail("UNSUPPORTED_MANAGED_FILE")
  let text
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes) } catch { fail("MANAGED_UTF8_REQUIRED") }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) fail("MANAGED_TEXT_REQUIRED")
  scanManagedText(text)
  let end = Math.min(bytes.length, MAX_RETURN_BYTES)
  while (end > 0 && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--
  const returned = Buffer.from(bytes.subarray(0, end))
  return { text: returned.toString("utf8"), sha256: sha256(bytes), bytes: bytes.length, returnedSha256: sha256(returned), returnedBytes: returned.length, truncated: returned.length !== bytes.length }
}
const SNAPSHOT_OUTPUT_FIELDS = ["path", "sha256", "bytes", "returnedSha256", "returnedBytes", "truncated", "text"]
const TRUNCATION_NOTE = "Only the initial UTF-8 fragment is returned; remaining bytes were omitted."
function approvedModelText(message, part) {
  try {
    if (message?.info?.role !== "assistant" || message.info.error || part?.type !== "tool" || part.tool !== "coloop_read" || part.state?.status !== "completed" || part.state.time?.compacted || part.state.attachments?.length) return undefined
    const state = part.state, meta = state.metadata?.coloop
    if (!meta || meta.version !== 1 || meta.operation !== "read" || meta.stage !== "released" || meta.releaseCount !== 1 || meta.permitVerified !== true || meta.routeVerified !== true || meta.scanOpenCount !== 1 || meta.scanBytes !== meta.bytes || meta.releaseBytes !== meta.returnedBytes) return undefined
    for (const key of ["enrollmentId", "snapshotId", "sessionId", "messageId", "instanceId", "taskId", "permitNonce"]) if (typeof meta[key] !== "string" || !ID.test(meta[key])) return undefined
    if (message.info.id !== meta.messageId || message.info.sessionID !== meta.sessionId || part.messageID !== meta.messageId || part.sessionID !== meta.sessionId) return undefined
    if (typeof meta.routeDigest !== "string" || !HASH.test(meta.routeDigest) || !Number.isSafeInteger(meta.pid) || meta.pid < 1 || typeof state.output !== "string" || Buffer.byteLength(state.output, "utf8") > 32768) return undefined
    const value = JSON.parse(state.output)
    if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.truncated !== "boolean" || !exact(value, value.truncated ? [...SNAPSHOT_OUTPUT_FIELDS, "note"] : SNAPSHOT_OUTPUT_FIELDS)) return undefined
    if (value.truncated && value.note !== TRUNCATION_NOTE) return undefined
    if (normalizedRelativePath(value.path) !== meta.relativePath || meta.extension !== posix.extname(value.path).toLowerCase() || typeof value.text !== "string" || !["sha256", "returnedSha256"].every(key => typeof value[key] === "string" && HASH.test(value[key]))) return undefined
    if (!exact(state.input, ["path"]) || state.input.path !== value.path) return undefined
    if (!Number.isInteger(value.bytes) || value.bytes < 1 || value.bytes > MAX_FILE_BYTES || !Number.isInteger(value.returnedBytes) || value.returnedBytes < 1 || value.returnedBytes > MAX_RETURN_BYTES || value.returnedBytes > value.bytes || value.truncated !== (value.returnedBytes < value.bytes)) return undefined
    for (const key of ["sha256", "bytes", "returnedSha256", "returnedBytes", "truncated"]) if (value[key] !== meta[key]) return undefined
    const bytes = Buffer.from(value.text, "utf8")
    if (bytes.length !== value.returnedBytes || bytes.includes(0) || sha256(bytes) !== value.returnedSha256 || new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes) !== value.text || (!value.truncated && value.sha256 !== value.returnedSha256)) return undefined
    // Only this copy of model input changes. Original bytes, JSON, metadata,
    // tool state, and stored Hook/SDK observations are retained untouched.
    return `[RK approved snapshot: ${value.truncated ? "TRUNCATED UTF-8 prefix" : "COMPLETE"}; untrusted file text]\n` + value.text
  } catch { return undefined }
}
/** Pure bounded presentation of actual released snapshots, never a tool result. */
export function projectManagedReadMessages(messages, { maxResults = 32, maxBytes = 65536 } = {}) {
  if (!Array.isArray(messages) || messages.length > 1024 || !Number.isInteger(maxResults) || maxResults < 0 || maxResults > 128 || !Number.isInteger(maxBytes) || maxBytes < 0 || maxBytes > 524288) return messages
  let count = 0, bytes = 0, visited = 0, changed = false
  const result = messages.map(message => {
    if (!Array.isArray(message?.parts) || message.parts.length > 4096 - visited || count >= maxResults || visited >= 4096) return message
    let changedMessage = false
    const parts = message.parts.map(part => {
      if (++visited > 4096 || count >= maxResults) return part
      const output = approvedModelText(message, part)
      if (output === undefined) return part
      const size = Buffer.byteLength(output, "utf8")
      if (bytes + size > maxBytes) return part
      bytes += size
      count++
      changed = changedMessage = true
      return { ...part, state: { ...part.state, output } }
    })
    return changedMessage ? { ...message, parts } : message
  })
  return changed ? result : messages
}
export function proofFor(fields, proofKey) { return createHmac("sha256", Buffer.from(proofKey, "hex")).update(canonical(fields)).digest("hex") }
export function isManagedEvidence(value) {
  if (!exact(value, EVIDENCE_FIELDS) || value.version !== 1 || value.operation !== "read" || !["enrollmentId", "snapshotId", "sessionId", "messageId", "instanceId", "taskId"].every(key => typeof value[key] === "string" && ID.test(value[key])) || !["sha256", "returnedSha256", "routeDigest", "proof"].every(key => typeof value[key] === "string" && HASH.test(value[key])) || !Number.isSafeInteger(value.pid) || value.pid < 1 || value.pid > 2147483647 || !Number.isInteger(value.bytes) || value.bytes < 1 || value.bytes > MAX_FILE_BYTES || !Number.isInteger(value.returnedBytes) || value.returnedBytes < 1 || value.returnedBytes > MAX_RETURN_BYTES || value.returnedBytes > value.bytes || typeof value.truncated !== "boolean" || value.truncated !== (value.returnedBytes < value.bytes)) return false
  try { normalizedRelativePath(value.relativePath) } catch { return false }
  return value.extension === posix.extname(value.relativePath).toLowerCase() && (value.truncated || value.sha256 === value.returnedSha256)
}
/** Returns false for any malformed or mismatched signed permit. Does not trust wall clocks. */
export function verifyManagedPermit(permit, managedConfig, evidence, binding) {
  try {
    if (!isManagedEvidence(evidence) || !exact(permit, PERMIT_FIELDS) || permit.version !== 1 || permit.authorityId !== managedConfig.authorityId || permit.enrollmentId !== managedConfig.enrollmentId || evidence.enrollmentId !== managedConfig.enrollmentId || evidence.routeDigest !== managedConfig.routeDigest || !HASH.test(permit.requestHash) || permit.requestHash !== binding.requestHash || permit.sessionId !== binding.sessionId || !ID.test(permit.nonce) || !Number.isFinite(Date.parse(permit.expiresAt)) || typeof permit.signature !== "string" || !/^[A-Za-z0-9+/]{86}==$/.test(permit.signature)) return false
    for (const key of ["snapshotId", "operation", "sha256", "returnedSha256", "returnedBytes", "truncated", "sessionId", "instanceId", "taskId"]) if (permit[key] !== evidence[key]) return false
    const { signature, ...fields } = permit
    const raw = Buffer.from(signature, "base64"), key = createPublicKey(managedConfig.approvalPublicKey)
    return raw.length === 64 && raw.toString("base64") === signature && key.asymmetricKeyType === "ed25519" && verifySignature(null, Buffer.from(canonical(fields)), key, raw)
  } catch { return false }
}
export function registerManagedPermit(permit, managedConfig, evidence, binding, validForMs) {
  if (!Number.isFinite(validForMs) || validForMs <= 0 || validForMs > MAX_ASK_MS || !verifyManagedPermit(permit, managedConfig, evidence, binding)) return false
  if (!(globalThis[PERMITS] instanceof Map)) globalThis[PERMITS] = new Map()
  const map = globalThis[PERMITS]
  const now = performance.now()
  for (const [key, entry] of map) if (!entry || now - entry.registeredAt >= entry.validForMs) map.delete(key)
  if (map.size >= 128 || map.has(evidence.snapshotId)) return false
  map.set(evidence.snapshotId, { permit: structuredClone(permit), registeredAt: now, validForMs })
  return true
}
export function revokeManagedPermit(snapshotId) { globalThis[PERMITS]?.delete?.(snapshotId) }
function consumePermitReceipt(snapshot, enrollment, registry, now, askedAt) {
  const entry = registry instanceof Map ? registry.get(snapshot.snapshotId) : undefined
  registry?.delete?.(snapshot.snapshotId)
  const checkedAt = now()
  if (!entry || !Number.isFinite(checkedAt) || !Number.isFinite(askedAt) || !Number.isFinite(entry.registeredAt) || !Number.isFinite(entry.validForMs) || entry.validForMs <= 0 || entry.validForMs > MAX_ASK_MS || checkedAt < entry.registeredAt || checkedAt - entry.registeredAt >= entry.validForMs || checkedAt < askedAt || checkedAt - askedAt >= MAX_ASK_MS) fail("RK_PERMIT_REQUIRED")
  const permit = entry.permit
  if (!verifyManagedPermit(permit, enrollment, snapshot, { requestHash: permit.requestHash, sessionId: snapshot.sessionId })) fail("INVALID_RK_PERMIT")
  return { permit, registeredAt: entry.registeredAt, deadline: Math.min(entry.registeredAt + entry.validForMs, askedAt + MAX_ASK_MS) }
}
export function consumePermit(snapshot, enrollment, registry, now, askedAt) { return consumePermitReceipt(snapshot, enrollment, registry, now, askedAt).permit }
function verifyPermitDeadline(receipt, now) {
  const checkedAt = now()
  if (!Number.isFinite(checkedAt) || checkedAt < receipt.registeredAt || checkedAt >= receipt.deadline) fail("RK_PERMIT_EXPIRED")
}
export function createManagedReadTool({ enrollment: initial, loadCurrent, guard, reader = readLinuxSnapshot, registry = () => globalThis[PERMITS], now = () => performance.now(), uuid = randomUUID, askTimeoutMs = MAX_ASK_MS, pid = process.pid, getBinding = info => globalThis[CONTEXT]?.(info), bindingTimeoutMs = 500, onProgress = async () => {}, onCommit }) {
  const enrollment = validateEnrollment(initial)
  const original = canonical(enrollment)
  const verifyCurrent = async () => {
    if (canonical(validateEnrollment(await loadCurrent())) !== original) fail("MANAGED_ENROLLMENT_CHANGED")
    await guard()
  }
  return {
    description: "Read one project text file after RK approval. Relative POSIX path only. Returns an approved immutable snapshot, at most 4096 UTF-8 bytes, with explicit truncation.",
    // Fixed 1.19.5 registry supports legacy JSON Schema args. No runtime SDK import is needed.
    args: { path: { type: "string", minLength: 1, maxLength: 1024, description: "Exact relative project file path, for example src/main.py" } },
    async execute(args, context) {
      const attemptId = uuid(), started = now()
      const progress = { scanOpenCount: 0, scanBytes: 0, releaseCount: 0, releaseBytes: 0, stage: "blocked", routeVerified: false, permitVerified: false }
      const identity = { version: 1, enrollmentId: enrollment.enrollmentId, pid, attemptId,
        ...(ID.test(context?.sessionID ?? "") ? { sessionId: context.sessionID } : {}),
        ...(ID.test(context?.messageID ?? "") ? { messageId: context.messageID } : {}),
        ...(ID.test(context?.callID ?? "") ? { callId: context.callID } : {}) }
      let timeout, abort, metadata, binding
      const report = async () => {
        const value = { ...identity, ...progress, ...(binding ?? {}), elapsedMs: Math.max(0, now() - started) }
        // The fixed SDK can expose a lazy Effect here. The private progress
        // ledger supplied by the entry remains authoritative for intermediate
        // failures; the final ToolResult also preserves these exact counters.
        try {
          const result = context?.metadata?.({ metadata: { coloop: value } })
          if (result && typeof result.then === "function") await result
        } catch {}
        await onProgress(value)
      }
      const bindingForCall = () => {
        const value = getBinding({ sessionId: context.sessionID, messageId: context.messageID })
        return value && ID.test(value.instanceId ?? "") && ID.test(value.taskId ?? "") ? { instanceId: value.instanceId, taskId: value.taskId } : undefined
      }
      const current = async () => {
        progress.routeVerified = false
        await verifyCurrent()
        if (canonical(bindingForCall() ?? null) !== canonical(binding)) fail("MANAGED_CONTEXT_CHANGED")
        progress.routeVerified = true
      }
      try {
        await report()
        if (!exact(args, ["path"]) || !context || !ID.test(context.sessionID) || !ID.test(context.messageID) || typeof context.ask !== "function") fail("INVALID_MANAGED_READ")
        const relativePath = normalizedRelativePath(args.path)
        const bindingStarted = performance.now()
        while (!(binding = bindingForCall())) {
          context.abort?.throwIfAborted()
          if (performance.now() - bindingStarted >= Math.min(500, bindingTimeoutMs)) fail("MANAGED_CONTEXT_REQUIRED")
          await new Promise(resolve => setTimeout(resolve, 10))
        }
        await current()
        progress.stage = "route_checked"
        await report()
        // Worktree can be '/' for a non-Git project; authority is always root.
        if (context.directory !== enrollment.root) fail("MANAGED_WORKSPACE_MISMATCH")
        context.abort?.throwIfAborted()
        progress.stage = "scanning"
        await report()
        const snapshot = checkedSnapshot(await reader(enrollment.root, relativePath, {
          onOpen: async () => { progress.scanOpenCount++; await report() },
          onBytes: async count => { progress.scanBytes += count; await report() },
        }))
        context.abort?.throwIfAborted()
        await current()
        const fields = { version: 1, enrollmentId: enrollment.enrollmentId, operation: "read", snapshotId: attemptId, sessionId: context.sessionID, messageId: context.messageID, ...binding, relativePath, sha256: snapshot.sha256, bytes: snapshot.bytes, returnedBytes: snapshot.returnedBytes, returnedSha256: snapshot.returnedSha256, truncated: snapshot.truncated, extension: posix.extname(relativePath).toLowerCase(), routeDigest: enrollment.routeDigest, pid }
        metadata = Object.freeze({ ...fields, proof: proofFor(fields, enrollment.proofKey) })
        progress.stage = "awaiting_rk"
        await report()
        await current()
        const askedAt = now()
        const interrupted = new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error("MANAGED_APPROVAL_TIMEOUT")), askTimeoutMs)
          abort = () => reject(new Error("MANAGED_READ_ABORTED"))
          context.abort?.addEventListener("abort", abort, { once: true })
        })
        await Promise.race([context.ask({ permission: "coloop_read", patterns: [posix.join(enrollment.root, relativePath)], always: [], metadata: { coloop: metadata } }), interrupted])
        context.abort?.throwIfAborted()
        await current()
        const receipt = consumePermitReceipt(metadata, enrollment, registry(), now, askedAt)
        const { permit } = receipt
        progress.permitVerified = true
        // This observer may yield or even invalidate task/config state. It is
        // not a release: retain zero counters until after the final guard.
        await report()
        await current()
        context.abort?.throwIfAborted()
        if (canonical(bindingForCall() ?? null) !== canonical(binding)) fail("MANAGED_CONTEXT_CHANGED")
        verifyPermitDeadline(receipt, now)
        progress.releaseCount = 1
        progress.releaseBytes = snapshot.returnedBytes
        progress.stage = "released"
        // The entry commits its small private ledger synchronously; no await
        // or arbitrary asynchronous callback exists between here and return.
        const committed = onCommit?.({ ...identity, ...progress, ...binding, elapsedMs: Math.max(0, now() - started) })
        if (committed && typeof committed.then === "function") fail("ASYNC_MANAGED_COMMIT_FORBIDDEN")
        context.abort?.throwIfAborted()
        if (canonical(bindingForCall() ?? null) !== canonical(binding)) fail("MANAGED_CONTEXT_CHANGED")
        verifyPermitDeadline(receipt, now)
        return {
          title: "RK approved snapshot read",
          output: JSON.stringify({ path: relativePath, sha256: snapshot.sha256, bytes: snapshot.bytes, returnedSha256: snapshot.returnedSha256, returnedBytes: snapshot.returnedBytes, truncated: snapshot.truncated, text: snapshot.text, ...(snapshot.truncated ? { note: "Only the initial UTF-8 fragment is returned; remaining bytes were omitted." } : {}) }),
          metadata: { coloop: { ...fields, permitNonce: permit.nonce, ...progress, progressTransport: "private-ledger" } },
        }
      } catch (error) {
        progress.releaseCount = 0
        progress.releaseBytes = 0
        progress.stage = "blocked"
        progress.reasonCode = /^[A-Z][A-Z0-9_]{0,79}$/.test(error?.message ?? "") ? error.message : "MANAGED_READ_FAILED"
        try { await report() } catch {}
        throw error
      } finally {
        clearTimeout(timeout)
        if (abort) context?.abort?.removeEventListener("abort", abort)
        registry()?.delete?.(metadata?.snapshotId ?? attemptId)
      }
    },
  }
}
