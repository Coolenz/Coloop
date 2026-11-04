import test from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import Hook from "../plugins/coloop-hook.mjs"
const { createOpencodeClient } = await import(new URL("../.cache/plugin-sdk/node_modules/@opencode-ai/sdk/dist/client.js", import.meta.url).href)

async function until(predicate, limit = 5000) {
  const end = performance.now() + limit
  while (!predicate()) {
    if (performance.now() > end) throw new Error("test timed out")
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}
async function fixture(options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "coloop-control-")), prior = process.env.COLOOP_HOOK_CONNECTION
  const registrations = [], reports = [], calls = [], polls = [], messages = new Map(), observations = []
  let commands, hooks
  const json = (response, body) => { response.setHeader("content-type", "application/json"); response.end(JSON.stringify(body)) }
  const control = createServer(async (request, response) => {
    assert.equal(request.method, "POST")
    assert.equal(request.headers.authorization, `Bearer ${"t".repeat(64)}`)
    let raw = ""; for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw)
    if (request.url === "/v1/control/register") { registrations.push(body); json(response, { version: 1 }); return }
    if (request.url === "/v1/control/report") { reports.push(body); json(response, { version: 1 }); return }
    if (request.url === "/v1/control/poll") {
      polls.push(body)
      const batch = commands ?? (registrations.length && options.commands ? options.commands(registrations.at(-1), polls.length) : [])
      commands = undefined
      json(response, { version: 1, commands: batch }); return
    }
    if (request.url === "/v1/hooks") {
      observations.push(body)
      json(response, { version: 1, sourceId: body.sourceId, instanceId: body.instanceId, eventId: body.eventId, sequence: body.sequence }); return
    }
    response.statusCode = 404; json(response, { error: "NOT_FOUND" })
  })
  await new Promise(resolve => control.listen(0, "127.0.0.1", resolve))
  const connection = join(directory, "connection.json")
  await writeFile(connection, JSON.stringify({ url: `http://127.0.0.1:${control.address().port}`, token: "t".repeat(64),
    ...(options.minimalConfig ? {} : { workspace: "D:\\trusted-workspace", sourceId: "source_control" }) }))
  process.env.COLOOP_HOOK_CONNECTION = connection
  const sourceFetch = async request => {
    const url = new URL(request.url), raw = request.method === "POST" ? await request.text() : ""
    const body = raw ? JSON.parse(raw) : undefined
    calls.push({ method: request.method, path: url.pathname, body, directory: url.searchParams.get("directory"), authorization: request.headers.get("authorization"), signal: request.signal })
    if (url.pathname === "/session/ses_control/prompt_async") {
      assert.equal(request.method, "POST")
      if (options.neverRespond) return new Promise(() => {})
      if (options.promptStatus) return new Response("true", { status: options.promptStatus, headers: { "content-type": "application/json" } })
      messages.set(body.messageID, { info: { id: body.messageID, sessionID: "ses_control", role: options.wrongRole ? "assistant" : "user" }, parts: body.parts })
      return new Response(null, { status: 204 })
    }
    if (url.pathname.startsWith("/session/ses_control/message/")) {
      assert.equal(request.method, "GET")
      return new Response(JSON.stringify(messages.get(decodeURIComponent(url.pathname.split("/").at(-1))) ?? null), { headers: { "content-type": "application/json" } })
    }
    if (url.pathname === "/session/ses_control/abort") {
      assert.equal(request.method, "POST")
      return new Response(JSON.stringify(!options.abortRejected), { headers: { "content-type": "application/json" } })
    }
    if (url.pathname === "/session/status") {
      assert.equal(request.method, "GET")
      return new Response(JSON.stringify(options.busyAfterAbort ? { ses_control: { type: "busy" } } : {}), { headers: { "content-type": "application/json" } })
    }
    throw new Error("Unexpected native path")
  }
  const client = createOpencodeClient({ baseUrl: "http://opencode.internal", directory: "/native-workspace", headers: { authorization: "Basic native-private" }, fetch: sourceFetch })
  hooks = await Hook({ client, directory: "/native-workspace", serverUrl: new URL("http://127.0.0.1:4096") })
  return { registrations, reports, calls, polls, observations, hooks,
    send: batch => { commands = batch },
    terminal: () => reports.find(report => ["confirmed", "unknown", "failed"].includes(report.status)),
    async register() { await hooks.event({ event: { type: "session.created", properties: { info: { id: "ses_control", title: "Control session" } } } }); await until(() => registrations.length && polls.length) },
    async close() { await hooks.dispose(); control.closeAllConnections(); await new Promise(resolve => control.close(resolve)); if (prior === undefined) delete process.env.COLOOP_HOOK_CONNECTION; else process.env.COLOOP_HOOK_CONNECTION = prior; await rm(directory, { recursive: true, force: true }) },
  }
}
const command = (registration, extra = {}) => ({ commandId: "cmd_control", sessionId: "ses_control", instanceId: registration.instanceId, action: "send_message", text: "继续检查；password=literal-user-input，不要删除这段要求。", messageId: "msg_control_stable", expiresAt: new Date(Date.now() + 60000).toISOString(), ...extra })

