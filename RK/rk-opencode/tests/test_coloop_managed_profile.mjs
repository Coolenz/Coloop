/** CPU-only tests of the real entry validator, without source SDK or NPU. */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import vm from "node:vm"
import test from "node:test"
import { canonical } from "../agent/coloop_managed_core.mjs"

const source = readFileSync(new URL("../plugins/coloop-managed.mjs", import.meta.url), "utf8")
const start = source.indexOf("  function validateEffective(config) {")
const end = source.indexOf("  async function current()", start)
assert.ok(start > 0 && end > start)
const root = "/home/cat/rk-opencode"
const privacy = { "X-RK-Privacy": "metadata-only", "X-RK-Cache": "off" }
const validatorContext = {
  Array, canonical,
  PROVIDER: "rkllm", MODEL: "qwen35-4b-rkllm", AGENT: "rk-coloop-managed",
  BASE: "http://127.0.0.1:8088/v1", privacy,
  permissions: { "*": "deny", coloop_read: "ask", question: "allow" },
  expectedPlugins: ["coloop-hook.mjs", "coloop-managed.mjs"].map(name => `file://${root}/plugins/${name}`),
  same: (left, right) => canonical(left) === canonical(right),
  onlyKeys: (value, fields) => value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every(key => fields.includes(key)),
  fail: code => { throw new Error(code) },
}
const createValidator = model => vm.runInNewContext("(" + source.slice(start, end).trim() + ")", { ...validatorContext, MODEL: model })
const validator = createValidator("qwen35-4b-rkllm")
const config = JSON.parse(readFileSync(new URL("../opencode-coloop-managed.json", import.meta.url), "utf8").replaceAll("{env:RK_AGENT_ROOT}", root))

test("fixed managed profile permits absent or empty instructions only", () => {
  assert.doesNotThrow(() => validator(config))
  assert.doesNotThrow(() => validator({ ...config, instructions: [] }))
})

test("real entry rejects local and remote instructions before use", () => {
  for (const instructions of [["AGENTS.md"], ["/private/local.md"], ["https://example.invalid/instructions.md"], [""], null, "AGENTS.md"]) {
    assert.throws(() => validator({ ...config, instructions }), /UNSAFE_MANAGED_INSTRUCTIONS/)
  }
})

test("launcher pins external skills and project configuration off", () => {
  const launcher = readFileSync(new URL("../scripts/coloop-managed.sh", import.meta.url), "utf8")
  const flags = launcher.match(/for flag in \(([^\n]+)\):\r?\n env\['OPENCODE_DISABLE_'\+flag\]='true'/)
  assert.ok(flags, "actual fixed disable-flag loop must remain present")
  for (const name of ["EXTERNAL_SKILLS", "CLAUDE_CODE", "PROJECT_CONFIG"]) assert.ok(flags[1].includes(`'${name}'`))
})

test("another enrolled local model retains route pinning and all permission checks", () => {
  const changed = structuredClone(config)
  changed.model = changed.small_model = "rkllm/qwen3-8b-rkllm"
  changed.provider.rkllm.models = { "qwen3-8b-rkllm": Object.values(changed.provider.rkllm.models)[0] }
  const next = createValidator("qwen3-8b-rkllm")
  assert.doesNotThrow(() => next(changed))
  assert.throws(() => validator(changed), /UNSAFE_MANAGED_CONFIGURATION/)
  for (const mutate of [
    v => { v.permission.read = "allow" },
    v => { v.provider.rkllm.options.baseURL = "https://cloud.invalid/v1" },
    v => { v.provider.rkllm.models["qwen3-8b-rkllm"].headers["X-RK-Privacy"] = "raw" },
    v => { v.small_model = config.small_model },
  ]) {
    const unsafe = structuredClone(changed)
    mutate(unsafe)
    assert.throws(() => next(unsafe), /UNSAFE_MANAGED_/)
  }
})
