// Real isolated Codex CLI lifecycle, synthetic local model. Does not create a Desktop chat.
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { resolve, join, relative, isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'

const root = resolve(import.meta.dirname, '..')
const cache = join(root, '.cache', 'auto-work-native-cli')
await mkdir(cache, { recursive: true })
const profile = await mkdtemp(join(cache, 'run-'))
const reportDirectory = join(root, '.qa', 'auto-work-native-cli')
await mkdir(reportDirectory, { recursive: true })
const token = randomUUID() + randomUUID()
const events = []
let calls = 0
let stops = 0
const continuedText = 'Coloop controlled hook test: continue once and finish.'
const server = createServer(async (req, res) => {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const body = Buffer.concat(chunks).toString('utf8')
  if (req.url === '/v1/auto-work/hooks') {
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401)
      res.end()
      return
    }
    const event = JSON.parse(body).payload
    events.push({
      name: event.hook_event_name,
      session: event.session_id,
      turn: event.turn_id,
      continued: event.stop_hook_active,
      promptMatchesContinuation: event.prompt === continuedText,
    })
    const output =
      event.hook_event_name === 'Stop' && ++stops === 1
        ? { decision: 'block', reason: continuedText }
        : {}
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ version: 1, output }))
    return
  }
  if (req.url?.includes('/responses')) {
    calls++
    const id = `resp_${calls}`
    const itemId = `msg_${calls}`
    const item = {
      id: itemId,
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [
        { type: 'output_text', text: 'Native lifecycle fixture finished.', annotations: [] },
      ],
    }
    const response = {
      id,
      object: 'response',
      created_at: Math.floor(Date.now() / 1000),
      status: 'completed',
      model: 'fixture',
      output: [item],
      usage: { input_tokens: 5, output_tokens: 5, total_tokens: 10 },
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    for (const event of [
      { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { ...item, status: 'in_progress', content: [] },
      },
      {
        type: 'response.output_text.delta',
        item_id: itemId,
        output_index: 0,
        content_index: 0,
        delta: 'Native lifecycle fixture finished.',
      },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response },
    ])
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    res.end()
    return
  }
  res.writeHead(404)
  res.end('{}')
})
await new Promise((resolveReady) => server.listen(0, '127.0.0.1', resolveReady))
const url = `http://127.0.0.1:${server.address().port}`
const connectionPath = join(profile, 'connection.json')
await writeFile(connectionPath, JSON.stringify({ url, token }))
const quote = (value) => `'${value.replaceAll("'", "''")}'`
const command = `powershell.exe -NoLogo -NoProfile -NonInteractive -Command "& ${quote(process.execPath)} ${quote(join(root, 'resources', 'auto-agent-work-hook.mjs'))} '--connection' ${quote(connectionPath)}"`
const hooks = Object.fromEntries(
  [
    'SessionStart',
    'UserPromptSubmit',
    'PreModelRequest',
    'PostModelRequest',
    'Stop',
    'SessionEnd',
  ].map((name) => [
    name,
    [{ hooks: [{ type: 'command', command, commandWindows: command, timeout: 3 }] }],
  ]),
)
await writeFile(join(profile, 'hooks.json'), JSON.stringify({ hooks }))
await writeFile(
  join(profile, 'config.toml'),
  `model = "fixture"\nmodel_provider = "fixture"\n[model_providers.fixture]\nname = "Local lifecycle fixture"\nbase_url = "${url}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n[features]\nhooks = true\n`,
)
let child
let output = ''
let error = ''
let exitCode
try {
  exitCode = await new Promise((resolveExit, reject) => {
    child = spawn(
      process.env.COLOOP_NATIVE_CODEX ?? 'codex',
      [
        '--no-daemon',
        '--dangerously-bypass-hook-trust',
        'exec',
        '--skip-git-repo-check',
        '--ephemeral',
        '--json',
        '-C',
        profile,
        'Reply with one short sentence.',
      ],
      {
        windowsHide: true,
        cwd: profile,
        env: {
          ...process.env,
          CODEX_HOME: profile,
          OPENAI_API_KEY: '',
          XDG_CACHE_HOME: join(profile, 'cache'),
          XDG_CONFIG_HOME: join(profile, 'config'),
          XDG_DATA_HOME: join(profile, 'data'),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    const deadline = setTimeout(() => {
      child.kill()
      reject(new Error('NATIVE_CLI_TIMEOUT'))
    }, 45_000)
    child.stdout.on('data', (chunk) => {
      output += chunk
      if (output.length > 1_000_000) child.kill()
    })
    child.stderr.on('data', (chunk) => {
      error += chunk
      if (error.length > 1_000_000) child.kill()
    })
    child.on('error', reject)
    child.on('exit', (code) => {
      clearTimeout(deadline)
      resolveExit(code)
    })
  })
  assert.equal(exitCode, 0, error.slice(-3000))
  assert(
    events.some((event) => event.name === 'SessionStart'),
    'Native SessionStart was not observed',
  )
  assert.equal(stops, 2, 'Stop must continue exactly once')
  assert.equal(calls, 2, 'Two native model requests expected')
  assert(
    events.some((event) => event.name === 'Stop' && event.continued === true),
    'Native continuation flag missing',
  )
  console.log(
    JSON.stringify({
      passed: true,
      scope: 'isolated_cli_synthetic_model_not_desktop',
      calls,
      stops,
      events: events.map((event) => event.name),
      promptSubmitForContinuation: events.some((event) => event.promptMatchesContinuation),
    }),
  )
} finally {
  await writeFile(
    join(reportDirectory, 'report.json'),
    JSON.stringify(
      {
        at: new Date().toISOString(),
        exitCode,
        scope: 'isolated_cli_synthetic_model_not_desktop',
        calls,
        stops,
        events,
        hookTrust: 'explicit_invocation_bypass_for_reviewed_fixture_only_no_persisted_trust',
        stderr: error.slice(-5000),
        stdout: output.slice(-10000),
      },
      null,
      2,
    ),
  )
  server.closeAllConnections()
  await new Promise((resolveClosed) => server.close(resolveClosed))
  const inside = relative(cache, profile)
  if (!inside || isAbsolute(inside) || inside.startsWith('..'))
    throw new Error('UNSAFE_TEST_PROFILE_PATH')
  await rm(profile, { recursive: true, force: true })
}
