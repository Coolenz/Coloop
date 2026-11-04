import test from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { createHash } from "node:crypto"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import Hook from "../plugins/coloop-hook.mjs"
// Use the exact locally prepared 1.19.5 SDK, including its real generated core.
const { createOpencodeClient } = await import(new URL("../.cache/plugin-sdk/node_modules/@opencode-ai/sdk/dist/client.js", import.meta.url).href)

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`
  return JSON.stringify(value)
}
function hash(value) { return createHash("sha256").update(canonical(value)).digest("hex") }
const question = () => ({ id: "que_1", sessionID: "ses_1", questions: [{ question: "选择本地方案", header: "方式", options: [{ label: "仅在本地离线分析，不上传任何数据", description: "" }, { label: "取消本次操作并保持当前状态", description: "" }], multiple: false }] })
async function until(predicate, limit = 5000) {
  const end = performance.now() + limit
  while (!predicate()) { if (performance.now() >= end) throw new Error("test timed out"); await new Promise(r => setTimeout(r, 10)) }
}
async function fixture(options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "coloop-hook-")), prior = process.env.COLOOP_HOOK_CONNECTION
  let pending = options.permission ? [{ id: "per_1", sessionID: "ses_1", permission: "read", patterns: ["D:\\RK\\safe.py"], metadata: {}, always: [] }] : [question()]
  const observations = [], reviews = [], replies = [], sourceCalls = [], sourceRequests = [], detachedSignals = []
  let stable
  const json = (res, value) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(value)) }
  const sourceFetch = async request => {
    const url = new URL(request.url), path = url.pathname
    sourceCalls.push(path)
    // Retain the complete pending transport input, including its derived signal.
    // A real fetch keeps this Request alive until its response or cancellation.
    sourceRequests.push({ request, url: request.url, method: request.method, directory: url.searchParams.get("directory"), authorization: request.headers.get("authorization"), redirect: request.redirect, signal: request.signal })
    if (options.sourceResponse) return options.sourceResponse(request, pending)
    if (request.method === "GET") return new Response(JSON.stringify(options.changePending ? options.changePending(pending) : pending), { headers: { "content-type": "application/json" } })
    replies.push({ path, body: JSON.parse(await request.text()) })
    if (!options.notConsumed) pending = []
    return new Response("true", { headers: { "content-type": "application/json" } })
  }
  const source = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk
    const response = await sourceFetch(new Request("http://127.0.0.1" + req.url, { method: req.method, headers: req.headers, ...(req.method === "GET" ? {} : { body }) }))
    res.writeHead(response.status, Object.fromEntries(response.headers.entries()))
    res.end(Buffer.from(await response.arrayBuffer()))
  })
  const control = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, "Bearer " + "t".repeat(64))
    let body = ""; for await (const chunk of req) body += chunk
    const message = JSON.parse(body)
    if (["/v1/control/register", "/v1/control/report"].includes(req.url)) { json(res, { version: 1 }); return }
    if (req.url === "/v1/control/poll") { json(res, { version: 1, commands: [] }); return }
    if (req.url === "/v1/hooks") {
      observations.push(message)
      if (options.holdObservation) await options.holdObservation(message)
      json(res, { version: 1, sourceId: message.sourceId, instanceId: message.instanceId, eventId: message.eventId, sequence: message.sequence, receivedAt: new Date().toISOString(), duplicate: false, contextBytes: 0, contextEvents: 0 }); return
    }
    assert.equal(req.url, "/v1/hooks/review"); reviews.push(message)
    if (options.holdReview) await options.holdReview(message)
    const a = message.payload.approval
    stable ??= { version: 1, id: a.id, sessionId: a.sessionId, kind: a.kind, workspace: message.workspace, createdAt: "2030-01-01T00:00:00.000Z", expiresAt: "2030-01-01T00:03:00.000Z", contextRef: "c".repeat(64), ...Object.fromEntries(["tool", "patterns", "command", "question", "choices"].filter(k => a[k] !== undefined).map(k => [k, a[k]])) }
    const action = options.decision ?? (options.permission ? "deny" : "select")
    const decision = { version: 1, id: a.id, sessionId: a.sessionId, requestHash: hash(stable), decision: action, reasonCode: action === "select" ? "RK_SAFE_CHOICE" : "TEST_POLICY", source: action === "select" ? "rk" : "policy", expiresAt: stable.expiresAt, ...(action === "select" ? { choiceId: "0" } : {}) }
    if (options.transient && reviews.length === 1) { decision.decision = "defer"; delete decision.choiceId; decision.reasonCode = "MODEL_BUSY" }
    let response = { version: 1, sourceId: message.sourceId, instanceId: message.instanceId, eventId: message.eventId, sequence: message.sequence, originalDigest: a.originalDigest, reviewEvent: stable, decision, metrics: { receiveMs: 1, decisionMs: 1, totalMs: 2, contextBytes: 0, contextEvents: 0 } }
    if (options.response) response = options.response(response)
    if (options.rawResponse) { res.setHeader("content-type", "application/json"); res.end(options.rawResponse(response)); return }
    json(res, response)
  })
  if (!options.internal) await new Promise(r => source.listen(0, "127.0.0.1", r))
  await new Promise(r => control.listen(0, "127.0.0.1", r))
  const file = join(directory, "connection.json")
  await writeFile(file, JSON.stringify({ url: `http://127.0.0.1:${control.address().port}`, token: "t".repeat(64), workspace: "D:\\RK", sourceId: "source-test" }))
  process.env.COLOOP_HOOK_CONNECTION = file
  const baseUrl = options.internal ? "http://opencode.internal" : `http://127.0.0.1:${source.address().port}`
  const client = createOpencodeClient({ baseUrl, directory: "/work/project", headers: { authorization: "Basic fixture-private" }, ...(options.internal ? { fetch: sourceFetch } : {}) })
  assert.equal(typeof client._client.request, "function"); assert.equal(typeof client._client.getConfig, "function")
  if (options.detachSdkSignal) client._client.interceptors.request.use(request => {
    const independent = new AbortController()
    detachedSignals.push(independent.signal)
    return new Request(request, { signal: independent.signal })
  })
  const hooks = await Hook({ directory: "/work/project", serverUrl: options.serverUrl ?? new URL(baseUrl), client: options.missingCore ? {} : client })
  return { hooks, observations, reviews, replies, sourceCalls, sourceRequests, detachedSignals, pending: () => pending,
    asked: async () => { await hooks.event({ event: { type: options.permission ? "permission.asked" : "question.asked", properties: pending[0] } }) },
    async close() { await hooks.dispose?.(); source.closeAllConnections(); control.closeAllConnections(); await Promise.all([new Promise(r => source.close(r)), new Promise(r => control.close(r))]); if (prior === undefined) delete process.env.COLOOP_HOOK_CONNECTION; else process.env.COLOOP_HOOK_CONNECTION = prior; await rm(directory, { recursive: true, force: true }) },
  }
}

