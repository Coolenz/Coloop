// Real RK inference through the official SDK. This probe never sends HID input.
import { app, safeStorage } from 'electron'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'

app.disableHardwareAcceleration()
app.setPath('userData', join(process.env.APPDATA, 'coloop'))
app.on('window-all-closed', () => {})
app
  .whenReady()
  .then(async () => {
    const output = process.env.COLOOP_RK_MODEL_OUTPUT
    if (!output || !process.env.COLOOP_RK_MODEL_LIB)
      throw new Error('EXPLICIT_PROBE_PATHS_REQUIRED')
    await mkdir(output, { recursive: true })
    let board, runtime
    const events = [],
      requests = []
    let toolCalls = 0
    try {
      const lib = await import(pathToFileURL(process.env.COLOOP_RK_MODEL_LIB).href)
      const directory = join(process.env.APPDATA, 'coloop')
      const state = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8'))
      const auto = JSON.parse(await readFile(join(directory, 'auto-connection.json'), 'utf8'))
      const password = safeStorage.decryptString(Buffer.from(auto.encryptedPassword, 'base64'))
      board = new lib.BoardGateway(() => {})
      await board.connect(state.settings.board, password)
      const token = 'RK_TOOL_' + randomUUID().slice(0, 8)
      runtime = lib.createTarsRuntime({
        id: randomUUID(),
        workspace: output,
        model: lib.rkTarsModel,
        instructions:
          '你是本地工具助手。coloop_probe只允许调用一次。请检查messages中的历史：如最新Tool结果已包含token，直接回复该token，不再调用任何工具；尚无工具结果时调用coloop_probe。',
        tools: [
          {
            name: 'coloop_probe',
            description: '读取测试标记。',
            parameters: { type: 'object', properties: {}, additionalProperties: false },
            execute: () => {
              toolCalls++
              return { token }
            },
          },
        ],
        fetch: lib.createRkTarsFetch(async (system, messages, signal, maxTokens) => {
          const start = performance.now()
          const answer = await board.privacyConversation(system, messages, signal, maxTokens)
          requests.push({
            elapsed_ms: performance.now() - start,
            system_bytes: Buffer.byteLength(system),
            content_bytes: Buffer.byteLength(JSON.stringify(messages)),
            answer,
          })
          await writeFile(join(output, 'requests.json'), JSON.stringify(requests, null, 2))
          return answer
        }),
        maxIterations: 6,
        onEvent: (event) => events.push(event),
      })
      const result = await runtime.run({
        input: '请使用工具读取测试标记并告诉我实际结果。',
        stream: false,
      })
      const report = {
        passed: toolCalls === 1 && result.finishReason === 'stop' && result.content.includes(token),
        toolCalls,
        result,
        requests,
        event_types: events.map((e) => e.type),
      }
      await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2))
      console.log(
        JSON.stringify({ passed: report.passed, toolCalls, calls: requests.length, output }),
      )
      process.exitCode = report.passed ? 0 : 1
    } catch (error) {
      await writeFile(
        join(output, 'failure.json'),
        JSON.stringify({ passed: false, name: error.name, message: error.message }, null, 2),
      )
      console.log(JSON.stringify({ passed: false, error: error.message }))
      process.exitCode = 1
    } finally {
      await runtime?.dispose()
      await board?.disconnect()
      app.exit(process.exitCode || 0)
    }
  })
  .catch(() => app.exit(1))
