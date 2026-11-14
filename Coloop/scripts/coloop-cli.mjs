import { readFile } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { workspaceCacheEnvironment } from './with-workspace-cache.mjs'

const usage = `Coloop CLI

  coloop start [--executable PATH]
  coloop commands
  coloop help [group action]
  coloop status
  coloop watch [--interval 1000]
  coloop task wait TASK_ID [--timeout 120000]
  coloop auto-agent wait TASK_ID [--timeout 120000]
  coloop GROUP ACTION [--json JSON | --string TEXT | --file PATH | --stdin]
  coloop call CHANNEL [--args JSON_ARRAY]

Business commands return JSON. watch and both wait commands return JSON Lines.
General help is plain text; help for a specific command returns JSON Schema.
--stdin and --file accept one JSON value. --args accepts the positional argument array.
--data-dir selects the same profile as COLOOP_DATA_DIR.
--connection selects a local-control/connection.json file explicitly.
--timeout is in milliseconds; 0 disables the overall wait deadline. Default is 120000.
watch/wait still bound each status read to 120000 ms when --timeout is 0.
Use stdin or a protected file for passwords and API keys.
Exit codes: 0 success, 1 failure, 2 usage error, 3 timeout/unknown outcome.
`

class CliError extends Error {
  constructor(code, message, exitCode = 1) {
    super(message)
    this.code = code
    this.exitCode = exitCode
  }
}
const output = (value) => process.stdout.write(JSON.stringify(value) + '\n')
function json(value) {
  try {
    return JSON.parse(value.replace(/^\uFEFF/, ''))
  } catch {
    throw new CliError('INVALID_JSON', '输入不是有效 JSON', 2)
  }
}

function options(argv) {
  const parsed = { words: [], timeout: 120000, interval: 1000 }
  const valued = new Set([
    'json',
    'string',
    'file',
    'args',
    'connection',
    'data-dir',
    'timeout',
    'interval',
    'executable',
  ])
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index]
    if (!value.startsWith('--')) {
      parsed.words.push(value)
      continue
    }
    const key = value.slice(2)
    if (key === 'stdin' || key === 'help') {
      parsed[key] = true
      continue
    }
    if (!valued.has(key) || index + 1 === argv.length || argv[index + 1].startsWith('--'))
      throw new CliError('INVALID_OPTION', `无效选项 ${value}`, 2)
    parsed[key] = argv[++index]
  }
  for (const key of ['timeout', 'interval']) {
    parsed[key] = Number(parsed[key])
    if (
      !Number.isSafeInteger(parsed[key]) ||
      parsed[key] < (key === 'interval' ? 100 : 0) ||
      parsed[key] > 2147483647
    )
      throw new CliError('INVALID_OPTION', `${key} 的毫秒数无效`, 2)
  }
  if (
    ['stdin', 'json', 'string', 'file', 'args'].filter((key) => parsed[key] !== undefined).length >
    1
  )
    throw new CliError('INVALID_OPTION', '一次只能使用一种参数输入方式', 2)
  return parsed
}

async function readJsonInput(stream) {
  const chunks = []
  let size = 0
  for await (const chunk of stream) {
    size += chunk.length
    if (size > 32 * 1024 * 1024) throw new CliError('INPUT_TOO_LARGE', '输入超过 32 MiB', 2)
    chunks.push(chunk)
  }
  return json(Buffer.concat(chunks).toString('utf8'))
}

async function inputArgs(opts) {
  let value
  if (opts.stdin) {
    value = await readJsonInput(process.stdin)
  } else if (opts.file !== undefined) {
    value = await readJsonInput(createReadStream(resolve(opts.file)))
  } else if (opts.json !== undefined) value = json(opts.json)
  else if (opts.string !== undefined) value = opts.string
  else if (opts.args !== undefined) {
    const args = json(opts.args)
    if (!Array.isArray(args) || args.length > 1)
      throw new CliError('INVALID_ARGUMENTS', '--args 须为包含零个或一个参数的数组', 2)
    return args
  } else return []
  return [value]
}

async function connection(file) {
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT')
      throw new CliError('APP_UNAVAILABLE', '未找到本地控制连接，请先运行 coloop start')
    throw new CliError('CONNECTION_UNREADABLE', '无法读取本地控制连接文件，请检查路径和权限')
  }
  let saved
  let url
  try {
    saved = json(text)
    url = new URL(saved.url)
  } catch {
    throw new CliError('INVALID_CONNECTION', '本地控制连接文件无效')
  }
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    !url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/' ||
    typeof saved.token !== 'string' ||
    !/^[a-f0-9]{64}$/.test(saved.token)
  )
    throw new CliError('INVALID_CONNECTION', '本地控制连接文件无效')
  return { url, token: saved.token }
}

