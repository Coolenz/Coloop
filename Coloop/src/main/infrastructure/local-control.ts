import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { z } from 'zod'
import { publishConnection } from './coordinator-connection'
import { errorMessage } from '../domain/errors'
import type { CommandRegistry } from '../services/command-registry'

const requestSchema = z
  .object({
    id: z.string().uuid(),
    command: z.string().min(1).max(100),
    args: z.array(z.unknown()).max(1).default([]),
  })
  .strict()
const maxBody = 32 * 1024 * 1024

function reply(response: ServerResponse, status: number, value: unknown) {
  if (response.destroyed) return
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  response.end(JSON.stringify(value))
}

async function body(request: IncomingMessage) {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > maxBody) throw new Error('REQUEST_TOO_LARGE')
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error('INVALID_JSON')
  }
}

/** Authenticated loopback transport for the current desktop service instance. */
export async function startLocalControl(directory: string, commands: CommandRegistry) {
  const token = randomBytes(32).toString('hex')
  const expected = Buffer.from(`Bearer ${token}`)
  let host = ''
  let closing = false
  const server = createServer((request, response) => {
    void serve(request, response).catch(() => {
      reply(response, 500, { ok: false, code: 'INTERNAL_ERROR', error: '本地控制服务异常' })
    })
  })
  server.requestTimeout = 30_000
  server.headersTimeout = 10_000
  server.on('clientError', (_error, socket) => socket.destroy())

  async function serve(request: IncomingMessage, response: ServerResponse) {
    const authorization = Buffer.from(request.headers.authorization ?? '')
    if (
      closing ||
      request.headers.origin ||
      request.headers.host !== host ||
      authorization.length !== expected.length ||
      !timingSafeEqual(authorization, expected)
    ) {
      reply(response, 403, { ok: false, code: 'FORBIDDEN', error: '本地控制鉴权失败' })
      return
    }
    if (request.method === 'GET' && request.url === '/v1/commands') {
      reply(response, 200, { ok: true, value: commands.describe() })
      return
    }
    if (request.method !== 'POST' || request.url !== '/v1/call') {
      reply(response, 404, { ok: false, code: 'NOT_FOUND', error: '接口不存在' })
      return
    }
    let input: z.infer<typeof requestSchema>
    try {
      input = requestSchema.parse(await body(request))
    } catch {
      reply(response, 400, {
        ok: false,
        code: 'INVALID_REQUEST',
        error: '请求须为命令和参数的 JSON 对象，最大 32 MiB',
      })
      return
    }
    try {
      const value = await commands.invoke(input.command, input.args)
      reply(response, 200, { id: input.id, ok: true, value: value ?? null })
    } catch (error) {
      const sensitive = commands.describe(input.command)[0]?.sensitive
      const code =
        error instanceof Error &&
        ['INVALID_ARGUMENTS', 'COMMAND_NOT_FOUND', 'APP_BUSY'].includes(error.message)
          ? error.message
          : 'COMMAND_FAILED'
      reply(response, 200, {
        id: input.id,
        ok: false,
        code,
        error: sensitive ? '敏感操作未完成，请检查参数结构和当前应用状态' : errorMessage(error),
      })
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('CONTROL_ADDRESS_INVALID')
  host = `127.0.0.1:${address.port}`
  let connection: ReturnType<typeof publishConnection>
  try {
    const temporary = 'D:\\Coloop\\.cache\\temp'
    await mkdir(temporary, { recursive: true })
    connection = publishConnection(join(directory, 'local-control'), `http://${host}`, token, {
      ...process.env,
      TEMP: temporary,
      TMP: temporary,
      TMPDIR: temporary,
    })
  } catch (error) {
    server.close()
    throw error
  }
  return {
    close() {
      closing = true
      connection.remove()
      server.close()
      server.closeAllConnections()
    },
  }
}