test("native hooks deliver text/tool events without mutating output or leaking secrets", async () => {
  const f = await fixture()
  try {
    const output = { message: { id: "msg_user" }, parts: [{ id: "part_user", type: "text", text: "请检查本地代码" }] }
    const snapshot = structuredClone(output)
    await f.hooks["chat.message"]({ sessionID: "ses_1", messageID: "msg_user" }, output)
    const args = { args: { command: "never execute by hook" } }, before = structuredClone(args)
    await f.hooks["tool.execute.before"]({ sessionID: "ses_1", tool: "read", callID: "call_1" }, args)
    await f.hooks["tool.execute.after"]({ sessionID: "ses_1", tool: "read", callID: "call_1" }, { output: "password=super-private-value" })
    await f.hooks.event({ event: { type: "message.part.updated", properties: { part: { sessionID: "ses_1", messageID: "msg_assistant", id: "think_1", type: "reasoning", text: "private chain of thought" } } } })
    await until(() => f.observations.length === 3)
    assert.deepEqual(output, snapshot); assert.deepEqual(args, before)
    assert.deepEqual(f.observations.map(m => m.kind), ["message", "tool.before", "tool.after"])
    assert.equal(f.observations.find(m => m.kind === "tool.before").payload.text, JSON.stringify(before.args))
    const body = JSON.stringify(f.observations)
    assert.equal(body.includes("super-private-value"), false); assert.equal(body.includes("chain of thought"), false)
    assert.equal(f.sourceCalls.length, 0)
  } finally { await f.close() }
})

