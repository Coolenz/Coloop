import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { z } from 'zod'
import {
  relayConfigurationSchema,
  relayJobsSchema,
  type RelayConfiguration,
} from '../../shared/relay'
import type { RemoteTunnelSnapshot } from './remote-tunnel'

const helloSchema = z
  .object({
    version: z.literal(1),
    hostId: z.string().uuid(),
    epoch: z.string().uuid(),
    serverTime: z.number().int().safe().positive(),
  })
  .strict()

class RelayStatusError extends Error {
  constructor(readonly status: number) {
    super('RELAY_REJECTED')
  }
}

/** Bounded native HTTP with no redirects; avoids browser Fetch headers on the local gateway. */
export function relayJson(
  url: URL,
  body: unknown | undefined,
  options: {
    signal?: AbortSignal
    token?: string
    accessKey?: string
    timeout?: number
    maxBytes?: number
  } = {},
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body))
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
      url,
      {
        method: bytes ? 'POST' : 'GET',
        signal: options.signal,
        headers: {
          accept: 'application/json',
          ...(bytes
            ? { 'content-type': 'application/json', 'content-length': String(bytes.length) }
            : {}),
          ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
          ...(options.accessKey ? { 'x-coloop-access-key': options.accessKey } : {}),
        },
      },
      (response) => {
        let size = 0
        const chunks: Buffer[] = []
        response.on('data', (chunk) => {
          size += chunk.length
          if (size > (options.maxBytes ?? 409600))
            response.destroy(new Error('RELAY_RESPONSE_LIMIT'))
          else chunks.push(chunk)
        })
        response.once('error', reject)
        response.once('end', () => {
          clearTimeout(timer)
          try {
            if (!/^application\/json(?:\s*;|$)/i.test(response.headers['content-type'] ?? ''))
              throw new Error('RELAY_INVALID_RESPONSE')
            resolve({
              status: response.statusCode ?? 500,
              body: JSON.parse(
                new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
              ),
            })
          } catch {
            reject(new Error('RELAY_INVALID_RESPONSE'))
          }
        })
      },
    )
    const timer = setTimeout(
      () => request.destroy(new Error('RELAY_TIMEOUT')),
      options.timeout ?? 30000,
    )
    request.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    request.end(bytes)
  })
}

export class RemoteRelay {
  private state: RemoteTunnelSnapshot = { status: 'stopped' }
  private controller?: AbortController
  private generation = ''
  private work?: Promise<void>
  private config?: RelayConfiguration
  constructor(
    private onChange: () => void,
    private request = relayJson,
    private retry = { baseMs: 1000, maxMs: 30000 },
  ) {}
  snapshot(): RemoteTunnelSnapshot {
    return { ...this.state }
  }
  private update(state: RemoteTunnelSnapshot) {
    this.state = state
    this.onChange()
  }

  async start(localUrl: string, configuration: RelayConfiguration): Promise<string> {
    await this.stop()
    const config = relayConfigurationSchema.parse(configuration)
    const local = new URL(localUrl)
    if (
      local.protocol !== 'http:' ||
      local.hostname !== '127.0.0.1' ||
      !local.port ||
      local.pathname !== '/' ||
      local.username ||
      local.password ||
      local.search ||
      local.hash
    )
      throw new Error('本机连接地址无效')
    this.config = config
    const controller = new AbortController()
    this.controller = controller
    this.update({ status: 'starting' })
    try {
      await this.connect(local, controller)
      this.update({ status: 'online', endpoint: config.endpoint })
      this.work = this.run(local, controller).catch(() => {
        if (this.controller === controller && !controller.signal.aborted)
          this.update({ status: 'error', error: '服务器连接已断开，请检查网络后重新开启手机连接' })
      })
      return config.endpoint
    } catch {
      if (!controller.signal.aborted)
        this.update({
          status: 'error',
          error: '无法连接自己的服务器，请检查 HTTPS 地址、连接配置和电脑网络',
        })
      throw new Error(controller.signal.aborted ? '已取消手机连接' : '无法连接自己的服务器')
    }
  }
  private async call(action: string, body: unknown, signal?: AbortSignal) {
    const endpoint = new URL(this.config!.endpoint)
    const channelId = endpoint.pathname.slice(3)
    const result = await this.request(new URL(`/v1/hosts/${channelId}/${action}`, endpoint), body, {
      signal,
      token: this.config!.token,
      timeout: action === 'poll' ? 28000 : 10000,
    })
    if (result.status !== 200) throw new RelayStatusError(result.status)
    return result.body
  }
  private async connect(local: URL, controller: AbortController) {
    const hello = await this.request(new URL('/v1/remote/hello', local), undefined, {
      signal: controller.signal,
    })
    if (hello.status !== 200) throw new Error('GATEWAY_OFFLINE')
    const result = await this.call(
      'connect',
      { hello: helloSchema.parse(hello.body) },
      controller.signal,
    )
    if (controller.signal.aborted) throw new Error('STOPPED')
    this.generation = z.object({ generation: z.string().uuid() }).strict().parse(result).generation
  }
  private async run(local: URL, controller: AbortController) {
    let failures = 0
    let reconnect = false
    while (!controller.signal.aborted) {
      try {
        if (reconnect) {
          await this.connect(local, controller)
          reconnect = false
          this.update({ status: 'online', endpoint: this.config!.endpoint })
        }
        const batch = relayJobsSchema.parse(
          await this.call('poll', { generation: this.generation }, controller.signal),
        )
        if (controller.signal.aborted) return
        if (this.state.status !== 'online')
          this.update({ status: 'online', endpoint: this.config!.endpoint })
        for (const job of batch.jobs) {
          if (controller.signal.aborted) return
          const response = await this.request(new URL(job.path, local), job.frame, {
            signal: controller.signal,
            timeout: 30000,
          })
          if (controller.signal.aborted) return
          await this.call(
            'reply',
            {
              generation: this.generation,
              id: job.id,
              status: response.status === 200 ? 200 : 400,
              body: response.body,
            },
            controller.signal,
          )
        }
        failures = 0
      } catch (error) {
        if (controller.signal.aborted) return
        if (error instanceof RelayStatusError) {
          if (error.status === 401 || error.status === 403) throw error
          if (error.status === 409) reconnect = true
        }
        failures++
        if (this.state.status !== 'starting') this.update({ status: 'starting' })
        // Never replay a pulled job or a write command after an ambiguous failure.
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer)
            controller.signal.removeEventListener('abort', done)
            resolve()
          }
          const timer = setTimeout(
            done,
            Math.min(this.retry.maxMs, this.retry.baseMs * 2 ** Math.min(failures - 1, 10)),
          )
          controller.signal.addEventListener('abort', done, { once: true })
        })
      }
    }
  }
  async stop() {
    const previous = this.controller
    this.controller = undefined
    previous?.abort()
    if (this.work) await this.work
    this.work = undefined
    if (this.config && this.generation) {
      try {
        await this.call('disconnect', { generation: this.generation }, AbortSignal.timeout(2000))
      } catch {
        /* bounded offline lease */
      }
    }
    this.generation = ''
    this.config = undefined
    this.update({ status: 'stopped' })
  }
}
