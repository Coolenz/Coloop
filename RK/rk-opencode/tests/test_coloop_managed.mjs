import assert from "node:assert/strict"
import { generateKeyPairSync, sign } from "node:crypto"
import { performance } from "node:perf_hooks"
import test from "node:test"
import {
  PERMITS, canonical, checkedSnapshot, consumePermit, createManagedReadTool,
  isManagedEvidence, managedRouteChecks, normalizedRelativePath, proofFor, readLinuxSnapshot, registerManagedPermit,
  revokeManagedPermit, sha256, validateEnrollment, verifyManagedPermit,
} from "../agent/coloop_managed_core.mjs"

const keys = generateKeyPairSync("ed25519")
const enrollment = {
  version: 1, enrollmentId: "enrollment-test", root: "/project", routeDigest: "1".repeat(64),
  proofKey: "2".repeat(64), authorityId: "authority-test",
  approvalPublicKey: keys.publicKey.export({ type: "spki", format: "pem" }),
  configPath: "/app/.runtime/coloop-managed/config.json", configSha256: "3".repeat(64),
}
test("fixed SDK empty catalog URL retains the configured private route and rejects overrides", () => {
  const expected = { agentId: "rk-coloop-managed", providerId: "rkllm", modelId: "qwen35-4b-rkllm", npm: "@ai-sdk/openai-compatible", baseURL: "http://127.0.0.1:8088/v1", headers: { "X-RK-Privacy": "metadata-only", "X-RK-Cache": "off" } }
  const source = { agent: expected.agentId, model: { id: expected.modelId, providerID: expected.providerId, api: { id: expected.modelId, npm: expected.npm, url: "" }, headers: expected.headers }, provider: { id: expected.providerId, options: { baseURL: expected.baseURL, headers: expected.headers } } }
  const safe = value => Object.values(managedRouteChecks(value, expected)).every(Boolean)
  assert.equal(safe(source), true)
  const explicit = structuredClone(source)
  explicit.model.api.url = expected.baseURL
  assert.equal(safe(explicit), true)
  for (const mutate of [
    v => { v.provider.options.baseURL = "https://cloud.example/v1" },
    v => { v.model.api.url = "https://cloud.example/v1" },
    v => { v.model.api.id = "different-api-model" },
    v => { v.model.api.npm = "@ai-sdk/openai" },
    v => { v.provider.options.headers["X-RK-Privacy"] = "raw" },
    v => { v.model.headers["X-RK-Privacy"] = "raw" },
    v => { delete v.provider.options.baseURL },
    v => { delete v.model.api.url },
  ]) {
    const changed = structuredClone(source)
    mutate(changed)
    assert.equal(safe(changed), false)
  }
})
function signed(evidence, changes = {}) {
  const fields = {
    version: 1, authorityId: enrollment.authorityId, enrollmentId: enrollment.enrollmentId,
    snapshotId: evidence.snapshotId, operation: "read", sha256: evidence.sha256,
    returnedSha256: evidence.returnedSha256, returnedBytes: evidence.returnedBytes,
    truncated: evidence.truncated, sessionId: evidence.sessionId, instanceId: evidence.instanceId, taskId: evidence.taskId, requestHash: "4".repeat(64),
    expiresAt: "2027-01-01T00:00:00.000Z", nonce: "nonce-test", ...changes,
  }
  return { ...fields, signature: sign(null, Buffer.from(canonical(fields)), keys.privateKey).toString("base64") }
}
function fixture(options = {}) {
  globalThis[PERMITS] = new Map()
  let current = structuredClone(enrollment), guarded = 0, asked = 0
  let binding = { instanceId: "instance_test", taskId: "task_test" }
  const body = Buffer.from(options.text ?? "print('VERIFICATION_TOKEN_017392')\n")
  const controller = new AbortController()
  const context = {
    sessionID: "ses_test", messageID: "msg_test", agent: "rk-coloop-managed", directory: "/project",
    // A non-Git OpenCode project reports '/' here; it cannot broaden the tool root.
    worktree: "/", abort: controller.signal,
    ask: async request => {
      asked++
      assert.equal(request.permission, "coloop_read")
      assert.deepEqual(request.always, [])
      assert.deepEqual(request.patterns, ["/project/src/main.py"])
      const evidence = request.metadata.coloop
      assert.equal(isManagedEvidence(evidence), true)
      const { proof, ...fields } = evidence
      assert.equal(proof, proofFor(fields, enrollment.proofKey))
      if (options.ask) return options.ask({ request, evidence, current, controller, body })
      const permit = signed(evidence)
      assert.equal(registerManagedPermit(permit, enrollment, evidence, { requestHash: permit.requestHash, sessionId: context.sessionID }, 180000), true)
    },
  }
  const tool = createManagedReadTool({ enrollment, loadCurrent: async () => current,
    guard: async () => { guarded++ }, reader: async () => body, getBinding: () => binding, ...options.factory })
  return { tool, context, body, controller, change: value => { current = value },
    changeBinding: value => { binding = value },
    counts: () => ({ asked, guarded }) }
}

