import test from "node:test"
import assert from "node:assert/strict"
import WindowsDesktopPlugin from "../plugins/windows-desktop.mjs"

test("ordinary agents receive no Windows context or lease", async () => {
  const hook = await WindowsDesktopPlugin()
  const output = { parts: [{ type: "text", text: "ordinary task" }] }
  await hook["chat.message"]({ agent: "rk-local" }, output)
  assert.equal(output.parts[0].text, "ordinary task")
  await hook.event({ event: { type: "session.status", properties: {
    sessionID: "unrelated", status: { type: "busy" },
  } } })
})

test("Windows agent requires an explicit source root", async () => {
  const old = process.env.RK_AGENT_ROOT
  delete process.env.RK_AGENT_ROOT
  try {
    const hook = await WindowsDesktopPlugin()
    await assert.rejects(hook["chat.message"]({ agent: "rk-windows" }, {
      parts: [{ type: "text", text: "Windows task" }],
    }), /RK_AGENT_ROOT/)
  } finally {
    if (old === undefined) delete process.env.RK_AGENT_ROOT
    else process.env.RK_AGENT_ROOT = old
  }
})
