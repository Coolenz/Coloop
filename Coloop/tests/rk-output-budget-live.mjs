// Real RK comparison. Tools operate only on this probe's isolated files.
import { mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'

const root = resolve(import.meta.dirname, '..')
if (!process.versions.electron) {
  const { build } = await import('esbuild')
  const output = resolve(root, '.qa', 'rk-output-budget-' + Date.now())
  await mkdir(output, { recursive: true })
  const library = join(output, 'runtime.mjs')
  await build({
    stdin: {
      contents: `export { BoardGateway } from './src/main/infrastructure/board'; export { createHarnessRuntime } from './src/main/infrastructure/harness-runtime'; export { rkTarsModel, createRkTarsFetch } from './src/main/infrastructure/rk-tars-model';`,
      resolveDir: root,
      loader: 'ts',
    },
    outfile: library,
    bundle: true,
    packages: 'external',
    platform: 'node',
    format: 'esm',
    loader: { '.py': 'text' },
    logLevel: 'silent',
  })
  await writeFile(
    join(output, 'baseline-compaction.mjs'),
    execFileSync('git', ['show', '33b62ff:resources/harness/coloop-compaction.mjs'], { cwd: root }),
  )
  const child = spawn(
    join(root, 'node_modules/electron/dist/electron.exe'),
    [import.meta.filename],
    {
      cwd: root,
      windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, COLOOP_BUDGET_OUTPUT: output },
      stdio: 'inherit',
    },
  )
  process.exitCode = await new Promise((resolveExit, reject) => {
    child.once('error', reject)
    child.once('exit', (code) => resolveExit(code ?? 1))
  })
  await rm(library, { force: true })
  await rm(join(output, 'baseline-compaction.mjs'), { force: true })
} else {
  const { app, safeStorage } = await import('electron')
  app.disableHardwareAcceleration()
  app.setPath('userData', join(process.env.APPDATA, 'coloop'))
  app.on('window-all-closed', () => {})
  app
    .whenReady()
    .then(async () => {
      const output = process.env.COLOOP_BUDGET_OUTPUT
      const report = { scope: 'Real RK; isolated file tools; no paid model or HID', cases: [] }
      let board
      try {
        const lib = await import(pathToFileURL(join(output, 'runtime.mjs')).href)
        const state = JSON.parse(
          await readFile(join(process.env.APPDATA, 'coloop/state.json'), 'utf8'),
        )
        const connection = JSON.parse(
          await readFile(join(process.env.APPDATA, 'coloop/auto-connection.json'), 'utf8'),
        )
        board = new lib.BoardGateway(() => {})
        const password = safeStorage.decryptString(
          Buffer.from(connection.encryptedPassword, 'base64'),
        )
        const device = await board.connect(state.settings.board, password)
        report.capacity = board.localCapacity()
        report.ready = device.qwenReady
        if (!device.qwenReady) throw new Error(device.modelServiceError ?? 'RK_NOT_READY')
        await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2))
        console.log(JSON.stringify({ output, capacity: report.capacity }))
        for (const mode of (process.env.COLOOP_BUDGET_MODES ?? 'baseline,native-budget').split(
          ',',
        )) {
          for (const scenario of (
            process.env.COLOOP_BUDGET_CASES ?? 'short,files,compression,resume'
          ).split(',')) {
            const home = join(output, mode + '-' + scenario)
            const resources = join(home, 'resources')
            await mkdir(resources, { recursive: true })
            await copyFile(
              join(root, 'resources/harness/coloop-plugin.mjs'),
              join(resources, 'coloop-plugin.mjs'),
            )
            await copyFile(
              mode === 'baseline'
                ? join(output, 'baseline-compaction.mjs')
                : join(root, 'resources/harness/coloop-compaction.mjs'),
              join(resources, 'coloop-compaction.mjs'),
            )
            const names = [
              '甲部门原始报销记录.txt',
              '乙部门原始报销记录.txt',
              '需完整保留末级名称的长路径记录.txt',
            ]
            for (const name of names) await writeFile(join(home, name), '真实文件核验 ' + name)
            const calls = [],
              operations = [],
              events = []
            let runtime,
              interrupted = false,
              result,
              failure
            const budget =
              mode === 'baseline' || mode === 'explicit'
                ? 1024
                : report.capacity.defaultOutputTokens
            const fetcher = lib.createRkTarsFetch(async (system, messages, signal, maxTokens) => {
              const summary = messages.at(-1)?.content.includes('[Coloop local checkpoint]')
              if (
                scenario === 'resume' &&
                !interrupted &&
                operations.some((item) => item.operation === 'copy') &&
                !summary
              ) {
                interrupted = true
                runtime.abort()
                throw new DOMException('Probe interruption after durable tool result', 'AbortError')
              }
              const started = Date.now()
              const value = await board.privacyConversationResult(
                system,
                messages,
                signal,
                maxTokens,
              )
              calls.push({
                summary,
                budget: maxTokens,
                finishReason: value.finishReason,
                elapsedMs: Date.now() - started,
                outputBytes: Buffer.byteLength(value.text),
              })
              return value
            }, report.capacity)
            const options = {
              id: randomUUID(),
              home,
              workspace: home,
              runtimeResources: resources,
              nodePath: join(root, '.cache/node-runtime/node.exe'),
              model: {
                ...lib.rkTarsModel,
                contextWindow: report.capacity.contextWindow,
                maxOutputTokens: budget,
                maximumOutputTokens: report.capacity.maximumOutputTokens,
              },
              maxTokens: budget,
              maxIterations: 16,
              instructions:
                scenario === 'short'
                  ? '按用户要求简短回复。'
                  : '用中文完成用户要求。文件工具只处理提供的文件。先list，再逐个copy，最后verify。已有复制回执的文件无需再次复制。verify成功后简短报告。',
              tools: [
                {
                  name: 'coloop_files',
                  description: '列出源文件、逐个复制、核验结果。',
                  parameters: {
                    type: 'object',
                    properties: {
                      operation: { type: 'string', enum: ['list', 'copy', 'verify'] },
                      name: { type: 'string' },
                    },
                    required: ['operation'],
                  },
                  execute: async ({ operation, name }) => {
                    operations.push({ operation, name })
                    if (operation === 'list') return { files: names }
                    if (operation === 'copy') {
                      if (!names.includes(name)) throw new Error('UNAUTHORIZED_FIXTURE_FILE')
                      const target = join(home, '已归档-' + name)
                      const previous = await readFile(target).catch(() => undefined)
                      if (previous) return { alreadyCopied: true, name }
                      await copyFile(join(home, name), target)
                      return {
                        copied: name,
                        ...(scenario === 'compression'
                          ? {
                              evidence:
                                'Verified source bytes and committed destination; preserve exact file name. '.repeat(
                                  50,
                                ),
                            }
                          : {}),
                      }
                    }
                    if (operation !== 'verify') throw new Error('UNKNOWN_OPERATION')
                    const checks = await Promise.all(
                      names.map(async (name) => {
                        const target = await readFile(join(home, '已归档-' + name)).catch(
                          () => undefined,
                        )
                        return !!target && target.equals(await readFile(join(home, name)))
                      }),
                    )
                    return { verified: checks.every(Boolean) }
                  },
                },
              ],
              fetch: fetcher,
              onEvent: (event) => events.push(event),
            }
            const started = Date.now()
            try {
              runtime = lib.createHarnessRuntime(options)
              const prompt =
                scenario === 'short'
                  ? '仅回复“本地模型正常”。'
                  : '把工具列出的全部源文件逐一复制并核验，保留完整文件名。' +
                    (scenario === 'compression' ? ' Reference audit facts: '.repeat(260) : '')
              result = await runtime.run(prompt)
              await runtime.dispose()
              if (interrupted) {
                runtime = lib.createHarnessRuntime({ ...options, resume: true })
                result = await runtime.run('从持久记录继续，核对已有复制，完成剩余文件和verify。')
              }
            } catch (error) {
              failure = error.message
            } finally {
              await runtime?.dispose()
            }
            const copied = await Promise.all(
              names.map((name) =>
                readFile(join(home, '已归档-' + name))
                  .then(() => true)
                  .catch(() => false),
              ),
            )
            report.cases.push({
              mode,
              scenario,
              budget,
              finishReason: result?.finishReason,
              result: result?.content,
              failure,
              interrupted,
              copied,
              operations,
              calls,
              elapsedMs: Date.now() - started,
              summaries: events.filter((event) => event.event?.type === 'compaction/summary')
                .length,
              compactionErrors: events
                .filter((event) => event.event?.type === 'compaction/end' && event.event.data.error)
                .map((event) => event.event.data.error),
            })
            await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2))
            console.log(
              JSON.stringify({
                output,
                mode,
                scenario,
                finishReason: result?.finishReason,
                failure,
                copied,
                calls: calls.length,
              }),
            )
            await rm(home, { recursive: true, force: true })
          }
        }
      } catch (error) {
        report.blocked = error.message
        console.log(JSON.stringify({ output, blocked: error.message }))
      } finally {
        await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2))
        await board?.disconnect()
        app.exit(report.blocked ? 1 : 0)
      }
    })
    .catch((error) => {
      console.error(error.message)
      app.exit(1)
    })
}