test("signed real permit releases exactly the frozen bytes and full output evidence", async () => {
  const f = fixture()
  const result = await f.tool.execute({ path: "src/main.py" }, f.context)
  const output = JSON.parse(result.output)
  assert.equal(output.text, f.body.toString())
  assert.equal(output.sha256, sha256(f.body))
  assert.equal(result.metadata.coloop.returnedSha256, sha256(Buffer.from(output.text)))
  assert.equal(result.metadata.coloop.truncated, false)
  assert.deepEqual(f.counts(), { asked: 1, guarded: 5 })
  assert.equal(globalThis[PERMITS].size, 0)
  assert.equal(result.output.includes(enrollment.proofKey), false)
  assert.equal(result.output.includes("BEGIN PUBLIC KEY"), false)
})
test("manual once without a signed RK permit returns no file body", async () => {
  const f = fixture({ ask: async () => {} })
  await assert.rejects(f.tool.execute({ path: "src/main.py" }, f.context), /RK_PERMIT_REQUIRED/)
})
test("deny and abort never release a snapshot", async () => {
  const denied = fixture({ ask: async () => { throw new Error("Permission rejected") } })
  await assert.rejects(denied.tool.execute({ path: "src/main.py" }, denied.context), /Permission rejected/)
  const aborted = fixture({ ask: async ({ controller }) => { controller.abort() } })
  await assert.rejects(aborted.tool.execute({ path: "src/main.py" }, aborted.context))
  assert.equal(globalThis[PERMITS].size, 0)
})
test("timeout is bounded and does not need an ask promise to resolve", async () => {
  const f = fixture({ ask: () => new Promise(() => {}), factory: { askTimeoutMs: 20 } })
  await assert.rejects(f.tool.execute({ path: "src/main.py" }, f.context), /MANAGED_APPROVAL_TIMEOUT/)
  assert.equal(globalThis[PERMITS].size, 0)
})
test("changing the source bytes during approval cannot change returned snapshot", async () => {
  const old = "original immutable text"
  const f = fixture({ text: old, ask: async ({ body, evidence }) => {
    body.fill(0x78)
    const permit = signed(evidence)
    assert.equal(registerManagedPermit(permit, enrollment, evidence, { requestHash: permit.requestHash, sessionId: evidence.sessionId }, 180000), true)
  } })
  const result = JSON.parse((await f.tool.execute({ path: "src/main.py" }, f.context)).output)
  assert.equal(result.text, old)
  assert.equal(result.sha256, sha256(Buffer.from(old)))
})
test("enrollment or guard changes during approval invalidate the reply", async () => {
  const f = fixture({ ask: async ({ evidence }) => {
    const permit = signed(evidence)
    registerManagedPermit(permit, enrollment, evidence, { requestHash: permit.requestHash, sessionId: evidence.sessionId }, 180000)
    f.change({ ...enrollment, routeDigest: "5".repeat(64) })
  } })
  await assert.rejects(f.tool.execute({ path: "src/main.py" }, f.context), /MANAGED_ENROLLMENT_CHANGED/)
  assert.equal(globalThis[PERMITS].size, 0)
})
test("full file is scanned while UTF-8 partial body is bound independently", () => {
  const input = Buffer.from("中".repeat(2000))
  const value = checkedSnapshot(input)
  assert.equal(value.bytes, 6000)
  assert.equal(value.returnedBytes, 4095)
  assert.equal(value.truncated, true)
  assert.equal(value.sha256, sha256(input))
  assert.equal(value.returnedSha256, sha256(Buffer.from(value.text)))
  assert.equal(value.text.includes("�"), false)
  assert.throws(() => checkedSnapshot(Buffer.from("x".repeat(5000) + '\n"password":"hidden"')), /SENSITIVE_MANAGED_CONTENT/)
})
test("sensitive paths, traversal, binary, malformed UTF-8 and oversized files fail before ask", async () => {
  for (const path of ["../out.py", "/etc/passwd", "src//a.py", "src/./a.py", "src\\a.py", ".ssh/key.txt", "AGENTS.md", "config/board.json", ".runtime/test.json", "a.exe", "secret.txt"]) assert.throws(() => normalizedRelativePath(path))
  for (const data of [Buffer.alloc(0), Buffer.from([0]), Buffer.from([1, 2, 3]), Buffer.from([0xff]), Buffer.alloc(65537, 0x61), Buffer.from("api_key=unshared-value")]) assert.throws(() => checkedSnapshot(data))
  const f = fixture({ text: "Bearer syntheticsecret" })
  await assert.rejects(f.tool.execute({ path: "src/main.py" }, f.context), /SENSITIVE_MANAGED_CONTENT/)
  assert.equal(f.counts().asked, 0)
})
test("different workspace and malformed tool arguments fail before ask", async () => {
  const f = fixture()
  await assert.rejects(f.tool.execute({ path: "src/main.py", command: "bad" }, f.context), /INVALID_MANAGED_READ/)
  await assert.rejects(f.tool.execute({ path: "src/main.py" }, { ...f.context, directory: "/outside" }), /MANAGED_WORKSPACE_MISMATCH/)
  assert.equal(f.counts().asked, 0)
})
test("permit validates every binding field and rejects unsigned or changed payloads", async () => {
  let evidence
  const f = fixture({ ask: async value => { evidence = value.evidence } })
  await assert.rejects(f.tool.execute({ path: "src/main.py" }, f.context))
  const permit = signed(evidence), binding = { requestHash: permit.requestHash, sessionId: evidence.sessionId }
  assert.equal(verifyManagedPermit(permit, enrollment, evidence, binding), true)
  for (const [key, value] of [["sha256", "9".repeat(64)], ["returnedSha256", "9".repeat(64)], ["returnedBytes", 1], ["truncated", true], ["sessionId", "other"], ["instanceId", "other"], ["taskId", "other"], ["enrollmentId", "other"], ["authorityId", "other"], ["requestHash", "9".repeat(64)], ["signature", "A".repeat(86) + "=="]]) assert.equal(verifyManagedPermit({ ...permit, [key]: value }, enrollment, evidence, binding), false)
  assert.equal(verifyManagedPermit({ ...permit, extra: true }, enrollment, evidence, binding), false)
})
test("registry is single-use and rejects expired monotonic receipts", async () => {
  let evidence
  const f = fixture({ ask: async value => { evidence = value.evidence } })
  await assert.rejects(f.tool.execute({ path: "src/main.py" }, f.context))
  const permit = signed(evidence), binding = { requestHash: permit.requestHash, sessionId: evidence.sessionId }
  assert.equal(registerManagedPermit(permit, enrollment, evidence, binding, 10), true)
  assert.equal(registerManagedPermit(permit, enrollment, evidence, binding, 10), false)
  const map = globalThis[PERMITS]
  map.get(evidence.snapshotId).registeredAt = performance.now() - 20
  assert.throws(() => consumePermit(evidence, enrollment, map, () => performance.now(), performance.now() - 10), /RK_PERMIT_REQUIRED/)
  assert.equal(map.size, 0)
  assert.equal(registerManagedPermit(permit, enrollment, evidence, binding, 180001), false)
  revokeManagedPermit(evidence.snapshotId)
})
test("enrollment shape is narrow and public key/proof key never become tool arguments", () => {
  assert.deepEqual(validateEnrollment(enrollment), enrollment)
  assert.throws(() => validateEnrollment({ ...enrollment, externalRoute: "https://example.com" }))
  assert.throws(() => validateEnrollment({ ...enrollment, root: "/project/../outside" }))
  assert.deepEqual(Object.keys(fixture().tool.args), ["path"])
})
test("Unicode escaped, double escaped and nested JSON credential keys are rejected", () => {
  for (const text of [
    String.raw`{"pass\u0077ord":"CANARY"}`,
    String.raw`{"pass\\u0077ord":"CANARY"}`,
    String.raw`{"pass\u005cu0077ord":"CANARY"}`,
    JSON.stringify({ outer: JSON.stringify({ "pass\\u0077ord": "CANARY" }) }),
    JSON.stringify({ outer: { session_token: "CANARY" } }),
    JSON.stringify({ outer: [{ cookies: ["CANARY"] }] }),
    String.raw`const config={"pass\u0077ord":"CANARY"}`,
    JSON.stringify({ db_password: "CANARY" }),
  ]) assert.throws(() => checkedSnapshot(Buffer.from(text)), /SENSITIVE_MANAGED_CONTENT/)
})
test("empty JSON credentials are distinct from numeric, boolean and nonempty secrets", () => {
  for (const value of ["", null, [], {}]) assert.doesNotThrow(() => checkedSnapshot(Buffer.from(JSON.stringify({ password: value }))))
  for (const value of [0, 123, false, true, " ", ["CANARY"], { value: "CANARY" }]) assert.throws(() => checkedSnapshot(Buffer.from(JSON.stringify({ password: value }))), /SENSITIVE_MANAGED_CONTENT/)
  assert.doesNotThrow(() => checkedSnapshot(Buffer.from(JSON.stringify({ keynote: "public", token_count: 42, session_timeout: 120, api_key_length: 32 }))))
})
test("DLP normalization is scan-only and never rewrites original returned bytes", async () => {
  const text = String.raw`{"keynote":"Hello\u0020world"}`
  const f = fixture({ text })
  const output = JSON.parse((await f.tool.execute({ path: "src/main.py" }, f.context)).output)
  assert.equal(output.text, text)
  assert.equal(output.sha256, sha256(Buffer.from(text)))
  assert.equal(output.returnedSha256, output.sha256)
  const blocked = fixture({ text: String.raw`{"pass\\u0077ord":"CANARY"}` })
  await assert.rejects(blocked.tool.execute({ path: "src/main.py" }, blocked.context), /SENSITIVE_MANAGED_CONTENT/)
  assert.equal(blocked.counts().asked, 0)
})
test("scan node and depth budgets fail closed", () => {
  assert.throws(() => checkedSnapshot(Buffer.from("[".repeat(40) + "0" + "]".repeat(40))), /MANAGED_SCAN_LIMIT/)
  assert.throws(() => checkedSnapshot(Buffer.from(JSON.stringify(Array(9000).fill(0)))), /MANAGED_SCAN_LIMIT/)
})
test("missing true source binding never scans or requests approval", async () => {
  let reads = 0
  const f = fixture({ factory: { getBinding: () => undefined, bindingTimeoutMs: 20, reader: async () => { reads++; return Buffer.from("text") } } })
  await assert.rejects(f.tool.execute({ path: "src/main.py" }, f.context), /MANAGED_CONTEXT_REQUIRED/)
  assert.equal(reads, 0)
  assert.equal(f.counts().asked, 0)
})
test("task changes during a read or after signed approval never release the old snapshot", async () => {
  const reading = fixture({ factory: { reader: async () => {
    reading.changeBinding({ instanceId: "instance_test", taskId: "new_task" })
    return Buffer.from("text")
  } } })
  await assert.rejects(reading.tool.execute({ path: "src/main.py" }, reading.context), /MANAGED_CONTEXT_CHANGED/)
  assert.equal(reading.counts().asked, 0)
  const approving = fixture({ ask: async ({ evidence }) => {
    const permit = signed(evidence)
    registerManagedPermit(permit, enrollment, evidence, { requestHash: permit.requestHash, sessionId: evidence.sessionId }, 180000)
    approving.changeBinding({ instanceId: "instance_test", taskId: "new_task" })
  } })
  await assert.rejects(approving.tool.execute({ path: "src/main.py" }, approving.context), /MANAGED_CONTEXT_CHANGED/)
  assert.equal(globalThis[PERMITS].size, 0)
})
test("instrumented reader counters come only from callbacks and contain no file text", async () => {
  const records = [], bytes = Buffer.from("SAFE_VERIFICATION_BODY")
  const f = fixture({ factory: {
    reader: async (_root, _path, observer) => { await observer.onOpen(); await observer.onBytes(5); await observer.onBytes(bytes.length - 5); return bytes },
    onProgress: async value => records.push(structuredClone(value)),
    onCommit: value => records.push(structuredClone(value)),
  } })
  const result = await f.tool.execute({ path: "src/main.py" }, f.context)
  assert.equal(result.metadata.coloop.scanOpenCount, 1)
  assert.equal(result.metadata.coloop.scanBytes, bytes.length)
  assert.equal(result.metadata.coloop.releaseCount, 1)
  assert.equal(result.metadata.coloop.releaseBytes, bytes.length)
  assert.equal(result.metadata.coloop.stage, "released")
  assert.equal(result.metadata.coloop.permitVerified, true)
  assert.equal(records.at(-1).stage, "released")
  assert.equal(JSON.stringify(records).includes(bytes.toString()), false)
  assert.equal(JSON.stringify(records).includes(enrollment.proofKey), false)
})
test("plain assignment scanning normalizes fullwidth and invisible copies only", () => {
  for (const text of ["pass\u200bword='CANARY'", "ｐａｓｓｗｏｒｄ='CANARY'", String.raw`pass\u200bword='CANARY'`, String.raw`\uFF50\uFF41\uFF53\uFF53\uFF57\uFF4F\uFF52\uFF44='CANARY'`]) assert.throws(() => checkedSnapshot(Buffer.from(text)), /SENSITIVE_MANAGED_CONTENT/)
  const original = "keynote='ＡＢＣ'"
  const result = checkedSnapshot(Buffer.from(original))
  assert.equal(result.text, original)
  assert.equal(result.sha256, sha256(Buffer.from(original)))
})
test("an awaited progress observer cannot release after task or enrollment change", async () => {
  for (const mode of ["task", "config"]) {
    const records = []
    const f = fixture({ factory: { onProgress: async value => {
      records.push(structuredClone(value))
      if (value.permitVerified && !value.releaseCount) {
        await Promise.resolve()
        if (mode === "task") f.changeBinding({ instanceId: "instance_test", taskId: "new_task" })
        else f.change({ ...enrollment, routeDigest: "8".repeat(64) })
      }
    } } })
    await assert.rejects(f.tool.execute({ path: "src/main.py" }, f.context), /MANAGED_(?:CONTEXT|ENROLLMENT)_CHANGED/)
    assert.equal(records.at(-1).stage, "blocked")
    assert.equal(records.at(-1).releaseCount, 0)
    assert.equal(records.at(-1).releaseBytes, 0)
    assert.equal(records.some(value => value.releaseCount > 0), false)
  }
})
test("asynchronous commit callbacks are refused instead of opening a release window", async () => {
  const f = fixture({ factory: { onCommit: async () => {} } })
  await assert.rejects(f.tool.execute({ path: "src/main.py" }, f.context), /ASYNC_MANAGED_COMMIT_FORBIDDEN/)
})
test("consumed permits keep their monotonic deadline through observers and commit", async () => {
  for (const mode of ["observer", "commit"]) {
    let clock = 100
    const records = []
    const f = fixture({
      ask: async ({ evidence }) => {
        globalThis[PERMITS].set(evidence.snapshotId, { permit: signed(evidence), registeredAt: clock, validForMs: 1 })
      },
      factory: {
        now: () => clock,
        onProgress: async value => {
          records.push(structuredClone(value))
          if (mode === "observer" && value.permitVerified && !value.releaseCount && value.stage !== "blocked") clock += 200000
        },
        onCommit: () => { if (mode === "commit") clock += 200000 },
      },
    })
    await assert.rejects(f.tool.execute({ path: "src/main.py" }, f.context), /RK_PERMIT_EXPIRED/)
    assert.equal(globalThis[PERMITS].size, 0)
    assert.equal(records.at(-1).stage, "blocked")
    assert.equal(records.at(-1).releaseCount, 0)
    assert.equal(records.at(-1).releaseBytes, 0)
  }
})