async function request(file, opts, command, args = []) {
  const { url, token } = await connection(file)
  const id = randomUUID()
  const payload = command ? JSON.stringify({ id, command, args }) : undefined
  if (payload && Buffer.byteLength(payload) > 32 * 1024 * 1024)
    throw new CliError('INPUT_TOO_LARGE', '请求超过 32 MiB', 2)
  let response
  try {
    response = await fetch(new URL(command ? '/v1/call' : '/v1/commands', url), {
      method: command ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: payload,
      redirect: 'error',
      signal: opts.timeout ? AbortSignal.timeout(opts.timeout) : undefined,
    })
    const result = await response.json()
    if (typeof result.ok !== 'boolean' || (command && response.ok && result.id !== id))
      throw new Error('INVALID_RESPONSE')
    return result
  } catch (error) {
    if (!command || command === 'app:get') {
      const timedOut = error.name === 'TimeoutError'
      throw new CliError(
        timedOut ? 'REQUEST_TIMEOUT' : 'CONTROL_UNAVAILABLE',
        '无法读取本地控制状态，请检查应用进程、版本和数据目录',
        timedOut ? 3 : 1,
      )
    }
    throw new CliError(
      'OUTCOME_UNKNOWN',
      `连接中断或请求超时，请查询状态确认执行结果。请求 ID ${id}`,
      3,
    )
  }
}

async function start(file, opts, dataDirectory) {
  try {
    const existing = await request(file, { ...opts, timeout: 1500 })
    if (existing.ok) {
      output({ ok: true, value: { running: true } })
      return
    }
    throw new CliError(existing.code ?? 'CONTROL_UNAVAILABLE', existing.error ?? '控制服务不可用')
  } catch (error) {
    if (!['APP_UNAVAILABLE', 'CONTROL_UNAVAILABLE', 'REQUEST_TIMEOUT'].includes(error.code))
      throw error
  }
  if (
    resolve(file).toLowerCase() !==
    resolve(
      dataDirectory ?? join(process.env.APPDATA ?? '', 'coloop'),
      'local-control',
      'connection.json',
    ).toLowerCase()
  )
    throw new CliError(
      'PROFILE_MISMATCH',
      '指定连接未就绪，启动时请使用与该连接路径对应的 --data-dir',
      2,
    )
  const executable =
    opts.executable ??
    process.env.COLOOP_EXECUTABLE ??
    join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Coloop', 'Coloop.exe')
  const env = workspaceCacheEnvironment('D:\\Coloop')
  if (dataDirectory) env.COLOOP_DATA_DIR = resolve(dataDirectory)
  const child = spawn(executable, ['--background'], {
    detached: true,
    stdio: 'ignore',
    // The GUI owns background visibility through --background. SW_HIDE in
    // STARTUPINFO would suppress its first explicit ShowWindow call on Windows.
    windowsHide: false,
    env,
  })
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve)
    child.once('error', () => reject(new CliError('START_FAILED', '无法启动指定 Coloop 安装程序')))
  })
  child.unref()
  const deadline = opts.timeout ? Date.now() + opts.timeout : Infinity
  while (Date.now() < deadline) {
    try {
      const ready = await request(file, { ...opts, timeout: 1500 })
      if (ready.ok) {
        output({ ok: true, value: { running: true } })
        return
      }
      throw new CliError(ready.code ?? 'CONTROL_UNAVAILABLE', ready.error ?? '控制服务不可用')
    } catch (error) {
      if (!['APP_UNAVAILABLE', 'CONTROL_UNAVAILABLE', 'REQUEST_TIMEOUT'].includes(error.code))
        throw error
    }
    await delay(500)
  }
  throw new CliError('START_TIMEOUT', 'Coloop 控制服务尚未就绪，请检查版本与数据目录', 3)
}