test("question notification reaches real HTTP review and original label is consumed once", async () => {
  const f = await fixture()
  try {
    await f.hooks["chat.message"]({ sessionID: "ses_1", messageID: "msg_user" }, { parts: [{ type: "text", text: "仅本地处理" }] })
    const started = performance.now(); await f.asked()
    assert.ok(performance.now() - started < 100, "event callback does not await RK inference")
    await until(() => f.observations.some(m => m.payload.state === "approval.completed"))
    assert.equal(f.reviews.length, 1); assert.equal(f.replies.length, 1)
    assert.deepEqual(f.replies[0], { path: "/question/que_1/reply", body: { answers: [["仅在本地离线分析，不上传任何数据"]] } })
    assert.equal(f.pending().length, 0)
    assert.equal(f.reviews[0].taskId, "msg_user")
    const done = f.observations.find(m => m.payload.state === "approval.completed")
    assert.ok(done.payload.metrics.hookToConsumedMs >= 0); assert.ok(done.payload.metrics.reviewMs >= 0)
    assert.equal(done.payload.originalDigest, f.reviews[0].payload.approval.originalDigest)
    await f.hooks.event({ event: { type: "question.asked", properties: question() } })
    await new Promise(r => setTimeout(r, 50)); assert.equal(f.reviews.length, 1)
  } finally { await f.close() }
})

test("all allow decisions stay pending without native once or always reply", async () => {
  const f = await fixture({ permission: true, decision: "allow" })
  try { await f.asked(); await until(() => f.observations.some(m => m.payload.reasonCode === "UNVERIFIED_AGENT_DATA_ROUTE")); assert.equal(f.replies.length, 0); assert.equal(f.pending().length, 1) } finally { await f.close() }
})

test("permission deny sends one reject and confirms the native pending is gone", async () => {
  const f = await fixture({ permission: true })
  try { await f.asked(); await until(() => f.observations.some(m => m.payload.state === "approval.completed")); assert.deepEqual(f.replies[0].body, { reply: "reject" }); assert.equal(f.replies.length, 1) } finally { await f.close() }
})

test("unknown permission metadata is not removed to fabricate a safe review", async () => {
  const f = await fixture({ permission: true })
  try { f.pending()[0].metadata = { filePath: ".env", operation: "upload" }; await f.asked(); await until(() => f.observations.some(m => m.payload.state === "approval.pending")); assert.equal(f.reviews.length, 0); assert.equal(f.replies.length, 0) } finally { await f.close() }
})

for (const [name, options] of [
  ["wrong source binding", { response: r => ({ ...r, sourceId: "attacker" }) }],
  ["changed review hash", { response: r => ({ ...r, decision: { ...r.decision, requestHash: "f".repeat(64) } }) }],
  ["changed original pending", { changePending: p => p.map(x => ({ ...x, questions: [{ ...x.questions[0], question: "changed" }] })) }],
  ["duplicate response key", { rawResponse: r => JSON.stringify(r).replace('"version":1', '"version":1,"version":1') }],
]) test(`rejects ${name} before replying`, async () => {
  const f = await fixture(options)
  try { await f.asked(); await until(() => f.observations.some(m => m.payload.state === "approval.pending")); assert.equal(f.replies.length, 0) } finally { await f.close() }
})

test("unconsumed successful POST is not retried or reported as completed", async () => {
  const f = await fixture({ notConsumed: true })
  try { await f.asked(); await until(() => f.observations.some(m => m.payload.reasonCode === "REPLY_NOT_CONSUMED")); assert.equal(f.replies.length, 1); assert.equal(f.observations.some(m => m.payload.state === "approval.completed"), false) } finally { await f.close() }
})

test("transient defer retries the exact envelope without changing its original lifetime", async () => {
  const f = await fixture({ transient: true })
  try { await f.asked(); await until(() => f.observations.some(m => m.payload.state === "approval.completed")); assert.equal(f.reviews.length, 2); assert.deepEqual(f.reviews[0], f.reviews[1]); assert.equal(f.replies.length, 1) } finally { await f.close() }
})