test("root and relative directories are both pinned from slash with NOFOLLOW", async () => {
  const calls = [], closed = [], body = Buffer.from("SAFE")
  const flags = { O_RDONLY: 0, O_DIRECTORY: 0x10000, O_NOFOLLOW: 0x20000, O_NONBLOCK: 0x800 }
  let next = 10, opened = 0, bytes = 0
  const info = { isFile: () => true, isSymbolicLink: () => false, nlink: 1, size: body.length, dev: 1, ino: 100, mtimeMs: 1, ctimeMs: 1 }
  const openFile = async (path, value) => {
    calls.push({ path, flags: value })
    const fd = next++
    if (path.endsWith("/main.py")) return { fd, stat: async () => info, close: async () => closed.push(fd), read: async (target, offset, length, position) => { const count = Math.max(0, Math.min(length, body.length - position)); body.copy(target, offset, position, position + count); return { bytesRead: count } } }
    return { fd, close: async () => closed.push(fd) }
  }
  const output = await readLinuxSnapshot("/project/work", "src/main.py", { platform: "linux", flags, openFile, lstatFile: async () => info, onOpen: async () => opened++, onBytes: async count => { bytes += count } })
  assert.equal(output.toString(), "SAFE")
  assert.deepEqual(calls.map(value => value.path), ["/", "/proc/self/fd/10/project", "/proc/self/fd/11/work", "/proc/self/fd/12/src", "/proc/self/fd/13/main.py"])
  assert.ok(calls.every(value => (value.flags & flags.O_NOFOLLOW) !== 0))
  assert.ok(calls.slice(0, -1).every(value => (value.flags & flags.O_DIRECTORY) !== 0))
  assert.equal(opened, 1); assert.equal(bytes, body.length); assert.equal(closed.length, 5)
})
test("a symlink in the enrolled root chain fails before any file open or read", async () => {
  const paths = [], closed = [], flags = { O_RDONLY: 0, O_DIRECTORY: 1, O_NOFOLLOW: 2, O_NONBLOCK: 4 }
  let scans = 0
  await assert.rejects(readLinuxSnapshot("/project/work", "src/main.py", {
    platform: "linux", flags,
    openFile: async path => { paths.push(path); if (path !== "/") throw new Error("ELOOP"); return { fd: 10, close: async () => closed.push(10) } },
    lstatFile: async () => { throw new Error("unexpected file metadata read") },
    onOpen: async () => scans++,
  }), /ELOOP/)
  assert.deepEqual(paths, ["/", "/proc/self/fd/10/project"])
  assert.equal(scans, 0); assert.deepEqual(closed, [10])
})
