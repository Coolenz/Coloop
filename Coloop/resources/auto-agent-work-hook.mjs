// Native Codex lifecycle transport. This process never runs model inference or shell commands.
import { readFile } from 'node:fs/promises'
import { request } from 'node:http'
import { randomUUID } from 'node:crypto'

/*
 * Bounded stdin drain adapted from oh-my-codex readBoundedStdin; the native
 * single-JSON-line stdout contract follows writeNativeHookJsonStdout.
 * Upstream: Yeachan-Heo/oh-my-codex @ 509a299d586b48f145c2c7a7baac8ce08d01a015
 * plugins/oh-my-codex/hooks/codex-native-hook.mjs
 * src/scripts/codex-native-hook.ts
 * Changes: Coloop's 64 KiB limit, always drain oversized input, advisory failure,
 * and emit only a validated Stop continuation from the authenticated task ledger.
 *
 * MIT License
 * Copyright (c) 2026 Yeachan-Heo
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
const MAX_BYTES = 65_536
async function readBoundedStdin() {
  const chunks = []
  let storedBytes = 0
  let oversized = false
  for await (const rawChunk of process.stdin) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk)
    if (oversized) continue
    const remaining = MAX_BYTES - storedBytes
    if (chunk.length > remaining) {
      if (remaining > 0) chunks.push(chunk.subarray(0, remaining))
      storedBytes += Math.max(remaining, 0)
      oversized = true
      continue // Drain the writer instead of closing its pipe with EPIPE.
    }
    chunks.push(chunk)
    storedBytes += chunk.length
  }
  return { input: Buffer.concat(chunks), oversized }
}
function writeNativeHookJsonStdout(output) {
  process.stdout.write(`${JSON.stringify(output)}\n`)
}
const events = new Set(['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
  'PermissionRequest', 'PreModelRequest', 'PostModelRequest', 'PreCompact', 'PostCompact',
  'SubagentStart', 'SubagentStop', 'Stop', 'Interrupt'])
const allowed = new Set(['session_id', 'hook_event_name', 'cwd', 'turn_id', 'agent_id', 'tool_use_id',
  'tool_name', 'prompt', 'last_assistant_message', 'tool_input', 'tool_response', 'model', 'status',
  'error', 'source', 'stop_hook_active'])

async function main() {
  const args = process.argv.slice(2)
  if (args.length !== 2 || args[0] !== '--connection') throw new Error('INVALID_ARGUMENTS')
  const connection = JSON.parse(await readFile(args[1], 'utf8'))
  const endpoint = new URL(connection.url)
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || !endpoint.port ||
      endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/' ||
      typeof connection.token !== 'string' || connection.token.length < 32 || connection.token.length > 256)
    throw new Error('INVALID_CONNECTION')
  const { input, oversized } = await readBoundedStdin()
  if (oversized) throw new Error('INPUT_TOO_LARGE')
  const native = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(input))
  if (!events.has(native.hook_event_name)) throw new Error('UNSUPPORTED_EVENT')
  const payload = Object.fromEntries(Object.entries(native).filter(([key]) => allowed.has(key)))
  // Bound tool output without silently truncating prompts or pending operation identities.
  for (const key of ['tool_input', 'tool_response']) {
    if (payload[key] !== undefined && Buffer.byteLength(JSON.stringify(payload[key])) > 16_384)
      payload[key] = { omitted: true, reason: 'hook_payload_limit' }
  }
  const body = JSON.stringify({ version: 1, invocationId: randomUUID(), emittedAt: Date.now(), payload })
  if (Buffer.byteLength(body) > MAX_BYTES) throw new Error('INPUT_TOO_LARGE')
  const result = await new Promise((resolve, reject) => {
    const req = request(new URL('/v1/auto-work/hooks', endpoint), {
      method: 'POST', agent: false,
      headers: { authorization: `Bearer ${connection.token}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    }, res => {
      const response = []; let bytes = 0
      res.on('data', chunk => { bytes += chunk.length; if (bytes > 16_384) res.destroy(new Error('RESPONSE_TOO_LARGE')); else response.push(chunk) })
      res.on('error', reject)
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error('HOOK_UNAVAILABLE'))
        try { resolve(JSON.parse(Buffer.concat(response).toString('utf8'))) } catch { reject(new Error('INVALID_RESPONSE')) }
      })
    })
    const deadline = setTimeout(() => req.destroy(new Error('HOOK_TIMEOUT')), 700)
    req.on('close', () => clearTimeout(deadline))
    req.on('error', reject)
    req.end(body)
  })
  // No generic output pass-through: this adapter cannot grant permissions or rewrite tool input.
  const output = result?.output
  if (native.hook_event_name === 'Stop' && output?.decision === 'block' &&
      typeof output.reason === 'string' && output.reason.trim() && Buffer.byteLength(output.reason) <= 8192) {
    writeNativeHookJsonStdout({ decision: 'block', reason: output.reason })
  } else writeNativeHookJsonStdout({})
}

// Hook transport failure is advisory. It never fabricates a successful task or an approval.
const lifetime = setTimeout(() => { writeNativeHookJsonStdout({}); process.exit(0) }, 900)
main().catch(() => { writeNativeHookJsonStdout({}) }).finally(() => clearTimeout(lifetime))