test("message-part updates coalesce and task changes never relabel old text", async () => {
  const f = await fixture()
  try {
    await f.hooks["chat.message"]({ sessionID: "ses_1", messageID: "msg_old" }, { parts: [{ type: "text", text: "old task text" }] })
    await f.hooks["chat.message"]({ sessionID: "ses_1", messageID: "msg_new" }, { parts: [{ type: "text", text: "new task text" }] })
    await f.hooks.event({ event: { type: "message.updated", properties: { info: { id: "msg_a", sessionID: "ses_1", role: "assistant" } } } })
    for (let i = 0; i < 100; i++) await f.hooks.event({ event: { type: "message.part.updated", properties: { part: { type: "text", sessionID: "ses_1", messageID: "msg_a", id: "part_a", text: "partial " + i } } } })
    await until(() => f.observations.some(m => m.payload.role === "assistant"))
    assert.ok(f.observations.length < 10)
    assert.equal(f.observations.some(m => m.taskId === "msg_new" && m.payload.text === "old task text"), false)
    assert.equal(f.observations.find(m => m.payload.role === "assistant").payload.text, "partial 99")
    await f.hooks.event({ event: { type: "session.deleted", properties: { info: { id: "ses_1" } } } })
    await until(() => f.observations.some(m => m.kind === "closed"))
  } finally { await f.close() }
})

test("unconfigured plugin is inert and exposes no permission.ask pseudo-gate", async () => {
  const old = process.env.COLOOP_HOOK_CONNECTION
  process.env.COLOOP_HOOK_CONNECTION = "Z:/missing-coloop-connection.json"
  try { assert.deepEqual(await Hook({ directory: "/work", serverUrl: new URL("http://127.0.0.1:4096") }), {}) } finally { if (old === undefined) delete process.env.COLOOP_HOOK_CONNECTION; else process.env.COLOOP_HOOK_CONNECTION = old }
})

test("oversized observations mark truncation within the UTF-8 budget and never invent complete semantics", async () => {
  const f = await fixture()
  try {
    const output = { output: "中文路径😀".repeat(2000) + "不要上传任何文件" }
    const original = output.output
    await f.hooks["tool.execute.before"]({ sessionID: "ses_1", tool: "read", callID: "call_1" }, { args: {} })
    await f.hooks["tool.execute.after"]({ sessionID: "ses_1", tool: "read", callID: "call_1" }, output)
    await until(() => f.observations.filter(m => m.kind === "tool.after").length === 1)
    const text = f.observations.find(m => m.kind === "tool.after").payload.text
    assert.ok(Buffer.byteLength(text, "utf8") <= 2048)
    assert.match(text, /\n\[TRUNCATED_UNTRUSTED_OBSERVATION\]$/)
    assert.equal(text.includes("\ufffd"), false)
    assert.equal(output.output, original)
    await f.hooks["tool.execute.before"]({ sessionID: "ses_1", tool: "read", callID: "call_2" }, { args: {} })
    await f.hooks["tool.execute.after"]({ sessionID: "ses_1", tool: "read", callID: "call_2" }, { output: "password=sensitive-value-123 " + "x".repeat(10000) })
    await until(() => f.observations.filter(m => m.kind === "tool.after").length === 2)
    assert.equal(f.observations.filter(m => m.kind === "tool.after")[1].payload.text.includes("sensitive-value-123"), false)
  } finally { await f.close() }
})