test("registers observed sessions with host, capabilities and minimal connection-file defaults", async () => {
  const f = await fixture({ minimalConfig: true })
  try {
    await f.register()
    const entry = f.registrations[0]
    assert.equal(entry.version, 1); assert.equal(entry.source, "opencode")
    assert.equal(entry.workspace, "/native-workspace"); assert.match(entry.sourceId, /^opencode:/)
    assert.equal(entry.host, process.platform === "win32" ? "windows" : process.platform === "linux" ? "rk" : "other")
    assert.deepEqual(entry.capabilities, ["send_message", "abort_turn"])
    assert.equal(entry.state, "idle"); assert.equal(entry.title, "Control session")
    assert.equal(f.calls.length, 0)
  } finally { await f.close() }
})

test("204 prompt delivery preserves native transport and exact authorized input, then confirms original message", async () => {
  let sent
  const f = await fixture({ commands: (entry, count) => count === 1 ? [sent = command(entry)] : [] })
  try {
    await f.register(); await until(() => f.terminal())
    assert.equal(f.terminal().status, "confirmed")
    assert.deepEqual(f.reports.map(report => report.status), ["accepted", "confirmed"])
    assert.equal(f.terminal().messageId, "msg_control_stable")
    const prompt = f.calls.find(call => call.method === "POST")
    assert.deepEqual(prompt.body, { messageID: sent.messageId, parts: [{ type: "text", text: sent.text }] })
    assert.equal(prompt.directory, "/native-workspace"); assert.equal(prompt.authorization, "Basic native-private")
    assert.equal(f.calls.length, 2); assert.match(f.calls[1].path, /\/message\/msg_control_stable$/)
  } finally { await f.close() }
})

test("same command ID is dispatched once even when polled again, and conflicting reuse cannot execute", async () => {
  let sent
  const f = await fixture({ commands: (entry, count) => count === 1 ? [sent = command(entry)] : count === 2 ? [sent, { ...sent, text: "changed payload" }] : [] })
  try {
    await f.register(); await until(() => f.polls.length >= 2 && f.reports.length >= 3)
    assert.equal(f.calls.filter(call => call.method === "POST").length, 1)
    assert.equal(f.reports.at(-1).status, "confirmed")
  } finally { await f.close() }
})

test("expired command fails before native dispatch and reports its original session binding", async () => {
  const f = await fixture({ commands: (entry, count) => count === 1 ? [command(entry, { expiresAt: new Date(Date.now() - 1).toISOString() })] : [] })
  try {
    await f.register(); await until(() => f.terminal())
    assert.equal(f.terminal().status, "failed"); assert.equal(f.terminal().errorCode, "CONTROL_COMMAND_EXPIRED")
    assert.equal(f.terminal().sessionId, "ses_control"); assert.equal(f.calls.length, 0)
  } finally { await f.close() }
})

test("foreign instance, unknown actions and tool/model overrides cannot reach native source", async () => {
  const f = await fixture({ commands: (entry, count) => count === 1 ? [
    command(entry, { instanceId: "foreign-instance" }), command(entry, { action: "shell" }),
    { ...command(entry), model: { providerID: "foreign" } }, { ...command(entry), tools: { shell: true } },
    command(entry, { sessionId: ".." }), command(entry, { messageId: ".." }),
  ] : [] })
  try { await f.register(); await until(() => f.polls.length >= 2); assert.equal(f.calls.length, 0); assert.equal(f.reports.length, 0) }
  finally { await f.close() }
})

