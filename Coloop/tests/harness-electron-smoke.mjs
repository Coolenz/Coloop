// Invoke with Electron RUN_AS_NODE after bundling harness-runtime.ts to the
// path in COLOOP_HARNESS_SMOKE_MODULE. Uses synthetic HTTP/SSE, no RK or cloud.
import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const { createHarnessRuntime } = await import(
  pathToFileURL(resolve(process.env.COLOOP_HARNESS_SMOKE_MODULE)).href
)
const home = await mkdtemp(join(tmpdir(), 'coloop-harness-electron-'))
let requests = 0
let calls = 0
const server = createServer(async (request, response) => {
  let raw = ''
  for await (const chunk of request) raw += chunk
  const body = JSON.parse(raw)
  requests++
  const done = body.messages.some((message) => message.role === 'tool')
  const delta = done
    ? { role: 'assistant', content: 'Electron Harness verified.' }
    : {
        role: 'assistant',
        tool_calls: [
          {
            index: 0,
            id: 'electron-tool',
            type: 'function',
            function: { name: 'coloop_echo', arguments: '{}' },
          },
        ],
      }
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  for (const [value, finish] of [
    [delta, null],
    [{}, done ? 'stop' : 'tool_calls'],
  ])
    response.write(
      'data: ' +
        JSON.stringify({
          id: 'electron-response',
          model: 'fixture',
          object: 'chat.completion.chunk',
          created: 1,
          choices: [{ index: 0, delta: value, finish_reason: finish }],
        }) +
        '\n\n',
    )
  response.end('data: [DONE]\n\n')
})
await new Promise((yes) => server.listen(0, '127.0.0.1', yes))
const runtime = createHarnessRuntime({
  id: 'electron-smoke',
  workspace: process.cwd(),
  home,
  runtimeResources: resolve('resources/harness'),
  nodePath: process.env.COLOOP_HARNESS_NODE,
  model: {
    provider: 'openai',
    id: 'fixture',
    apiKey: 'test',
    baseURL: `http://127.0.0.1:${server.address().port}/v1`,
  },
  instructions: 'Call coloop_echo once and report its result.',
  maxIterations: 3,
  tools: [
    {
      name: 'coloop_echo',
      description: 'Echo',
      parameters: { type: 'object' },
      execute() {
        calls++
        return { observed: true }
      },
    },
  ],
})
let report
try {
  const result = await runtime.run('Run the fixture tool.')
  report = {
    result,
    requests,
    calls,
    electron: process.versions.electron,
    node: process.versions.node,
    passed:
      result.content === 'Electron Harness verified.' &&
      result.finishReason === 'stop' &&
      calls === 1 &&
      requests === 2,
  }
  if (!report.passed) process.exitCode = 1
} catch (error) {
  report = {
    passed: false,
    error: error.stack,
    electron: process.versions.electron,
    node: process.versions.node,
  }
  process.exitCode = 1
} finally {
  await runtime.dispose()
  server.closeAllConnections()
  await new Promise((yes) => server.close(yes))
  await rm(home, { recursive: true, force: true })
}
if (process.env.COLOOP_HARNESS_SMOKE_REPORT)
  await writeFile(process.env.COLOOP_HARNESS_SMOKE_REPORT, JSON.stringify(report, null, 2))
console.log(JSON.stringify(report))