test("switching task closes the old scope and drops late old-tool, assistant and approval events", async () => {
  const f = await fixture()
  try {
    await f.hooks["chat.message"]({ sessionID: "ses_1", messageID: "msg_old" }, { message: { id: "msg_old" }, parts: [{ type: "text", text: "old task text" }] })
    await f.hooks["tool.execute.before"]({ sessionID: "ses_1", tool: "question", callID: "call_old" }, { args: {} })
    await f.hooks.event({ event: { type: "message.updated", properties: { info: { id: "msg_old_answer", parentID: "msg_old", role: "assistant", sessionID: "ses_1" } } } })
    await until(() => f.observations.length >= 2)
    await f.hooks["chat.message"]({ sessionID: "ses_1", messageID: "msg_new" }, { message: { id: "msg_new" }, parts: [{ type: "text", text: "new task text" }] })
    await f.hooks.event({ event: { type: "question.asked", properties: { ...question(), tool: { messageID: "msg_old_answer", callID: "call_old" } } } })
    await f.hooks["tool.execute.after"]({ sessionID: "ses_1", tool: "question", callID: "call_old" }, { output: "late old tool output" })
    await f.hooks.event({ event: { type: "message.part.updated", properties: { part: { type: "text", sessionID: "ses_1", messageID: "msg_old_answer", id: "part_old", text: "late old answer" } } } })
    await until(() => f.observations.some(m => m.kind === "closed" && m.taskId === "msg_old") && f.observations.some(m => m.taskId === "msg_new" && m.payload.text === "new task text"))
    assert.equal(f.reviews.length, 0); assert.equal(f.replies.length, 0)
    assert.equal(f.observations.some(m => m.taskId === "msg_new" && /old/.test(m.payload.text ?? "")), false)
    const old = f.observations.filter(m => m.taskId === "msg_old")
    assert.equal(old.at(-1).kind, "closed")
    assert.deepEqual(old.map(m => m.sequence), old.map((_, index) => index + 1))
  } finally { await f.close() }
})

test("quoted secret keys and embedded JSON credentials never leave the tool-before observation", async () => {
  const f = await fixture()
  try {
    const cases = [
      { command: "npm run typecheck" },
      { command: "echo test", password: "test-secret-123" },
      { command: 'echo {"password":"embedded-secret-456"}' },
      { config: { "api-key": "test-key-789" } },
      { command: "curl http://user:private-credential@127.0.0.1" },
    ]
    for (let index = 0; index < cases.length; index++) {
      const output = { args: cases[index] }, before = structuredClone(output)
      await f.hooks["tool.execute.before"]({ sessionID: "ses_1", tool: "bash", callID: `call_${index}` }, output)
      assert.deepEqual(output, before)
    }
    await until(() => f.observations.filter(m => m.kind === "tool.before").length === cases.length)
    const before = f.observations.filter(m => m.kind === "tool.before")
    assert.equal(before[0].payload.text, '{"command":"npm run typecheck"}')
    assert.ok(before.slice(1).every(m => m.payload.text === "[sensitive content omitted]"))
    const raw = JSON.stringify(f.observations)
    for (const secret of ["test-secret-123", "embedded-secret-456", "test-key-789", "private-credential"]) assert.equal(raw.includes(secret), false)
  } finally { await f.close() }
})

test("real SDK custom fetch consumes an internal pending without TCP or touching a foreign 4096 server", async () => {
  let foreignCalls = 0
  const foreign = createServer((_req, res) => { foreignCalls++; res.setHeader("content-type", "application/json"); res.end("[]") })
  await new Promise((resolve, reject) => { foreign.once("error", reject); foreign.listen(4096, "127.0.0.1", resolve) })
  let f
  try {
    f = await fixture({ internal: true, serverUrl: new URL("http://localhost:4096") })
    await f.asked()
    await until(() => f.observations.some(m => m.payload.state === "approval.completed"))
    assert.equal(f.pending().length, 0); assert.equal(f.replies.length, 1); assert.equal(foreignCalls, 0)
    assert.deepEqual(f.sourceCalls, ["/question", "/question/que_1/reply", "/question"])
    for (const request of f.sourceRequests) {
      assert.equal(new URL(request.url).hostname, "opencode.internal")
      assert.equal(request.directory, "/work/project")
      assert.equal(request.authorization, "Basic fixture-private")
      assert.equal(request.redirect, "error")
      assert.ok(request.signal instanceof AbortSignal)
    }
  } finally {
    if (f) await f.close()
    foreign.closeAllConnections(); await new Promise(r => foreign.close(r))
  }
})

test("configured plugin with no SDK core is entirely inert and cannot use a fallback source port", async () => {
  const f = await fixture({ missingCore: true })
  try { assert.deepEqual(f.hooks, {}); assert.equal(f.sourceCalls.length, 0); assert.equal(f.observations.length, 0) }
  finally { await f.close() }
})

