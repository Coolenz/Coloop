import { app, safeStorage, session, clipboard } from 'electron'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { randomUUID, createHash } from 'node:crypto'
const output = process.env.COLOOP_TARS_OUTPUT,
  root = 'D:/Coloop'
app.setPath('userData', process.env.APPDATA + '/coloop')
app.on('window-all-closed', () => {})
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function main() {
  let indicator,
    board,
    agent,
    bridge,
    capture,
    ocr,
    leases,
    lab,
    passive,
    key = '',
    exitCode = 1
  const events = [],
    states = [],
    observations = [],
    clips = [],
    calls = [],
    baseline = new Map(),
    saves = new Map()
  const qaTag = 'qa:' + randomUUID().replaceAll('-', '')
  const save = (name, value) => {
    const text = JSON.stringify(value, null, 2)
    if (key && text.includes(key)) throw Error('KEY_IN_ARTIFACT')
    const pending = (saves.get(name) ?? Promise.resolve())
      .catch(() => {})
      .then(() => writeFile(output + '/' + name, text))
    saves.set(name, pending)
    return pending
  }
  const until = async (fn, seconds = 300) => {
    const deadline = Date.now() + seconds * 1000
    while (Date.now() < deadline) {
      const value = await fn()
      if (value) return value
      await delay(100)
    }
    throw Error('LIVE_WAIT_TIMEOUT')
  }
  try {
    const lib = await import(pathToFileURL(process.env.COLOOP_TARS_LIB).href)
    const profile = JSON.parse(await readFile(process.env.APPDATA + '/coloop/state.json', 'utf8'))
    if (profile.settings.provider.protocol !== 'openai') throw Error('PROVIDER_UNSUPPORTED')
    key = safeStorage.decryptString(Buffer.from(profile.encryptedKey, 'base64'))
    const network = session.fromPartition('tars-live-' + randomUUID())
    const title = 'Coloop TARS USB Lab ' + qaTag.slice(-8),
      exe = output + '/ProactiveTextLab.exe'
    await mkdir(output + '/lab')
    await promisify(execFile)(
      process.env.WINDIR + '/Microsoft.NET/Framework64/v4.0.30319/csc.exe',
      [
        '/nologo',
        '/target:winexe',
        '/out:' + exe.replaceAll('/', '\\'),
        '/reference:System.Windows.Forms.dll',
        '/reference:System.Drawing.dll',
        (root + '/tests/ProactiveTextLab.cs').replaceAll('/', '\\'),
      ],
      { windowsHide: true },
    )
    lab = spawn(exe, [output + '/lab', title], { stdio: 'ignore' })
    const identity = await until(async () => {
      try {
        return (await readFile(output + '/lab/identity.txt', 'utf8')).trim().split(/\r?\n/)
      } catch {
        return null
      }
    }, 15)
    ocr = new lib.OcrEngine(
      () => 'D:/RK',
      root + '/resources/rapidocr-worker.py',
      () => {},
    )
    capture = new lib.WindowsObservationCapture({
      excludedBounds: () => {
        const bounds = indicator?.getBounds()
        return bounds ? [bounds] : []
      },
      recognize: (png, signal) => ocr.recognize(png, signal),
    })
    const observe = async () => {
      const meta = await capture.metadata()
      if (meta.process_id !== lab.pid || meta.window_id !== identity[1])
        throw Error('LAB_NOT_FOREGROUND')
      const view = await capture.capture()
      if (!view) throw Error('NO_LAB_FRAME')
      observations.push(view)
      await save('observations.json', observations)
      return view
    }
    leases = new lib.ClipboardLeaseService(root + '/resources/clipboard-lease.ps1')
    board = new lib.BoardGateway(() => {})
    await save(
      'device.json',
      await board.connect(
        lib.importRkBoard('D:/RK/config/board.json'),
        process.env.RK_BOARD_PASSWORD,
      ),
    )
    const input = async (op, view, value) =>
      op === 'clipboard.verify'
        ? capture.verifyText(view, value.action.text)
        : op === 'completion.verify'
          ? value.evidence_mode === 'control_state'
            ? capture.verifyControlState(view, value.expected_state)
            : value.evidence_mode === 'visible_text'
              ? capture.verifyVisibleText(view, value.expected_text)
              : capture.verifyCurrentText(view, value.expected_text)
          : op === 'input.guard'
            ? capture.guard(view, value.action)
            : capture.validate(view, value.action)
    bridge = new lib.RkTarsBridge({
      executorScript: root + '/resources/rk-execution-adapter.py',
      memoryScript: root + '/resources/rk-memory-worker.py',
      supportScript: root + '/resources/rk-proactive-agent.py',
      namespace: qaTag,
      openRuntime: (source) => board.openDesktopRuntime(source),
      input,
      clipboard: async (op, value) => {
        const hash = async () =>
          createHash('sha256')
            .update(await clipboard.readText())
            .digest('hex')
        if (op === 'clipboard.prepare') baseline.set(value.task_id, await hash())
        const result = await leases.call(op, value)
        clips.push({
          op,
          result,
          ...(op === 'clipboard.finish'
            ? {
                restoredHashMatches:
                  result.status === 'restored' && (await hash()) === baseline.get(value.task_id),
              }
            : {}),
        })
        await save('clipboard.json', clips)
        return result
      },
      releaseClipboard: (id) => leases.releaseTask(id),
      prepareInput: async () => {},
      onMemorySaved: (id, saved) => agent.memorySaved(id, saved),
      onDisconnected: () => agent?.disconnected(),
      onEvent: (event) => {
        events.push(event)
        void save('rk-events.json', events).catch(() => {})
      },
    })
    agent = new lib.TarsAgentService({
      workspace: output,
      model: () => ({
        provider: 'openai',
        id: profile.settings.provider.model,
        baseURL: profile.settings.provider.baseUrl,
        apiKey: key,
      }),
      fetch: async (url, init) => {
        if (calls.length >= 48) throw Error('PAID_CLOUD_CALL_LIMIT')
        const row = { at: Date.now(), request: JSON.parse(init.body) }
        calls.push(row)
        const response = await network.fetch(url, init)
        row.status = response.status
        await save('cloud-requests.json', calls)
        return response
      },
      available: () => true,
      assertStart: () => {},
      observe,
      input,
      prepareInput: async () => {},
      execution: bridge,
      memory: bridge,
      onObservationRetry: (id) => passive?.retryObservation(id),
      onChange: () => {
        if (agent) {
          states.push({ ...agent.snapshot(), at_ms: performance.now() })
          void save('states.json', states).catch(() => {})
          if (indicator) {
            const state = agent.snapshot()
            const display = state.active
              ? { mode: 'controlling', phase: state.phase, detail: state.phase }
              : state.phase === 'completed'
                ? {
                    mode: 'completed',
                    detail: 'Task completed',
                    content: state.summary,
                    expanded: true,
                  }
                : null
            if (display) void indicator.update(display).catch(() => {})
          }
        }
      },
    })
    const hashes = {}
    for (const name of ['rk-proactive-agent.py', 'rk-execution-adapter.py', 'rk-memory-worker.py'])
      hashes[name] = createHash('sha256')
        .update(await readFile(root + '/resources/' + name))
        .digest('hex')
    for (const name of [
      'src/main/services/tars-agent.ts',
      'src/main/infrastructure/tars-runtime.ts',
      'src/main/infrastructure/rk-tars-bridge.ts',
      'src/main/infrastructure/foreground-observation.ts',
    ])
      hashes[name] = createHash('sha256')
        .update(await readFile(root + '/' + name))
        .digest('hex')
    await save('manifest.json', {
      engine: '@agent-tars/core@0.3.1',
      officialLoop: true,
      scope:
        'production OCR/island/TARS service; real cloud, RK USB, native readback, separate memory process with real Qwen+Mem0 QA namespace; isolated WinForms document',
      qaTag,
      hashes,
      labPid: lab.pid,
      labWindow: identity[1],
    })
    await delay(Number(process.env.COLOOP_LAB_ACTIVATION_DELAY || 60000))
    const initial = await observe()
    if (!initial.ocr_text.includes('产品发布计划')) throw Error('OCR_TITLE_NOT_READ')
    passive = new lib.ForegroundObservationService({
      capture: (signal) => capture.captureFrame(signal),
      recognize: (frame, signal) => capture.recognize(frame, signal),
      isOcrBusy: () => ocr.busy,
      canObserve: () => !agent.active,
      isInteracting: () => indicator?.isInteracting ?? false,
      onInvalidated: () => agent.cancelObservation(),
      onObservation: (view) => agent.submitObservation(view),
      onError: (error) => {
        events.push({ type: 'qa.passive_error', value: { error: error.message } })
      },
    })
    const started = performance.now()
    passive.start()
    const suggestion = await until(() => {
      if (agent.snapshot().error) throw Error(agent.snapshot().error)
      return agent.snapshot().suggestion
    }, 90)
    const recommendationMs = Math.round(performance.now() - started)
    await save('suggestion.json', { ...suggestion, recommendationMs })
    indicator = new lib.ControlIndicatorWindow({
      preloadPath: root + '/out/preload/control.cjs',
      rendererPath: root + '/out/renderer/index.html',
      onStop: () => agent.stop(),
      onOpenMain: () => {},
      onAcceptSuggestion: (id) => agent.acceptSuggestion(id),
      onRememberTarget: () => capture.rememberTarget(),
      onRestoreTarget: () => capture.restoreTarget(),
    })
    await indicator.update({
      mode: 'suggestion',
      title: suggestion.title.slice(0, 100),
      content: suggestion.text,
      suggestionId: suggestion.suggestion_id,
      expanded: true,
    })
    await until(() => agent.active, 90)
    passive.dispose()
    const answered = new Set()
    await until(() => {
      const state = agent.snapshot()
      if (state.question && !answered.has(state.question.question_id)) {
        answered.add(state.question.question_id)
        agent.answer(
          state.taskId,
          state.question.question_id,
          '硬件产品。保留原标题，在当前文档末尾追加三条简短中文大纲即可，不需要保存文件。',
        )
      }
      return !state.active && state.taskId
    })
    await save('first-result.json', agent.snapshot())
    if (agent.snapshot().phase !== 'completed') throw Error('FIRST_TASK_NOT_COMPLETED')
    const firstText = await readFile(output + '/lab/actual-text.txt', 'utf8')
    if (!firstText.startsWith('产品发布计划') || firstText === '产品发布计划')
      throw Error('DOCUMENT_NOT_APPENDED')
    await until(() => agent.snapshot().memorySaved !== undefined, 360)
    if (agent.snapshot().memorySaved !== true) throw Error('MEMORY_NOT_SAVED')
    await capture.restoreTarget()
    await agent.startTask(
      '先从RK记忆目录检索并读取上一任务的流程记忆正文，然后在当前文档末尾仅追加一行“记忆已调用”。保留所有已有内容，不保存文件。',
    )
    await until(() => !agent.active)
    await save('second-result.json', agent.snapshot())
    if (agent.snapshot().phase !== 'completed') throw Error('SECOND_TASK_NOT_COMPLETED')
    await until(() => agent.snapshot().memorySaved !== undefined, 360)
    if (agent.snapshot().memorySaved !== true) throw Error('SECOND_MEMORY_NOT_SAVED')
    const finalText = await readFile(output + '/lab/actual-text.txt', 'utf8')
    if (!finalText.includes('记忆已调用') || !finalText.startsWith(firstText))
      throw Error('SECOND_DOCUMENT_NOT_APPENDED')
    const officialEvents = (await readFile(output + '/tars-events/events.jsonl', 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line).event)
    if (
      !officialEvents.some(
        (event) => event.type === 'tool_result' && event.name === 'coloop_memory_get',
      )
    )
      throw Error('MEMORY_NOT_READ_THROUGH_TARS')
    if (
      officialEvents.filter(
        (event) => event.type === 'tool_result' && event.name === 'coloop_execute',
      ).length < 2
    )
      throw Error('OFFICIAL_EXECUTION_EVENTS_MISSING')
    if (
      clips.filter((row) => row.op === 'clipboard.finish').length < 2 ||
      clips.filter((row) => row.op === 'clipboard.finish').some((row) => !row.restoredHashMatches)
    )
      throw Error('CLIPBOARD_NOT_RESTORED')
    const modelCalls = events
      .filter((event) => event.type === 'model.timing')
      .map((event) => event.value)
    if (
      modelCalls.length < 2 ||
      modelCalls.some((row) => row.stage !== 'memory_review' || !row.success)
    )
      throw Error('LOCAL_MODEL_BOUNDARY_FAILED')
    const taskIds = [...new Set(states.map((row) => row.taskId).filter(Boolean))]
    const timings = taskIds.map((taskId) => {
      const rows = states.filter((row) => row.taskId === taskId)
      return {
        taskId,
        elapsedMs: Math.round(
          rows.find((row) => row.phase === 'completed').at_ms -
            rows.find((row) => row.phase === 'queued').at_ms,
        ),
      }
    })
    await save('result.json', {
      ok: true,
      engine: '@agent-tars/core@0.3.1',
      recommendationMs,
      cloudCalls: calls.length,
      timings,
      modelCalls,
      firstText,
      finalText,
      qaTag,
      clipboardRestored: true,
      officialEventTypes: [...new Set(officialEvents.map((event) => event.type))],
    })
    exitCode = 0
  } catch (error) {
    await save('failure.json', {
      error: error.message,
      phase: agent?.snapshot(),
      cloudCalls: calls.length,
    })
    console.log(JSON.stringify({ ok: false, error: error.message }))
  } finally {
    indicator?.dispose()
    passive?.dispose()
    await agent?.dispose().catch(() => {})
    await bridge?.dispose().catch(() => {})
    await leases?.dispose().catch(() => {})
    capture?.dispose()
    ocr?.dispose()
    board?.disconnect()
    lab?.kill()
    await Promise.allSettled([...saves.values()])
    console.log(JSON.stringify({ exitCode, output, cloudCalls: calls.length }))
    app.exit(exitCode)
  }
}
app
  .whenReady()
  .then(main)
  .catch(() => app.exit(1))
