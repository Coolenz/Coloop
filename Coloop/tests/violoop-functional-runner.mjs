// Dispatch through the production renderer API. Business acceptance is audited separately.
import { chromium } from 'playwright-core'
import { mkdir, open, readFile, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { StringDecoder } from 'node:string_decoder'

const args = process.argv.slice(2)
for (let index = 1; index < args.length; index += 2) {
  if (!args[index].startsWith('--')) throw new Error('Expected a named runner option')
  if (!args[index + 1] || args[index + 1].startsWith('--'))
    throw new Error(`Supply a value for ${args[index]}`)
}
const option = (name, fallback) => {
  const index = args.indexOf(name)
  return index < 0 ? fallback : args[index + 1]
}
const caseId = args[0]
const workspace = option('--workspace')
const evidence = option('--evidence')
if (!caseId || !workspace || !evidence)
  throw new Error('Supply case ID, --workspace and --evidence')
if (!(await stat(workspace)).isDirectory())
  throw new Error('Workspace must be an existing directory')
const suite = JSON.parse(
  await readFile(new URL('./violoop-functional-taskset.json', import.meta.url), 'utf8'),
)
const scenario = suite.cases.find((item) => item.id === caseId)
if (!scenario) throw new Error('Unknown scenario')
const bindings = option('--instructions')
const prompt = option('--prompt-file')
  ? await readFile(option('--prompt-file'), 'utf8')
  : [scenario.prompt, bindings ? await readFile(bindings, 'utf8') : ''].filter(Boolean).join('\n\n')
const eventPath = join(
  option('--data-dir', join(process.env.APPDATA, 'coloop')),
  'tars-events',
  'events.jsonl',
)
const setupDeadline = Date.now() + 30000
let browser
while (!browser) {
  try {
    browser = await chromium.connectOverCDP(option('--cdp', 'http://127.0.0.1:19223'), {
      timeout: 3000,
    })
  } catch (error) {
    if (Date.now() >= setupDeadline) throw error
    await delay(300)
  }
}
let page
while (!page && Date.now() < setupDeadline) {
  page = browser
    .contexts()[0]
    ?.pages()
    .find(
      (item) =>
        item.url().includes('/renderer/index.html') && !item.url().includes('surface=control'),
    )
  if (!page) await delay(200)
}
if (!page) throw new Error('Production Coloop renderer not found')
await page.waitForFunction(() => !!window.coloop, undefined, { timeout: 20000 })

async function snapshot() {
  const result = await page.evaluate(() => window.coloop.snapshot())
  if (!result.ok) throw new Error(result.error)
  return result.value
}
async function execute(goal, directory, stopAfterCopies) {
  await mkdir(directory, { recursive: true })
  const followProactive = option('--follow-proactive')
  let cursor = followProactive
    ? 0
    : await stat(eventPath)
        .then((info) => info.size)
        .catch(() => 0)
  let tail = ''
  const decoder = new StringDecoder('utf8')
  let events = []
  let stopped
  let lastProgress
  let lastQuestionId
  let lastEventAt = Date.now()
  let stallRecorded = false
  const started = new Date().toISOString()
  let taskId = followProactive ?? option('--follow-task')
  if (followProactive) {
    const current = (await snapshot()).proactive
    if (current?.taskId !== taskId) throw new Error('Production proactive task UUID does not match')
    await writeFile(
      join(directory, 'dispatch.json'),
      JSON.stringify(
        {
          caseId,
          started,
          source: 'existing_proactive_task',
          taskId,
          current,
        },
        null,
        2,
      ),
    )
  } else if (taskId) {
    const schedule = (await snapshot()).schedules?.entries.find((entry) => entry.taskId === taskId)
    if (!schedule) throw new Error('Scheduled task UUID was not registered')
    await writeFile(
      join(directory, 'dispatch.json'),
      JSON.stringify({ caseId, started, source: 'existing_scheduled_task', schedule }, null, 2),
    )
  } else {
    const deviceDeadline = Date.now() + 30000
    while ((await snapshot()).device.status !== 'connected' && Date.now() < deviceDeadline)
      await delay(250)
    const dispatched = await page.evaluate((request) => window.coloop.dispatchTask(request), {
      prompt: goal,
      workspace: resolve(workspace),
      target: option('--target', 'cloud'),
      context: '',
      source: 'text',
      intent: 'execute',
      cloudFields: option('--cloud-fields')
        ? JSON.parse(await readFile(option('--cloud-fields'), 'utf8'))
        : undefined,
    })
    await writeFile(
      join(directory, 'dispatch.json'),
      JSON.stringify({ caseId, started, prompt: goal, dispatched }, null, 2),
    )
    if (!dispatched.ok) throw new Error(dispatched.error)
    taskId = dispatched.value.id
  }
  while (true) {
    const handle = await open(eventPath, 'r').catch((error) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    })
    if (handle)
      try {
        const size = (await handle.stat()).size
        if (size < cursor) throw new Error('Production event journal was truncated')
        if (size > cursor) {
          const bytes = Buffer.alloc(Math.min(size - cursor, 2 * 1024 * 1024))
          const { bytesRead } = await handle.read(bytes, 0, bytes.length, cursor)
          cursor += bytesRead
          const lines = (tail + decoder.write(bytes.subarray(0, bytesRead))).split('\n')
          tail = lines.pop()
          for (const line of lines) {
            const item = JSON.parse(line)
            if (item.sessionId === taskId) {
              events.push(item)
              lastEventAt = Date.now()
            }
          }
        }
      } finally {
        await handle.close()
      }
    const state = await snapshot()
    const proactive = state.proactive?.taskId === taskId ? state.proactive : undefined
    const terminalStatus = { completed: 'completed', cancelled: 'cancelled' }
    const task = followProactive
      ? {
          id: taskId,
          status: proactive?.active ? 'running' : (terminalStatus[proactive?.phase] ?? 'failed'),
          source: 'production_proactive_snapshot',
        }
      : state.tasks.find((item) => item.id === taskId)
    if (followProactive && !proactive)
      throw new Error('Production proactive task changed during audit')
    const copies = events.filter(
      (item) =>
        item.event.type === 'tool_result' &&
        item.event.name === 'coloop_workspace' &&
        item.event.content?.committed === true &&
        item.event.content?.source_sha256,
    ).length
    if (stopAfterCopies && !stopped && copies >= stopAfterCopies && proactive?.active) {
      const result = await page.evaluate(() => window.coloop.stopProactiveTask())
      stopped = {
        copies,
        timingMatched: copies === stopAfterCopies,
        result,
        at: new Date().toISOString(),
        beforeStop: proactive.phase,
      }
      await writeFile(join(directory, 'interruption.json'), JSON.stringify(stopped, null, 2))
    }
    const progress = JSON.stringify({
      taskId,
      status: task?.status,
      phase: proactive?.phase,
      copies,
    })
    if (progress !== lastProgress) {
      console.log(progress)
      lastProgress = progress
    }
    if (proactive?.question && proactive.question.question_id !== lastQuestionId) {
      lastQuestionId = proactive.question.question_id
      await writeFile(join(directory, 'question.json'), JSON.stringify(proactive.question, null, 2))
      console.log(JSON.stringify({ taskId, needsInput: proactive.question }))
      // The supervising acceptance session can answer through the normal product API.
    }
    if (!stallRecorded && Date.now() - lastEventAt >= 15 * 60 * 1000) {
      stallRecorded = true
      await writeFile(
        join(directory, 'stall.json'),
        JSON.stringify({ taskId, lastEventAt, proactive }, null, 2),
      )
      console.log(JSON.stringify({ taskId, stalled: true }))
    }
    if (task && task.status !== 'running' && !proactive?.active) {
      await writeFile(
        join(directory, 'events.jsonl'),
        events.map((item) => JSON.stringify(item)).join('\n') + '\n',
      )
      const result = {
        task,
        proactive,
        stopped,
        status:
          task.status === 'completed'
            ? 'EXECUTION_COMPLETED_PENDING_AUDIT'
            : task.status.toUpperCase(),
      }
      await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2))
      return result
    }
    await delay(stopAfterCopies && !stopped ? 100 : 400)
  }
}

try {
  const stopAfter = Number(option('--stop-after-copies', 0))
  if (!Number.isInteger(stopAfter) || stopAfter < 0)
    throw new Error('Invalid copy interruption count')
  let result = await execute(prompt, resolve(evidence), stopAfter)
  if (
    option('--resume', 'false') === 'true' &&
    result.stopped &&
    result.task.status === 'cancelled'
  ) {
    result = await execute(
      '继续上次中断的同一业务目标。先核对磁盘上的实际文件与摘要，保留正确产物并补齐，避免重复或覆盖。\n' +
        prompt,
      join(resolve(evidence), 'resume'),
      0,
    )
  }
  process.exitCode = result.task.status === 'completed' ? 0 : 2
} finally {
  await browser.close()
}