for (const [name, sourceResponse, reason] of [
  ["non-JSON source", () => new Response("[]", { headers: { "content-type": "text/plain" } }), "HTTP_NOT_ACCEPTED"],
  ["non-200 source", () => new Response("[]", { status: 201, headers: { "content-type": "application/json" } }), "HTTP_NOT_ACCEPTED"],
  ["source redirect", () => new Response("", { status: 302, headers: { location: "http://localhost:4096/question", "content-type": "application/json" } }), "HTTP_NOT_ACCEPTED"],
  ["duplicate source JSON key", (_request, pending) => new Response(JSON.stringify(pending).replace('"id":"que_1"', '"id":"que_1","id":"que_1"'), { headers: { "content-type": "application/json" } }), "INVALID_JSON"],
  ["invalid source UTF-8", () => new Response(new Uint8Array([0xff]), { headers: { "content-type": "application/json" } }), "INVALID_JSON"],
  ["oversized source stream", () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(524288)); controller.enqueue(new Uint8Array(524289)); controller.close() } }), { headers: { "content-type": "application/json" } }), "RESPONSE_LIMIT"],
  ["oversized declared source body", () => new Response("[]", { headers: { "content-type": "application/json", "content-length": "1048577" } }), "RESPONSE_LIMIT"],
]) test(`SDK bridge rejects ${name} before any source reply`, async () => {
  const f = await fixture({ internal: true, sourceResponse })
  try {
    await f.asked(); await until(() => f.observations.some(m => m.payload.state === "approval.pending"))
    assert.equal(f.replies.length, 0); assert.equal(f.sourceCalls.length, 1)
    assert.equal(f.observations.find(m => m.payload.state === "approval.pending").payload.reasonCode, reason)
  } finally { await f.close() }
})

test("SDK source POST transport failure is ambiguous and is never retried", async () => {
  let posts = 0
  const f = await fixture({ internal: true, sourceResponse: (request, pending) => {
    if (request.method === "GET") return new Response(JSON.stringify(pending), { headers: { "content-type": "application/json" } })
    posts++; throw new Error("SOURCE_DISCONNECTED")
  } })
  try {
    await f.asked(); await until(() => f.observations.some(m => m.payload.state === "approval.pending"))
    assert.equal(posts, 1); assert.deepEqual(f.sourceCalls, ["/question", "/question/que_1/reply"])
    assert.equal(f.pending().length, 1)
  } finally { await f.close() }
})

test("SDK in-process fetch that ignores AbortSignal still has a five-second source deadline", async () => {
  const f = await fixture({ internal: true, sourceResponse: () => new Promise(() => {}) })
  try {
    const started = performance.now(); await f.asked()
    await until(() => f.sourceCalls.length >= 1)
    global.gc?.()
    await until(() => f.observations.some(m => m.payload.reasonCode === "HTTP_TIMEOUT"), 7000)
    await until(() => f.sourceRequests[0]?.signal.aborted === true, 1000)
    assert.ok(performance.now() - started >= 4900)
    assert.equal(f.sourceCalls.length, 1); assert.equal(f.sourceRequests[0].signal.aborted, true)
    assert.equal(f.replies.length, 0)
  } finally { await f.close() }
})

test("source compaction cancels an outstanding SDK fetch without waiting for its deadline", async () => {
  const f = await fixture({ internal: true, sourceResponse: () => new Promise(() => {}) })
  try {
    await f.asked(); await until(() => f.sourceCalls.length === 1)
    await f.hooks.event({ event: { type: "session.compacted", properties: { sessionID: "ses_1" } } })
    await until(() => f.observations.some(m => m.payload.reasonCode === "REQUEST_CANCELLED"))
    await until(() => f.sourceRequests[0]?.signal.aborted === true, 1000)
    assert.equal(f.sourceRequests[0].signal.aborted, true); assert.equal(f.replies.length, 0)
  } finally { await f.close() }
})