for (const [name, options, expected, code] of [
  ["native boolean true with absent idle session", {}, "confirmed", undefined],
  ["native boolean false", { abortRejected: true }, "failed", "CONTROL_ABORT_REJECTED"],
  ["native boolean true but source remains busy", { busyAfterAbort: true }, "unknown", "CONTROL_RESULT_UNCONFIRMED"],
]) test(`abort requires source confirmation: ${name}`, async () => {
  const f = await fixture({ ...options, commands: (entry, count) => count === 1 ? [command(entry, { action: "abort_turn", text: undefined, messageId: undefined })] : [] })
  try {
    await f.register(); await until(() => f.terminal())
    assert.equal(f.terminal().status, expected); assert.equal(f.terminal().errorCode, code)
    assert.equal(f.calls.filter(call => call.method === "POST").length, 1)
    assert.equal(f.calls[0].body, undefined)
  } finally { await f.close() }
})

test("ambiguous five-second native timeout reports unknown and never resends the action", async () => {
  let sent
  const f = await fixture({ neverRespond: true, commands: (entry, count) => count === 1 ? [sent = command(entry)] : [sent] })
  try {
    await f.register(); await until(() => f.terminal(), 7000)
    assert.equal(f.terminal().status, "unknown"); assert.equal(f.terminal().errorCode, "HTTP_TIMEOUT")
    await until(() => f.polls.length >= 2)
    assert.equal(f.calls.filter(call => call.method === "POST").length, 1)
  } finally { await f.close() }
})

test("204 acceptance without matching native user message stays unknown", async () => {
  const f = await fixture({ wrongRole: true, commands: (entry, count) => count === 1 ? [command(entry)] : [] })
  try { await f.register(); await until(() => f.terminal()); assert.equal(f.terminal().status, "unknown"); assert.equal(f.calls.filter(call => call.method === "POST").length, 1) }
  finally { await f.close() }
})

test("dispose cancels an in-flight native control request and stops polling", async () => {
  const f = await fixture({ neverRespond: true, commands: (entry, count) => count === 1 ? [command(entry)] : [] })
  try {
    await f.register(); await until(() => f.calls.length === 1)
    const started = performance.now(); await f.hooks.dispose()
    assert.ok(performance.now() - started < 1000)
    assert.equal(f.calls[0].signal.aborted, true)
    const count = f.polls.length
    await new Promise(resolve => setTimeout(resolve, 1100))
    assert.equal(f.polls.length, count)
  } finally { await f.close() }
})

test("a native aborted turn can be controlled again after source idle without reviving its retired Hook context", async () => {
  const f = await fixture()
  try {
    await f.register()
    await f.hooks.event({ event: { type: "session.error", properties: { sessionID: "ses_control", error: { name: "MessageAbortedError", data: { message: "aborted" } } } } })
    await f.hooks.event({ event: { type: "session.status", properties: { sessionID: "ses_control", status: { type: "idle" } } } })
    await f.hooks.event({ event: { type: "message.part.updated", properties: { part: { sessionID: "ses_control", messageID: "msg_old", id: "part_old", type: "text", text: "late retired response" } } } })
    f.send([command(f.registrations[0])])
    await until(() => f.terminal())
    assert.equal(f.terminal().status, "confirmed")
    assert.equal(f.observations.some(event => event.payload.text === "late retired response"), false)
    await until(() => f.registrations.length > 1)
    assert.equal(f.registrations.at(-1).state, "idle")
  } finally { await f.close() }
})

test("native deletion stays closed after an earlier turn error and late idle events", async () => {
  const f = await fixture()
  try {
    await f.register()
    await f.hooks.event({ event: { type: "session.error", properties: { sessionID: "ses_control", error: { name: "MessageAbortedError", data: { message: "aborted" } } } } })
    await f.hooks.event({ event: { type: "session.deleted", properties: { info: { id: "ses_control" } } } })
    await f.hooks.event({ event: { type: "session.status", properties: { sessionID: "ses_control", status: { type: "idle" } } } })
    await until(() => f.registrations.some(entry => entry.state === "closed"))
    assert.equal(f.registrations.at(-1).state, "closed")
    assert.equal(f.calls.length, 0)
  } finally { await f.close() }
})