async function watch(file, opts, taskId, backgroundTask = false) {
  const deadline = taskId && opts.timeout ? Date.now() + opts.timeout : Infinity
  let previous
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now()
    const timeout = Math.max(1, Math.min(opts.timeout || 120000, remaining))
    const result = await request(file, { ...opts, timeout }, 'app:get')
    if (!result.ok) {
      output(result)
      process.exitCode = 1
      return
    }
    let value = result.value
    let done = false
    let success = true
    if (taskId && backgroundTask) {
      const task = value.autoAgentWork?.tasks.find((entry) => entry.id === taskId)
      if (!task) throw new CliError('TASK_NOT_FOUND', '后台任务记录不存在')
      value = task
      done = ['completed', 'unbound'].includes(task.state)
      success = task.state === 'completed'
    } else if (taskId) {
      const task = value.tasks.find((entry) => entry.id === taskId)
      const execution = [value.proactive, value.desktop].find((entry) => entry?.taskId === taskId)
      const mobileTask = value.violoop?.tasks.find((entry) => entry.id === taskId)
      if (!task && !execution && !mobileTask) throw new CliError('TASK_NOT_FOUND', '任务记录不存在')
      value = { task, execution, mobileTask }
      if (mobileTask) {
        done = [
          'completed',
          'answered',
          'cancelled',
          'failed',
          'unconfirmed',
          'interrupted',
        ].includes(mobileTask.state)
        success = ['completed', 'answered'].includes(mobileTask.state)
      } else {
        done = execution
          ? !execution.active &&
            [
              'completed',
              'failed',
              'cancelled',
              'blocked',
              'input_unknown',
              'unconfirmed',
            ].includes(execution.phase)
          : task.status !== 'running'
        success = execution ? execution.phase === 'completed' : task.status === 'completed'
      }
    }
    const serialized = JSON.stringify(value)
    if (serialized !== previous || done) {
      output({ ok: done ? success : true, value, ...(taskId ? { done } : {}) })
      previous = serialized
    }
    if (done) {
      process.exitCode = success ? 0 : 1
      return
    }
    await delay(Math.min(opts.interval, Math.max(0, deadline - Date.now())))
  }
  throw new CliError('WAIT_TIMEOUT', '等待超时，任务仍可继续执行，请查询当前状态', 3)
}

async function main() {
  const opts = options(process.argv.slice(2))
  const words = opts.words
  if (opts.help || !words.length || (words[0] === 'help' && words.length === 1)) {
    process.stdout.write(usage)
    return
  }
  const waiting = ['task', 'auto-agent'].includes(words[0]) && words[1] === 'wait'
  if (
    (['start', 'commands', 'status', 'watch'].includes(words[0]) && words.length !== 1) ||
    (waiting && words.length !== 3) ||
    (words[0] === 'call' && words.length !== 2)
  )
    throw new CliError('INVALID_ARGUMENTS', '命令参数数量无效，请查看 coloop help', 2)
  if (
    (['start', 'commands', 'help', 'watch'].includes(words[0]) || waiting) &&
    ['stdin', 'json', 'string', 'file', 'args'].some((key) => opts[key] !== undefined)
  )
    throw new CliError('INVALID_ARGUMENTS', '该命令不接收业务 JSON 参数', 2)
  if (opts.executable !== undefined && words[0] !== 'start')
    throw new CliError('INVALID_OPTION', '--executable 仅用于 start', 2)
  const dataDirectory = opts['data-dir'] ?? process.env.COLOOP_DATA_DIR
  const profile = dataDirectory ? resolve(dataDirectory) : join(process.env.APPDATA ?? '', 'coloop')
  const file = opts.connection ?? join(profile, 'local-control', 'connection.json')
  if (words[0] === 'start' && words.length === 1) return start(file, opts, dataDirectory)
  if (words[0] === 'commands' || words[0] === 'help') {
    const result = await request(file, opts)
    if (result.ok && words[0] === 'help') {
      result.value = result.value.filter((entry) => entry.name === words.slice(1).join(':'))
      if (!result.value.length) throw new CliError('COMMAND_NOT_FOUND', '命令不存在', 2)
    }
    output(result)
    if (!result.ok) process.exitCode = 1
    return
  }
  if (words[0] === 'watch' && words.length === 1) return watch(file, opts)
  if (words[0] === 'task' && words[1] === 'wait' && words.length === 3)
    return watch(file, opts, words[2])
  if (words[0] === 'auto-agent' && words[1] === 'wait' && words.length === 3)
    return watch(file, opts, words[2], true)
  const command =
    words[0] === 'status' && words.length === 1
      ? 'app:get'
      : words[0] === 'call' && words.length === 2
        ? words[1]
        : words.join(':')
  const args = await inputArgs(opts)
  if (
    ['screen:open', 'history:export', 'mobile:import-server', 'settings:task-workspace'].includes(
      command,
    ) &&
    typeof args[0] === 'string'
  )
    args[0] = resolve(args[0])
  const result = await request(file, opts, command, args)
  output(result)
  if (!result.ok)
    process.exitCode =
      result.code === 'INVALID_ARGUMENTS' || result.code === 'COMMAND_NOT_FOUND' ? 2 : 1
}

main().catch((error) => {
  output({
    ok: false,
    code: error.code ?? 'CLI_ERROR',
    error: error instanceof CliError ? error.message : '命令行操作失败，请检查输入文件和本地环境',
  })
  process.exitCode = error.exitCode ?? 1
})