test("source boundary owns cancellation even when an SDK interceptor detaches its Request signal", async () => {
  const f = await fixture({ internal: true, detachSdkSignal: true, sourceResponse: () => new Promise(() => {}) })
  try {
    await f.asked(); await until(() => f.sourceCalls.length === 1)
    await f.hooks.event({ event: { type: "session.compacted", properties: { sessionID: "ses_1" } } })
    await until(() => f.observations.some(m => m.payload.reasonCode === "REQUEST_CANCELLED") && f.sourceRequests[0].signal.aborted)
    assert.equal(f.detachedSignals.length, 1); assert.equal(f.detachedSignals[0].aborted, false)
    assert.equal(f.sourceRequests[0].signal.aborted, true); assert.equal(f.replies.length, 0)
  } finally { await f.close() }
})

test("part snapshots coalesce across multiple flush windows while a delivery is in flight", async () => {
  let resume
  const gate = new Promise(resolve => { resume = resolve })
  const f = await fixture({ holdObservation: message => message.payload.text === "hold-first" ? gate : undefined })
  try {
    await f.hooks["chat.message"]({ sessionID: "ses_1", messageID: "msg_user" }, { parts: [{ type: "text", text: "hold-first" }] })
    await until(() => f.observations.length >= 1)
    await f.hooks.event({ event: { type: "message.updated", properties: { info: { id: "msg_answer", parentID: "msg_user", role: "assistant", sessionID: "ses_1" } } } })
    for (let index = 0; index < 80; index++) {
      await f.hooks.event({ event: { type: "message.part.updated", properties: { part: { type: "text", id: "part_answer", messageID: "msg_answer", sessionID: "ses_1", text: "partial " + index } } } })
      if (index % 4 === 3) await new Promise(resolve => setTimeout(resolve, 12))
    }
    resume()
    await until(() => f.observations.some(message => message.payload.text === "partial 79"))
    assert.equal(f.observations.filter(message => message.payload.role === "assistant").length, 1)
  } finally { resume(); await f.close() }
})

for (const [label, count, text] of [["event count", 150, "small"], ["UTF-8 byte budget", 45, "x".repeat(2000)]]) test(`cross-flush ${label} overflow drops buffered bodies and leaves approval pending`, async () => {
  let resume
  const gate = new Promise(resolve => { resume = resolve })
  const warnings = [], previousWarn = console.warn
  console.warn = value => warnings.push(value)
  const f = await fixture({ holdObservation: message => message.payload.text === "hold-first" ? gate : undefined })
  try {
    await f.hooks["chat.message"]({ sessionID: "ses_1", messageID: "msg_user" }, { parts: [{ type: "text", text: "hold-first" }] })
    await until(() => f.observations.length >= 1)
    for (let index = 0; index < count; index++) {
      await f.hooks["tool.execute.before"]({ sessionID: "ses_1", tool: "read", callID: "call_" + index }, { args: { command: text } })
      if (index % 10 === 9) await new Promise(resolve => setTimeout(resolve, 12))
    }
    assert.deepEqual(warnings, ["[ColoopHook] HOOK_QUEUE_LIMIT"])
    await f.asked(); resume()
    await until(() => f.observations.some(message => message.payload.reasonCode === "HOOK_QUEUE_LIMIT"))
    assert.equal(f.reviews.length, 0); assert.equal(f.replies.length, 0)
    assert.ok(f.observations.filter(message => message.kind === "tool.before").length < 5)
  } finally { resume(); await f.close(); console.warn = previousWarn }
})

test("queue overflow cancels an already running review before any source reply", async () => {
  let resumeReview, resumeObservation
  const reviewGate = new Promise(resolve => { resumeReview = resolve })
  const observationGate = new Promise(resolve => { resumeObservation = resolve })
  const previousWarn = console.warn, warnings = []
  console.warn = value => warnings.push(value)
  const f = await fixture({ holdReview: () => reviewGate, holdObservation: message => message.kind === "tool.before" ? observationGate : undefined })
  try {
    await f.asked(); await until(() => f.reviews.length === 1)
    for (let index = 0; index < 45; index++) {
      await f.hooks["tool.execute.before"]({ sessionID: "ses_1", tool: "read", callID: "call_" + index }, { args: { command: "x".repeat(2000) } })
      if (index % 10 === 9) await new Promise(resolve => setTimeout(resolve, 12))
    }
    assert.ok(warnings.includes("[ColoopHook] HOOK_QUEUE_LIMIT"))
    resumeObservation(); resumeReview()
    await until(() => f.observations.some(message => message.payload.state === "approval.pending"))
    assert.equal(f.replies.length, 0); assert.equal(f.pending().length, 1)
  } finally { resumeReview(); resumeObservation(); await f.close(); console.warn = previousWarn }
})

