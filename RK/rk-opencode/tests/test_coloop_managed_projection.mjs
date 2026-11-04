/** CPU-only presentation checks; no SDK execution, filesystem read or NPU. */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import vm from "node:vm"
import test from "node:test"
import { checkedSnapshot, projectManagedReadMessages, sha256 } from "../agent/coloop_managed_core.mjs"

function fixture(text = "PUBLIC\nRK_VERIFY_ABCDEFGHIJKLMNOPQRSTUVWXYZABCDEF\n") {
  const snapshot = checkedSnapshot(Buffer.from(text))
  const meta = { version: 1, enrollmentId: "enroll-test", operation: "read", snapshotId: "snapshot-test", sessionId: "ses_test", messageId: "msg_test", instanceId: "instance-test", taskId: "task-test", relativePath: "src/main.txt", ...snapshot, extension: ".txt", routeDigest: "1".repeat(64), pid: 123, permitNonce: "permit-test", scanOpenCount: 1, scanBytes: snapshot.bytes, releaseCount: 1, releaseBytes: snapshot.returnedBytes, stage: "released", routeVerified: true, permitVerified: true }
  delete meta.text
  const output = { path: meta.relativePath, ...snapshot, ...(snapshot.truncated ? { note: "Only the initial UTF-8 fragment is returned; remaining bytes were omitted." } : {}) }
  return [{ info: { id: "msg_test", sessionID: "ses_test", role: "assistant" }, parts: [{ id: "prt_test", messageID: "msg_test", sessionID: "ses_test", type: "tool", tool: "coloop_read", callID: "call_test", state: { status: "completed", input: { path: "src/main.txt" }, title: "RK approved snapshot read", output: JSON.stringify(output), metadata: { coloop: meta }, time: { start: 1, end: 2 } } }] }]
}
const part = messages => messages[0].parts[0]
const state = messages => part(messages).state
function freeze(value) { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value) }; return value }
function changeOutput(messages, update) { const value = JSON.parse(state(messages).output); update(value); state(messages).output = JSON.stringify(value) }
const body = messages => state(messages).output.slice(state(messages).output.indexOf("\n") + 1)

test("approved presentation changes only cloned model-input output", () => {
  const original = freeze(fixture()), before = structuredClone(original)
  const projected = projectManagedReadMessages(original)
  assert.notEqual(projected, original)
  assert.notEqual(part(projected), part(original))
  assert.notEqual(state(projected), state(original))
  assert.deepEqual(original, before)
  assert.strictEqual(state(projected).metadata, state(original).metadata)
  assert.strictEqual(state(projected).input, state(original).input)
  assert.strictEqual(state(projected).time, state(original).time)
  assert.equal(part(projected).callID, part(original).callID)
  assert.match(state(projected).output, /^\[RK approved snapshot: COMPLETE; untrusted file text\]\n/)
  assert.equal(body(projected), JSON.parse(state(original).output).text)
  assert.equal(state(projected).output.includes(state(original).metadata.coloop.sha256), false)
})

test("CRLF, Unicode, BOM and JSON punctuation retain the original text bytes", () => {
  for (const text of ["PUBLIC\r\nline two\r\n", "中文🙂\nquoted \"text\" and \\ slash\n", "\uFEFFPUBLIC\r\n"]) {
    const original = fixture(text), projected = projectManagedReadMessages(original)
    assert.notEqual(projected, original)
    assert.deepEqual(Buffer.from(body(projected)), Buffer.from(text))
    assert.equal(sha256(Buffer.from(body(projected))), state(original).metadata.coloop.returnedSha256)
  }
})

