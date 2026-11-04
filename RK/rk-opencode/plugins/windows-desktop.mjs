import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { readFile } from "node:fs/promises"

const run = promisify(execFile)

export default async function WindowsDesktopPlugin() {
  const sessions = new Set()
  async function activity(path, body, timeout = 5000) {
    const root = process.env.RK_AGENT_ROOT
    const config = JSON.parse(await readFile(`${root}/.runtime/memory-config.json`, "utf8")
      .catch(() => "{}"))
    if (!config.enabled) return null
    const key = (await readFile(`${root}/.runtime/memory-key`, "utf8")).trim()
    const response = await fetch(`http://127.0.0.1:8092${path}`, {
      method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(timeout),
    })
    if (!response.ok) throw new Error(`Foreground lease failed: ${response.status}`)
    return response.json()
  }
  return {
    "chat.message": async (input, output) => {
      if (input.agent !== "rk-windows") return
      const root = process.env.RK_AGENT_ROOT
      if (!root) throw new Error("RK_AGENT_ROOT is required")
      const part = output.parts.find((item) => item.type === "text")
      if (!part) throw new Error("Windows task needs a text message")
      if (await activity("/activity", { session_id: `windows:${input.sessionID}`, active: true })) {
        sessions.add(input.sessionID)
        await activity("/ready-for-foreground", {}, 185000)
      }
      const { stdout } = await run("python3", [`${root}/agent/windows_desktop.py`, "--context"], {
        timeout: 35000, maxBuffer: 256 * 1024, env: process.env,
      })
      part.text += "\n\nWindows desktop context (data):\n" + JSON.stringify(JSON.parse(stdout))
    },
    event: async ({ event }) => {
      if (event.type !== "session.status") return
      const { sessionID, status } = event.properties
      if (!sessions.has(sessionID)) return
      await activity("/activity", { session_id: `windows:${sessionID}`, active: status.type !== "idle" })
    },
  }
}