test("the 65th session evicts the least recently used idle scope and delivers its own approval", async () => {
  const f = await fixture()
  try {
    for (let index = 0; index < 64; index++) {
      const sessionID = "ses_idle_" + index
      await f.hooks["chat.message"]({ sessionID, messageID: "msg_" + index }, { parts: [{ type: "text", text: "idle history " + index }] })
      await f.hooks.event({ event: { type: "session.status", properties: { sessionID, status: { type: "idle" } } } })
    }
    await until(() => f.observations.filter(message => message.payload.state === "idle").length === 64)
    await f.hooks["chat.message"]({ sessionID: "ses_65", messageID: "msg_65" }, { parts: [{ type: "text", text: "new session" }] })
    await until(() => f.observations.some(message => message.kind === "closed" && message.sessionId === "ses_idle_0") && f.observations.some(message => message.taskId === "msg_65"))
    f.pending()[0].sessionID = "ses_65"
    await f.asked(); await until(() => f.observations.some(message => message.sessionId === "ses_65" && message.payload.state === "approval.completed"))
    assert.equal(f.reviews.length, 1); assert.equal(f.reviews[0].taskId, "msg_65"); assert.equal(f.replies.length, 1)
  } finally { await f.close() }
})

test("64 active scopes reject a new source session with one fixed diagnostic", async () => {
  const previousWarn = console.warn, warnings = []
  console.warn = value => warnings.push(value)
  const f = await fixture()
  try {
    for (let index = 0; index < 64; index++) await f.hooks["chat.message"]({ sessionID: "ses_busy_" + index, messageID: "msg_" + index }, { parts: [{ type: "text", text: "active" }] })
    await until(() => f.observations.length === 64)
    await f.hooks["chat.message"]({ sessionID: "ses_65", messageID: "msg_65" }, { parts: [{ type: "text", text: "must remain unreviewed" }] })
    f.pending()[0].sessionID = "ses_65"; await f.asked()
    assert.deepEqual(warnings, ["[ColoopHook] HOOK_SESSION_CAPACITY"])
    assert.equal(f.observations.some(message => message.sessionId === "ses_65"), false)
    assert.equal(f.reviews.length, 0); assert.equal(f.replies.length, 0)
  } finally { await f.close(); console.warn = previousWarn }
})

test("an idle-status scope with an outstanding approval cannot be evicted", async () => {
  let resume
  const gate = new Promise(resolve => { resume = resolve })
  const f = await fixture({ holdReview: () => gate })
  try {
    await f.hooks["chat.message"]({ sessionID: "ses_1", messageID: "msg_first" }, { parts: [{ type: "text", text: "pending review" }] })
    await f.asked(); await until(() => f.reviews.length === 1)
    await f.hooks.event({ event: { type: "session.status", properties: { sessionID: "ses_1", status: { type: "idle" } } } })
    for (let index = 0; index < 63; index++) await f.hooks.event({ event: { type: "session.status", properties: { sessionID: "ses_other_" + index, status: { type: "idle" } } } })
    await until(() => f.observations.filter(message => message.payload.state === "idle").length === 64)
    await f.hooks["chat.message"]({ sessionID: "ses_65", messageID: "msg_65" }, { parts: [{ type: "text", text: "new task" }] })
    await until(() => f.observations.some(message => message.kind === "closed"))
    assert.equal(f.observations.some(message => message.kind === "closed" && message.sessionId === "ses_1"), false)
    resume(); await until(() => f.observations.some(message => message.sessionId === "ses_1" && message.payload.state === "approval.completed"))
    assert.equal(f.replies.length, 1)
  } finally { resume(); await f.close() }
})