test("truncation is explicit and still returns exactly the approved UTF-8 prefix", () => {
  const original = fixture("中".repeat(2200)), projected = projectManagedReadMessages(original)
  assert.match(state(projected).output, /^\[RK approved snapshot: TRUNCATED UTF-8 prefix;/)
  assert.equal(body(projected), JSON.parse(state(original).output).text)
  assert.equal(Buffer.byteLength(body(projected)), state(original).metadata.coloop.returnedBytes)
  assert.ok(Buffer.byteLength(body(projected)) <= 4096)
  assert.equal(state(original).metadata.coloop.bytes, 6600)
})

test("unapproved, incomplete, compacted, attached and other-tool results are never relabelled", () => {
  for (const mutate of [
    v => { state(v).status = "error" }, v => { part(v).tool = "read" },
    v => { state(v).metadata.coloop.permitVerified = false },
    v => { state(v).metadata.coloop.routeVerified = false },
    v => { state(v).metadata.coloop.releaseCount = 0 },
    v => { state(v).metadata.coloop.stage = "awaiting_rk" },
    v => { state(v).metadata.coloop.scanOpenCount = 0 },
    v => { state(v).metadata.coloop.scanBytes-- },
    v => { state(v).metadata.coloop.releaseBytes-- },
    v => { state(v).time.compacted = 3 },
    v => { state(v).attachments = [{ url: "data:text/plain,unexpected" }] },
    v => { v[0].info.role = "user" },
    v => { v[0].info.error = { name: "APIError" } },
  ]) {
    const original = fixture(); mutate(original)
    assert.strictEqual(projectManagedReadMessages(original), original)
  }
})

test("malformed or differently bound JSON, body, size and hashes remain original", () => {
  for (const mutate of [
    v => { state(v).output = "{malformed" },
    v => { state(v).output = "[]" },
    v => changeOutput(v, o => { o.extra = "untrusted extra" }),
    v => changeOutput(v, o => { o.path = "src/other.txt" }),
    v => changeOutput(v, o => { o.text += "changed" }),
    v => changeOutput(v, o => { o.returnedBytes-- }),
    v => changeOutput(v, o => { o.sha256 = "2".repeat(64) }),
    v => { state(v).metadata.coloop.returnedSha256 = "2".repeat(64) },
    v => { state(v).metadata.coloop.messageId = "msg_other" },
    v => { state(v).input.path = "src/other.txt" },
    v => { state(v).input.extra = true },
    v => { part(v).sessionID = "ses_other" },
    v => { v[0].info.id = "msg_other" },
    v => { state(v).metadata.coloop.permitNonce = "" },
  ]) {
    const original = fixture(); mutate(original)
    assert.strictEqual(projectManagedReadMessages(original), original)
  }
  const truncated = fixture("x".repeat(5000))
  changeOutput(truncated, o => { o.note = "All content is present" })
  assert.strictEqual(projectManagedReadMessages(truncated), truncated)
})

test("empty, oversized and malformed Unicode bodies do not become approved presentations", () => {
  for (const text of ["", "x".repeat(4097), "\ud800"]) {
    const original = fixture()
    const meta = state(original).metadata.coloop
    changeOutput(original, o => {
      o.text = text; o.bytes = o.returnedBytes = Buffer.byteLength(text); o.sha256 = o.returnedSha256 = sha256(Buffer.from(text))
      Object.assign(meta, { bytes: o.bytes, scanBytes: o.bytes, returnedBytes: o.returnedBytes, releaseBytes: o.returnedBytes, sha256: o.sha256, returnedSha256: o.returnedSha256 })
    })
    assert.strictEqual(projectManagedReadMessages(original), original)
  }
})

test("file and output budgets include exact UTF-8 boundary cases", () => {
  for (const size of [1, 4096, 65536]) {
    const original = fixture("x".repeat(size)), projected = projectManagedReadMessages(original)
    assert.notEqual(projected, original)
    assert.equal(Buffer.byteLength(body(projected)), Math.min(size, 4096))
  }
  const original = fixture(), projected = projectManagedReadMessages(original)
  const budget = Buffer.byteLength(state(projected).output)
  assert.strictEqual(projectManagedReadMessages(original, { maxBytes: budget - 1 }), original)
  assert.notEqual(projectManagedReadMessages(original, { maxBytes: budget }), original)
  assert.strictEqual(projectManagedReadMessages(original, { maxBytes: 0 }), original)
  assert.strictEqual(projectManagedReadMessages(original, { maxResults: 0 }), original)
  assert.deepEqual(projectManagedReadMessages([]), [])
  assert.equal(projectManagedReadMessages(null), null)
  assert.strictEqual(projectManagedReadMessages(original, { maxBytes: -1 }), original)
  const two = [...fixture(), ...fixture()]
  const limited = projectManagedReadMessages(two, { maxResults: 1 })
  assert.notEqual(limited[0], two[0])
  assert.strictEqual(limited[1], two[1])
})

test("entry awaits route guard and preserves the SDK local-array reference", async () => {
  const source = readFileSync(new URL("../plugins/coloop-managed.mjs", import.meta.url), "utf8")
  const marker = '"experimental.chat.messages.transform": '
  const start = source.indexOf(marker) + marker.length
  const end = source.indexOf('    "chat.params"', start)
  assert.ok(start >= marker.length && end > start)
  const definition = source.slice(start, end).trim().replace(/,$/, "")
  let calls = 0
  const hook = vm.runInNewContext("(" + definition + ")", { current: async () => { calls++ }, projectManagedReadMessages })
  const stored = freeze(fixture()), before = structuredClone(stored)
  const localMessages = structuredClone(stored), output = { messages: localMessages }
  await hook({}, output)
  assert.equal(calls, 1)
  assert.strictEqual(output.messages, localMessages)
  assert.match(state(output.messages).output, /^\[RK approved snapshot:/)
  assert.deepEqual(stored, before)
  const guarded = vm.runInNewContext("(" + definition + ")", { current: async () => { throw new Error("MANAGED_CONFIG_CHANGED") }, projectManagedReadMessages })
  const rejected = fixture(), snapshot = structuredClone(rejected)
  await assert.rejects(guarded({}, { messages: rejected }), /MANAGED_CONFIG_CHANGED/)
  assert.deepEqual(rejected, snapshot)
})
