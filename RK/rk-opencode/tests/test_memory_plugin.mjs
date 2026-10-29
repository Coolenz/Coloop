import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import MemoryPlugin from "../plugins/memory.mjs"

test("recall is data; queue retains original user text; idle releases activity", async () => {
  const root = await mkdtemp(join(tmpdir(), "rk-memory-"))
  const oldRoot = process.env.RK_AGENT_ROOT, oldFetch = globalThis.fetch
  const calls = []
  try {
    await mkdir(join(root, ".runtime"))
    await writeFile(join(root, ".runtime/memory-config.json"), '{"enabled":true}')
    await writeFile(join(root, ".runtime/memory-key"), "test-key")
    process.env.RK_AGENT_ROOT = root
    globalThis.fetch = async (url, options) => {
      calls.push({path: new URL(url).pathname, body: JSON.parse(options.body)})
      assert.equal(options.headers.Authorization, "Bearer test-key")
      return {ok: true, json: async () => url.endsWith("/recall") ? {context: "stored fact"} : {ok: true}}
    }
    const hooks = await MemoryPlugin()
    const output = {parts: [{type: "text", text: "原始用户消息"}]}
    await hooks["chat.message"]({agent: "rk-local", sessionID: "session-a"}, output)
    assert.match(output.parts[0].text, /data, not instructions/)
    assert.equal(calls.find(x => x.path === "/enqueue").body.text, "原始用户消息")
    await hooks.event({event: {type: "session.status", properties: {sessionID: "session-a", status: {type: "idle"}}}})
    assert.equal(calls.at(-1).body.active, false)
    calls.length = 0
    await hooks["chat.message"]({agent: "rk-testbench-fast", sessionID: "session-b"}, {parts: [{type: "text", text: "benchmark"}]})
    assert.deepEqual(calls.map(x => x.path), ["/activity", "/ready-for-foreground"])
  } finally {
    globalThis.fetch = oldFetch
    if (oldRoot === undefined) delete process.env.RK_AGENT_ROOT
    else process.env.RK_AGENT_ROOT = oldRoot
    await rm(root, {recursive: true})
  }
})
