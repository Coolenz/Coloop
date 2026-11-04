// Explicit paid-provider check of the pinned, unmodified AgentTARS loop. No RK input.
import { app, safeStorage, net } from 'electron'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
app.setPath('userData', process.env.APPDATA + '/coloop')
app.on('window-all-closed', () => {})
async function main() {
  const output = process.env.COLOOP_TARS_OUTPUT
  if (!output || !process.env.COLOOP_TARS_LIB) throw Error('EXPLICIT_OUTPUT_AND_BUNDLE_REQUIRED')
  await mkdir(output, { recursive: false })
  let runtime
  try {
    const { createTarsRuntime } = await import(pathToFileURL(process.env.COLOOP_TARS_LIB).href)
    const profile = JSON.parse(await readFile(process.env.APPDATA + '/coloop/state.json', 'utf8'))
    if (profile.settings.provider.protocol !== 'openai')
      throw Error('OPENAI_COMPATIBLE_PROVIDER_REQUIRED')
    const apiKey = safeStorage.decryptString(Buffer.from(profile.encryptedKey, 'base64'))
    const nonce = 'tars-' + randomUUID().slice(0, 8)
    const events = [],
      requests = []
    let toolCalls = 0
    runtime = createTarsRuntime({
      id: randomUUID(),
      workspace: output,
      model: {
        provider: 'openai',
        id: profile.settings.provider.model,
        baseURL: profile.settings.provider.baseUrl,
        apiKey,
      },
      instructions:
        'Use coloop_probe exactly once. Report its returned token verbatim. Do not use any other tools.',
      tools: [
        {
          name: 'coloop_probe',
          description: 'Read the test token.',
          parameters: { type: 'object', properties: {}, additionalProperties: false },
          execute: () => {
            toolCalls++
            return { token: nonce }
          },
        },
      ],
      onEvent: (event) => events.push(event),
      maxIterations: 4,
      fetch: async (url, init) => {
        if (requests.length >= 4) throw Error('LIVE_CALL_LIMIT')
        const started = performance.now()
        const response = await net.fetch(url, init)
        requests.push({
          status: response.status,
          elapsedMs: Math.round(performance.now() - started),
        })
        return response
      },
    })
    const result = await runtime.run({
      input: 'Read the test token using coloop_probe and return it.',
      stream: false,
    })
    const success =
      toolCalls === 1 &&
      JSON.stringify(result).includes(nonce) &&
      events.some((e) => e.type === 'tool_result')
    const report = {
      ok: success,
      engine: '@agent-tars/core@0.3.1',
      model: profile.settings.provider.model,
      toolCalls,
      requests,
      result,
      eventTypes: events.map((e) => e.type),
    }
    const serialized = JSON.stringify(report, null, 2)
    if (serialized.includes(apiKey)) throw Error('CREDENTIAL_IN_REPORT')
    await writeFile(output + '/report.json', serialized)
    console.log(JSON.stringify({ ok: success, output, toolCalls, calls: requests.length }))
    if (!success) process.exitCode = 1
  } catch (error) {
    // Provider exceptions can contain request configuration. Store only a fixed code.
    await writeFile(
      output + '/failure.json',
      JSON.stringify({ ok: false, error: 'TARS_MODEL_LIVE_FAILED', name: error?.name }),
    )
    console.error('TARS_MODEL_LIVE_FAILED', error?.name)
    process.exitCode = 1
  } finally {
    await runtime?.dispose()
    app.exit(process.exitCode || 0)
  }
}
app
  .whenReady()
  .then(main)
  .catch(() => {
    console.error('TARS_MODEL_BOOT_FAILED')
    app.exit(1)
  })
