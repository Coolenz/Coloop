import test from "node:test"
import assert from "node:assert/strict"
import DesktopFastPlugin from "../plugins/desktop-fast.mjs"

test("ordinary OpenCode agents receive no injected desktop data", async () => {
  const hooks = await DesktopFastPlugin()
  const output = { parts: [{ type: "text", text: "Read a file" }] }
  await hooks["chat.message"]({ agent: "rk-local" }, output)
  assert.equal(output.parts[0].text, "Read a file")
})

test("fast agent cannot silently continue without its configured observation source", async () => {
  const old = process.env.RK_AGENT_ROOT
  delete process.env.RK_AGENT_ROOT
  try {
    const hooks = await DesktopFastPlugin()
    await assert.rejects(
      hooks["chat.message"]({ agent: "rk-desktop-fast" }, { parts: [{ type: "text", text: "Task" }] }),
      /RK_AGENT_ROOT/,
    )
  } finally {
    if (old === undefined) delete process.env.RK_AGENT_ROOT
    else process.env.RK_AGENT_ROOT = old
  }
})
