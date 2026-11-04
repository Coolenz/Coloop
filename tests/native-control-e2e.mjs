import { _electron as electron } from '@playwright/test'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID, createHash } from 'node:crypto'
import assert from 'node:assert/strict'

// Real Windows OpenCode, production Hook and Electron. Model responses are
// explicitly synthetic, local-only fixtures; this is not model-quality QA.
const root = resolve(import.meta.dirname, '..')
const output = resolve(root, '.qa', `native-control-${Date.now()}`)
const nativeExecutable =
  process.env.COLOOP_OPENCODE_EXECUTABLE ||
  resolve(root, '.qa/opencode-native-1.19.5/package/bin/opencode.exe')
const plugin = process.env.COLOOP_OPENCODE_PLUGIN || 'D:/RK/rk-opencode/plugins/coloop-hook.mjs'
const nativeHome = join(output, 'native-home')
const directories = ['home', 'config', 'data', 'cache', 'state', 'appdata', 'localappdata'].map(
  (name) => join(nativeHome, name),
)
await Promise.all(directories.map((path) => mkdir(path, { recursive: true })))
const checks = [],
  modelRequests = [],
  nativeLog = [],
  pendingResponses = new Set(),
  fixtureTimers = new Set()
let app, source, sourceClosed, page, indicatorPage, nativeUrl, connectionPath, failure
const password = randomUUID()
const nativeAuth = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`
const token = randomUUID().replaceAll('-', '')
const initialText = `NATIVE_INITIAL_${token}`
const controlledText = `NATIVE_CONTROL_${token}: Continue this same session and return the supplied marker.`
const slowText = `NATIVE_SLOW_${token}: Wait for the slow local synthetic model response.`
const resumedText = `NATIVE_CONTROL_${token}: Explicitly resumed after the prior aborted turn; fresh request ${randomUUID()}.`

const wait = (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds))
async function until(predicate, label, timeout = 30000) {
  const end = Date.now() + timeout
  let lastError
  do {
    try {
      const value = await predicate()
      if (value) return value
    } catch (error) {
      lastError = error
    }
    if (sourceClosed !== undefined)
      throw new Error(`OpenCode exited (${sourceClosed}) while waiting for ${label}`)
    await wait(75)
  } while (Date.now() < end)
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`)
}
function json(response, value, status = 200) {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(value))
}
const mock = createServer(async (request, response) => {
  try {
    assert.equal(request.socket.remoteAddress, '127.0.0.1')
    const path = new URL(request.url, 'http://127.0.0.1').pathname
    if (request.method !== 'POST' || path !== '/v1/chat/completions') {
      json(response, { error: 'LOCAL_SYNTHETIC_ROUTE_ONLY' }, 404)
      return
    }
    let raw = ''
    for await (const chunk of request) {
      raw += chunk
      if (Buffer.byteLength(raw) > 1048576) throw new Error('FIXTURE_BODY_LIMIT')
    }
    const body = JSON.parse(raw)
    assert.equal(body.model, 'native-control-fixture')
    const userMessage = [...body.messages].reverse().find((message) => message.role === 'user')
    const userText =
      typeof userMessage?.content === 'string'
        ? userMessage.content
        : (userMessage?.content ?? []).map((part) => part.text ?? '').join('')
    const slow = userText.includes(`NATIVE_SLOW_${token}`)
    const answer = slow
      ? `SYNTHETIC_SLOW_ACK_${token}`
      : userText.includes(`NATIVE_CONTROL_${token}`)
        ? `SYNTHETIC_CONTROL_ACK_${token}`
        : `SYNTHETIC_INITIAL_ACK_${token}`
    const record = {
      index: modelRequests.length + 1,
      path,
      model: body.model,
      stream: body.stream === true,
      userTextSha256: createHash('sha256').update(userText).digest('hex'),
      slow,
      response: answer,
      sourceModelScripted: true,
      toolCallsProduced: 0,
      responseFinished: false,
      cancelled: false,
    }
    modelRequests.push(record)
    pendingResponses.add(response)
    let timer
    response.once('close', () => {
      pendingResponses.delete(response)
      record.cancelled = !record.responseFinished
      if (timer) {
        clearTimeout(timer)
        fixtureTimers.delete(timer)
      }
    })
    const deliver = () => {
      if (response.destroyed || response.writableEnded) return
      if (body.stream) {
        response.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-store',
          connection: 'keep-alive',
        })
        const chunk = (delta, finish_reason = null) =>
          response.write(
            `data: ${JSON.stringify({ id: `chatcmpl-${randomUUID()}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
          )
        chunk({ role: 'assistant', content: '' })
        chunk({ content: answer })
        chunk({}, 'stop')
        response.write('data: [DONE]\n\n')
        record.responseFinished = true
        response.end()
      } else {
        record.responseFinished = true
        json(response, {
          id: `chatcmpl-${randomUUID()}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: body.model,
          choices: [
            { index: 0, message: { role: 'assistant', content: answer }, finish_reason: 'stop' },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        })
      }
    }
    // The first controlled turn also stays active long enough to inspect the
    // real indicator before its genuine native idle event hides it.
    const delay = slow ? 30000 : userText.includes(`NATIVE_CONTROL_${token}`) ? 2500 : 0
    if (delay) {
      timer = setTimeout(deliver, delay)
      fixtureTimers.add(timer)
    } else deliver()
  } catch (error) {
    if (!response.headersSent) json(response, { error: String(error.message) }, 500)
    else response.destroy()
  }
})
const snapshot = async () => {
  const result = await page.evaluate(() => window.coloop.snapshot())
  assert.equal(result.ok, true, result.error)
  return result.value
}
const nativeRequest = async (path, body, expected = 200) => {
  const url = new URL(path, nativeUrl)
  url.searchParams.set('directory', root)
  const response = await fetch(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      authorization: nativeAuth,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(60000),
  })
  if (response.status !== expected)
    throw new Error(
      `Native ${path} returned ${response.status}: ${(await response.text()).slice(0, 1000)}`,
    )
  return expected === 204 ? undefined : response.json()
}
async function nativeIdle(sessionId) {
  const statuses = await nativeRequest('/session/status')
  return !statuses[sessionId] || statuses[sessionId].type === 'idle'
}
async function indicatorState() {
  indicatorPage ??= await until(async () => {
    for (const candidate of app.windows())
      if (candidate.url().includes('surface=control')) return candidate
  }, 'real indicator BrowserWindow')
  const result = await indicatorPage.evaluate(() => window.coloopControl.snapshot())
  assert.equal(result.ok, true, result.error)
  return result.value
}

try {
  await new Promise((resolveListen) => mock.listen(0, '127.0.0.1', resolveListen))
  const configPath = join(output, 'native-config.json')
  const config = {
    $schema: 'https://opencode.ai/config.json',
    autoupdate: false,
    share: 'disabled',
    enabled_providers: ['synthetic-local'],
    model: 'synthetic-local/native-control-fixture',
    small_model: 'synthetic-local/native-control-fixture',
    default_agent: 'native-control-qa',
    permission: { '*': 'deny' },
    compaction: { auto: false, prune: false },
    mcp: {},
    plugin: [pathToFileURL(plugin).href],
    provider: {
      'synthetic-local': {
        npm: '@ai-sdk/openai-compatible',
        name: 'Local synthetic control QA',
        options: {
          baseURL: `http://127.0.0.1:${mock.address().port}/v1`,
          apiKey: 'local-synthetic-fixture-only',
          timeout: 60000,
        },
        models: {
          'native-control-fixture': {
            name: 'Synthetic response fixture',
            tool_call: false,
            reasoning: false,
            limit: { context: 16384, output: 128 },
          },
        },
      },
    },
    agent: {
      title: { disable: true },
      summary: { disable: true },
      'native-control-qa': {
        mode: 'primary',
        description: 'Local-only synthetic acceptance fixture.',
        prompt: 'Answer only with the local response. Do not call any tools.',
        steps: 2,
        permission: { '*': 'deny' },
      },
    },
  }
  await writeFile(configPath, JSON.stringify(config, null, 2))
  // Reuse the project's already pinned pure-JS SDK in this isolated profile,
  // following its existing native Hook bootstrap; no global install occurs.
  const sdkCache = process.env.COLOOP_PLUGIN_SDK_CACHE || 'D:/RK/rk-opencode/.cache/plugin-sdk'
  for (const name of ['plugin', 'sdk']) {
    const dependency = JSON.parse(
      await readFile(join(sdkCache, 'node_modules/@opencode-ai', name, 'package.json'), 'utf8'),
    )
    assert.equal(dependency.version, '1.19.5')
  }
  await cp(sdkCache, join(directories[1], 'opencode'), { recursive: true })
  app = await electron.launch({
    executablePath: process.env.COLOOP_EXECUTABLE || undefined,
    args: process.env.COLOOP_EXECUTABLE ? [] : [root],
    cwd: root,
    env: {
      ...process.env,
      COLOOP_DATA_DIR: join(output, 'coloop-profile'),
      ELECTRON_RENDERER_URL: '',
    },
  })
  page = await app.firstWindow()
  await page.waitForSelector('.workspace-content')
  let current = await snapshot()
  assert.equal(current.coordinator.status, 'listening', current.coordinator.error)
  connectionPath = current.coordinator.connectionPath
  await readFile(connectionPath, 'utf8') // Existence only; no bearer credential is logged.
  const nativeEnv = {
    ...process.env,
    HOME: directories[0],
    USERPROFILE: directories[0],
    XDG_CONFIG_HOME: directories[1],
    XDG_DATA_HOME: directories[2],
    XDG_CACHE_HOME: directories[3],
    XDG_STATE_HOME: directories[4],
    APPDATA: directories[5],
    LOCALAPPDATA: directories[6],
    OPENCODE_CONFIG: configPath,
    COLOOP_HOOK_CONNECTION: connectionPath,
    OPENCODE_SERVER_USERNAME: 'opencode',
    OPENCODE_SERVER_PASSWORD: password,
    BUN_INSTALL_CACHE_DIR: join(nativeHome, 'bun-cache'),
    NO_COLOR: '1',
  }
  for (const flag of [
    'AUTOUPDATE',
    'MODELS_FETCH',
    'LSP_DOWNLOAD',
    'DEFAULT_PLUGINS',
    'PROJECT_CONFIG',
    'AUTOCOMPACT',
    'PRUNE',
    'CLAUDE_CODE',
  ])
    nativeEnv[`OPENCODE_DISABLE_${flag}`] = 'true'
  // OpenCode 1.19.5 treats --port 0 as a preference for 4096. Allocate a
  // genuinely random free loopback port first, as its existing bench does.
  const allocator = createServer()
  await new Promise((resolveListen) => allocator.listen(0, '127.0.0.1', resolveListen))
  const nativePort = allocator.address().port
  await new Promise((resolveClose) => allocator.close(resolveClose))
  source = spawn(
    nativeExecutable,
    ['serve', '--hostname', '127.0.0.1', '--port', String(nativePort), '--log-level', 'ERROR'],
    {
      cwd: root,
      env: nativeEnv,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  source.once('error', (error) => {
    sourceClosed = error.message
  })
  source.once('exit', (code) => {
    sourceClosed = code
  })
  const captureLog = (data) => {
    const value = data.toString()
    // Logs can contain only the test's isolated paths and synthetic content.
    if (nativeLog.join('').length < 262144)
      nativeLog.push(value.replaceAll(password, '[REDACTED_NATIVE_PASSWORD]'))
    const match = nativeLog.join('').match(/http:\/\/127\.0\.0\.1:\d+/)
    if (match) nativeUrl = match[0]
  }
  source.stdout.on('data', captureLog)
  source.stderr.on('data', captureLog)
  await until(() => nativeUrl, 'OpenCode ephemeral loopback port', 30000)
  const health = await until(async () => {
    const response = await fetch(`${nativeUrl}/global/health`, {
      headers: { authorization: nativeAuth },
      signal: AbortSignal.timeout(1000),
    })
    if (response.status !== 200) return false
    const result = await response.json()
    return result.healthy && result.version === '1.19.5' && result
  }, 'real OpenCode 1.19.5 health')
  const unauthenticated = await fetch(`${nativeUrl}/session?directory=${encodeURIComponent(root)}`)
  assert.equal(unauthenticated.status, 401)
  await writeFile(
    join(output, 'run-manifest.json'),
    JSON.stringify(
      {
        nativeExecutable,
        nativeExecutableSha256: createHash('sha256')
          .update(await readFile(nativeExecutable))
          .digest('hex'),
        plugin,
        pluginSha256: createHash('sha256')
          .update(await readFile(plugin))
          .digest('hex'),
        appMainSha256: createHash('sha256')
          .update(await readFile(join(root, 'out/main/index.js')))
          .digest('hex'),
        nativeConfigSha256: createHash('sha256')
          .update(await readFile(configPath))
          .digest('hex'),
        sdkLockSha256: createHash('sha256')
          .update(await readFile(join(sdkCache, 'package-lock.json')))
          .digest('hex'),
        sourceModelScripted: true,
        nativeHealth: health,
      },
      null,
      2,
    ),
  )
  checks.push({
    check: 'real Windows OpenCode 1.19.5 loopback serve with authentication and isolated config',
    passed: true,
    health,
    nativePid: source.pid,
  })
  console.log('PASS real Windows OpenCode startup and authentication')

  const session = await nativeRequest('/session', { title: 'Coloop native control acceptance' })
  assert.ok(session.id.startsWith('ses_'))
  const firstMessageId = `msg_${randomUUID().replaceAll('-', '')}`
  await nativeRequest(
    `/session/${session.id}/prompt_async`,
    { messageID: firstMessageId, parts: [{ type: 'text', text: initialText }] },
    204,
  )
  await until(
    async () => {
      const messages = await nativeRequest(`/session/${session.id}/message`)
      return (
        messages.some(
          (message) =>
            message.info.role === 'assistant' &&
            message.parts.some(
              (part) => part.type === 'text' && part.text === `SYNTHETIC_INITIAL_ACK_${token}`,
            ),
        ) && (await nativeIdle(session.id))
      )
    },
    'initial genuine OpenCode turn using the synthetic model',
    45000,
  )
  const controlledSession = await until(
    async () =>
      (await snapshot()).sessionControl?.sessions.find(
        (item) => item.host === 'windows' && item.connected && item.state === 'idle',
      ),
    'native plugin Windows session registration',
    10000,
  )
  assert.equal(controlledSession.workspace.toLowerCase(), root.toLowerCase())
  assert.deepEqual(controlledSession.capabilities, ['send_message', 'abort_turn'])
  checks.push({
    check: 'real native Hook registers source session after its actual initial turn',
    passed: true,
    sessionId: session.id,
    sessionHandle: controlledSession.handle,
  })
  console.log('PASS real native initial turn and plugin registration')

  const commandId = randomUUID()
  const submitted = await page.evaluate((input) => window.coloop.controlSession(input), {
    commandId,
    sessionHandle: controlledSession.handle,
    action: 'send_message',
    text: controlledText,
  })
  assert.equal(submitted.ok, true, submitted.error)
  const command = await until(
    async () =>
      (await snapshot()).sessionControl.commands.find(
        (item) => item.commandId === commandId && item.status === 'confirmed',
      ),
    'real native message delivery confirmation',
    15000,
  )
  assert.ok(command.messageId)
  const inNative = await nativeRequest(`/session/${session.id}/message/${command.messageId}`)
  assert.equal(inNative.info.id, command.messageId)
  assert.equal(inNative.info.sessionID, session.id)
  assert.equal(inNative.info.role, 'user')
  assert.ok(inNative.parts.some((part) => part.type === 'text' && part.text === controlledText))
  const activeIndicator = await indicatorState()
  assert.equal(activeIndicator.mode, 'controlling')
  await indicatorPage.locator('.control-indicator[data-mode="controlling"]').waitFor()
  await indicatorPage.screenshot({
    path: join(output, 'native-controlling.png'),
    omitBackground: true,
  })
  await until(
    async () => {
      const messages = await nativeRequest(`/session/${session.id}/message`)
      return (
        messages.some(
          (message) =>
            message.info.role === 'assistant' &&
            message.info.parentID === command.messageId &&
            message.parts.some(
              (part) => part.type === 'text' && part.text === `SYNTHETIC_CONTROL_ACK_${token}`,
            ),
        ) && (await nativeIdle(session.id))
      )
    },
    'same native session follow-up answer',
    15000,
  )
  await until(
    async () =>
      !(await snapshot()).sessionControl.controlActive &&
      (await indicatorState()).mode === 'hidden',
    'source idle ends the real indicator',
    10000,
  )
  checks.push({
    check:
      'DesktopApi command reaches original native session with stable message ID, exact text, follow-up answer and genuine indicator lifecycle',
    passed: true,
    command,
  })
  console.log('PASS real native controlled follow-up and indicator lifecycle')

  const slowCommandId = randomUUID()
  const slowSubmitted = await page.evaluate((input) => window.coloop.controlSession(input), {
    commandId: slowCommandId,
    sessionHandle: controlledSession.handle,
    action: 'send_message',
    text: slowText,
  })
  assert.equal(slowSubmitted.ok, true, slowSubmitted.error)
  await until(
    () => modelRequests.find((request) => request.slow),
    'real source enters its slow model turn',
    10000,
  )
  await until(
    async () =>
      (await snapshot()).sessionControl.commands.some(
        (item) => item.commandId === slowCommandId && item.status === 'confirmed',
      ),
    'slow command accepted by native session',
    10000,
  )
  assert.equal((await indicatorState()).mode, 'controlling')
  await indicatorPage.getByRole('button', { name: 'Stop', exact: true }).click()
  await until(
    async () => {
      const state = (await snapshot()).sessionControl
      return (
        state.stopped &&
        !state.controlActive &&
        state.commands.some(
          (item) => item.action === 'abort_turn' && item.status === 'confirmed',
        ) &&
        (await nativeIdle(session.id))
      )
    },
    'indicator stop consumed by genuine native abort and source idle',
    12000,
  )
  await until(
    async () => (await indicatorState()).mode === 'hidden',
    'stopped indicator hides after confirmation',
    5000,
  )
  assert.equal(modelRequests.find((request) => request.slow).responseFinished, false)
  await until(
    () => modelRequests.find((request) => request.slow).cancelled,
    'source abort cancels the in-flight synthetic HTTP response',
    3000,
  )
  const stoppedSnapshot = await snapshot()
  assert.equal(stoppedSnapshot.tasks.length, 0)
  checks.push({
    check:
      'real indicator stop sends native abort, confirms source idle and hides only after confirmation',
    passed: true,
    abort: stoppedSnapshot.sessionControl.commands.find((item) => item.action === 'abort_turn'),
    sourceIdle: await nativeIdle(session.id),
  })
  console.log('PASS real native abort through indicator stop')

  await until(
    async () =>
      (await snapshot()).sessionControl.sessions.find(
        (item) => item.handle === controlledSession.handle,
      )?.state === 'idle',
    'aborted turn leaves original source session reusable',
    5000,
  )
  const resumed = await page.evaluate(() => window.coloop.resumeSessionControl())
  assert.equal(resumed.ok, true, resumed.error)
  const resumedCommandId = randomUUID()
  const resumedSubmitted = await page.evaluate((input) => window.coloop.controlSession(input), {
    commandId: resumedCommandId,
    sessionHandle: controlledSession.handle,
    action: 'send_message',
    text: resumedText,
  })
  assert.equal(resumedSubmitted.ok, true, resumedSubmitted.error)
  const resumedCommand = await until(
    async () =>
      (await snapshot()).sessionControl.commands.find(
        (item) => item.commandId === resumedCommandId && item.status === 'confirmed',
      ),
    'resumed command accepted by same native session',
    10000,
  )
  const resumedMessage = await nativeRequest(
    `/session/${session.id}/message/${resumedCommand.messageId}`,
  )
  assert.equal(resumedMessage.info.sessionID, session.id)
  assert.ok(resumedMessage.parts.some((part) => part.type === 'text' && part.text === resumedText))
  await until(
    async () => {
      const messages = await nativeRequest(`/session/${session.id}/message`)
      return (
        messages.some(
          (message) =>
            message.info.role === 'assistant' &&
            message.info.parentID === resumedCommand.messageId &&
            message.parts.some(
              (part) => part.type === 'text' && part.text === `SYNTHETIC_CONTROL_ACK_${token}`,
            ),
        ) && (await nativeIdle(session.id))
      )
    },
    'same original session completes a fresh turn after explicit resume',
    15000,
  )
  await until(
    async () =>
      !(await snapshot()).sessionControl.controlActive &&
      (await indicatorState()).mode === 'hidden',
    'resumed native idle hides indicator',
    10000,
  )
  const finalSnapshot = await snapshot()
  assert.equal(
    finalSnapshot.hooks.activityErrors,
    0,
    'desktop-only Hook must not attempt unavailable RK activity leases',
  )
  checks.push({
    check:
      'explicit resume after abort reuses original native session, fresh message and response; no RK connection required',
    passed: true,
    command: resumedCommand,
    hookActivityErrors: finalSnapshot.hooks.activityErrors,
  })
  console.log('PASS explicit resume and same native session reuse after abort')
  await writeFile(join(output, 'final-snapshot.json'), JSON.stringify(finalSnapshot, null, 2))
} catch (error) {
  failure = error
  console.error(`FAIL ${error.message}`)
  if (page) {
    await writeFile(
      join(output, 'failure-snapshot.json'),
      JSON.stringify(await snapshot().catch(() => null), null, 2),
    )
    await page.screenshot({ path: join(output, 'failure-main.png') }).catch(() => {})
  }
} finally {
  // Stop only this test's owned processes. No real model, board or shell tool
  // is ever started, and neither the user profile nor global packages change.
  if (source && sourceClosed === undefined) {
    source.kill()
    await Promise.race([new Promise((resolveExit) => source.once('exit', resolveExit)), wait(5000)])
  }
  for (const timer of fixtureTimers) clearTimeout(timer)
  for (const response of pendingResponses) response.destroy()
  mock.closeAllConnections()
  await new Promise((resolveClose) => mock.close(resolveClose))
  await app?.close().catch(() => {})
  await writeFile(join(output, 'native-output.log'), nativeLog.join(''))
  await writeFile(join(output, 'model-requests.json'), JSON.stringify(modelRequests, null, 2))
  const result = {
    passed: !failure,
    sourceModelScripted: true,
    sourceRuntime: 'real Windows OpenCode 1.19.5',
    plugin,
    checks,
    ...(failure ? { error: failure.message, stack: failure.stack } : {}),
    modelRequests: modelRequests.length,
    producedToolCalls: 0,
    nativeProcessExited: sourceClosed !== undefined,
    output,
  }
  await writeFile(join(output, 'results.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result, null, 2))
}
if (failure) process.exitCode = 1
