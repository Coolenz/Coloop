import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { replaceFileSync } from './atomic-file'
import { cloudModelCapacity } from '../../shared/model-capacity'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import {
  effectiveModelLimits,
  type ModelLimits,
  type ModelUsageSnapshot,
  modelPricingSchema,
  type ModelPricing,
} from '../../shared/model-usage'

const counter = z.object({
  requests: z.number().int().nonnegative(),
  tokenUnits: z.number().int().nonnegative(),
  costMicros: z.number().int().nonnegative().default(0),
  unpricedRequests: z.number().int().nonnegative().default(0),
})
const stateSchema = z.object({
  version: z.literal(1),
  lastRequestAt: z.number().nonnegative().default(0),
  cooldownUntil: z.number().nonnegative().default(0),
  days: z.record(z.string(), counter),
  tasks: z.record(z.string(), counter.extend({ day: z.string() })),
})
type UsageState = z.infer<typeof stateSchema>
export type ModelUsageContext = {
  taskId: string
  source: string
  provider?: string
  role?: 'default' | 'decision'
  /** Undefined preserves the original default pricing. An empty object means
   * this explicitly selected model has no configured rates. */
  pricing?: ModelPricing
}
type Context = ModelUsageContext

/** Image bytes are bounded independently from text context. The reservation
 * is deliberately an estimate; complete upstream usage replaces it. */
function requestFootprint(body: unknown) {
  let imageCount = 0,
    imageBytes = 0
  const account = (encoded: unknown) => {
    if (typeof encoded !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))
      throw new ModelUsageError('MODEL_IMAGE_INVALID')
    imageCount++
    imageBytes += Buffer.byteLength(encoded, 'base64')
    if (imageCount > 4 || imageBytes > 8 * 1024 * 1024)
      throw new ModelUsageError('MODEL_IMAGE_LIMIT')
  }
  const text = JSON.stringify(body, (_key, value) => {
    if (value?.type === 'image_url') {
      const match = /^data:image\/(?:png|jpeg|webp);base64,(.*)$/.exec(value.image_url?.url ?? '')
      if (!match) throw new ModelUsageError('MODEL_IMAGE_INVALID')
      account(match[1])
      return { type: 'image_url', image_url: { url: '[image]' } }
    }
    if (value?.type === 'image' && value.source?.type === 'base64') {
      account(value.source.data)
      return {
        type: 'image',
        source: { type: 'base64', media_type: value.source.media_type, data: '[image]' },
      }
    }
    if (value?.inlineData?.mimeType?.startsWith('image/')) {
      account(value.inlineData.data)
      return { inlineData: { mimeType: value.inlineData.mimeType, data: '[image]' } }
    }
    return value
  })
  const textBytes = Buffer.byteLength(text)
  return { textBytes, imageCount, imageBytes, units: textBytes + imageCount * 32768 }
}

export class ModelUsageError extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}

/** Reserve before sending, reconcile only complete provider usage, retain unknown charges. */
export class ModelUsageLedger {
  private state: UsageState = {
    version: 1,
    lastRequestAt: 0,
    cooldownUntil: 0,
    days: {},
    tasks: {},
  }
  private storageError = false
  private admission: Promise<unknown> = Promise.resolve()
  private scopes = new WeakMap<AbortSignal, string>()
  constructor(
    private directory: string,
    private policy: () => Partial<ModelLimits> | undefined,
    private now = Date.now,
  ) {
    try {
      mkdirSync(directory, { recursive: true })
      if (existsSync(this.path()))
        this.state = stateSchema.parse(JSON.parse(readFileSync(this.path(), 'utf8')))
    } catch {
      this.storageError = true
    }
  }
  private path() {
    return join(this.directory, 'model-usage-state.json')
  }
  private day() {
    return new Intl.DateTimeFormat('en-CA', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(this.now())
  }
  limits() {
    return effectiveModelLimits(this.policy())
  }
  bind(signal: AbortSignal, taskId: string) {
    this.scopes.set(signal, taskId)
  }
  scope(signal: AbortSignal) {
    let id = this.scopes.get(signal)
    if (!id) {
      id = randomUUID()
      this.scopes.set(signal, id)
    }
    return id
  }
  snapshot(): ModelUsageSnapshot {
    const day = this.day()
    const usage = this.state.days[day] ?? {
      requests: 0,
      tokenUnits: 0,
      costMicros: 0,
      unpricedRequests: 0,
    }
    const limits = this.limits()
    return {
      day,
      requests: usage.requests,
      tokenUnits: usage.tokenUnits,
      estimatedCostYuan: usage.costMicros / 1000000,
      unpricedRequests: usage.unpricedRequests,
      pricingConfigured:
        limits.inputYuanPerMillion !== undefined && limits.outputYuanPerMillion !== undefined,
      limits,
      ...(this.storageError ? { error: 'MODEL_USAGE_STORAGE_UNAVAILABLE' } : {}),
    }
  }
  taskSnapshot(taskId: string) {
    const usage = this.state.tasks[taskId]
    return {
      requests: usage?.requests ?? 0,
      tokenUnits: usage?.tokenUnits ?? 0,
      estimatedCostYuan: (usage?.costMicros ?? 0) / 1000000,
      unpricedRequests: usage?.unpricedRequests ?? 0,
    }
  }
  private log(event: Record<string, unknown>) {
    appendFileSync(
      join(this.directory, 'model-usage.jsonl'),
      JSON.stringify({ at: this.now(), ...event }) + '\n',
      { encoding: 'utf8', mode: 0o600, flush: true },
    )
  }
  private persist() {
    const temporary = this.path() + '.tmp'
    writeFileSync(temporary, JSON.stringify(this.state), {
      encoding: 'utf8',
      mode: 0o600,
      flush: true,
    })
    replaceFileSync(temporary, this.path())
  }
  private async reserve(
    context: Context,
    bytes: number,
    output: number,
    model: string,
    signal: AbortSignal,
    footprint: ReturnType<typeof requestFootprint>,
  ) {
    const pending = this.admission
      .catch(() => {})
      .then(async () => {
        const limits = this.limits()
        const pricing = modelPricingSchema.parse(context.pricing ?? limits)
        signal.throwIfAborted()
        const wait = Math.min(
          limits.minRequestIntervalMs,
          this.state.lastRequestAt + limits.minRequestIntervalMs - this.now(),
        )
        if (wait > 0) await delay(wait, undefined, { signal })
        signal.throwIfAborted()
        const day = this.day()
        const daily = this.state.days[day] ?? {
          requests: 0,
          tokenUnits: 0,
          costMicros: 0,
          unpricedRequests: 0,
        }
        const task = this.state.tasks[context.taskId] ?? {
          requests: 0,
          tokenUnits: 0,
          costMicros: 0,
          unpricedRequests: 0,
          day,
        }
        const units = bytes + output
        const priced =
          pricing.inputYuanPerMillion !== undefined && pricing.outputYuanPerMillion !== undefined
        const costMicros = priced
          ? Math.ceil(bytes * pricing.inputYuanPerMillion! + output * pricing.outputYuanPerMillion!)
          : 0
        const code = this.storageError
          ? 'MODEL_USAGE_STORAGE_UNAVAILABLE'
          : this.state.cooldownUntil > this.now()
            ? 'MODEL_PROVIDER_COOLDOWN'
            : limits.costLimitEnabled && !priced
              ? 'MODEL_PRICING_REQUIRED'
              : limits.costLimitEnabled &&
                  limits.maxCostYuanTotal !== undefined &&
                  Object.values(this.state.days).reduce((sum, row) => sum + row.costMicros, 0) +
                    costMicros >
                    Math.floor(limits.maxCostYuanTotal * 1000000)
                ? 'MODEL_TOTAL_COST_LIMIT'
                : limits.inputLimitEnabled && footprint.textBytes > limits.maxInputBytes
                  ? 'MODEL_INPUT_LIMIT'
                  : limits.usageBudgetEnabled && task.requests >= limits.maxRequestsPerTask
                    ? 'MODEL_TASK_REQUEST_LIMIT'
                    : limits.usageBudgetEnabled && daily.requests >= limits.maxRequestsPerDay
                      ? 'MODEL_DAY_REQUEST_LIMIT'
                      : limits.usageBudgetEnabled &&
                          task.tokenUnits + units > limits.maxTokenUnitsPerTask
                        ? 'MODEL_TASK_TOKEN_LIMIT'
                        : limits.usageBudgetEnabled &&
                            daily.tokenUnits + units > limits.maxTokenUnitsPerDay
                          ? 'MODEL_DAY_TOKEN_LIMIT'
                          : limits.costLimitEnabled &&
                              priced &&
                              task.costMicros + costMicros >
                                Math.floor(limits.maxCostYuanPerTask * 1000000)
                            ? 'MODEL_TASK_COST_LIMIT'
                            : limits.costLimitEnabled &&
                                priced &&
                                daily.costMicros + costMicros >
                                  Math.floor(limits.maxCostYuanPerDay * 1000000)
                              ? 'MODEL_DAY_COST_LIMIT'
                              : undefined
        if (code) {
          try {
            this.log({ type: 'blocked', ...context, code, model })
          } catch {
            this.storageError = true
          }
          throw new ModelUsageError(code)
        }
        const id = randomUUID()
        this.state.days[day] = {
          requests: daily.requests + 1,
          tokenUnits: daily.tokenUnits + units,
          costMicros: daily.costMicros + costMicros,
          unpricedRequests: daily.unpricedRequests + (priced ? 0 : 1),
        }
        this.state.tasks[context.taskId] = {
          requests: task.requests + 1,
          tokenUnits: task.tokenUnits + units,
          costMicros: task.costMicros + costMicros,
          unpricedRequests: task.unpricedRequests + (priced ? 0 : 1),
          day,
        }
        this.state.lastRequestAt = this.now()
        try {
          this.persist()
          this.log({
            type: 'request',
            id,
            ...context,
            model,
            day,
            inputBytes: footprint.textBytes + footprint.imageBytes,
            imageCount: footprint.imageCount,
            reservedTokenUnits: units,
            maxOutputTokens: output,
            reservedCostYuan: priced ? costMicros / 1000000 : undefined,
          })
        } catch {
          this.storageError = true
          throw new ModelUsageError('MODEL_USAGE_STORAGE_UNAVAILABLE')
        }
        return {
          id,
          day,
          units,
          started: this.now(),
          costMicros,
          priced,
          inputRate: pricing.inputYuanPerMillion,
          outputRate: pricing.outputYuanPerMillion,
        }
      })
    this.admission = pending
    return pending
  }
  wrap(fetcher: typeof fetch, context: Context): typeof fetch {
    return async (input, init) => {
      if (typeof init?.body !== 'string') throw new ModelUsageError('MODEL_REQUEST_UNMETERED')
      const body = JSON.parse(init.body)
      const limits = this.limits()
      const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      )
      const model = body.model ?? url.pathname.match(/\/models\/([^:]+)/)?.[1] ?? 'configured-model'
      const capacity = cloudModelCapacity({ baseUrl: url.origin, model: String(model) })
      const requested =
        body.max_completion_tokens ??
        body.max_tokens ??
        body.generationConfig?.maxOutputTokens ??
        (limits.mode === 'custom' ? limits.maxOutputTokens : capacity.maxOutputTokens)
      const requestedOutput =
        Number.isInteger(requested) && requested > 0 ? requested : capacity.maxOutputTokens
      const output =
        limits.mode === 'custom'
          ? Math.min(requestedOutput, limits.maxOutputTokens)
          : requestedOutput
      if (body.generationConfig) body.generationConfig.maxOutputTokens = output
      else if (body.max_completion_tokens !== undefined) body.max_completion_tokens = output
      else body.max_tokens = output
      if (body.stream === true)
        body.stream_options = { ...body.stream_options, include_usage: true }
      const payload = JSON.stringify(body)
      const signal = init.signal ?? new AbortController().signal
      const trackedContext = { ...context, provider: url.origin }
      const footprint = requestFootprint(body)
      const reservation = await this.reserve(
        trackedContext,
        footprint.units,
        output,
        String(model).slice(0, 120),
        signal,
        footprint,
      )
      let finished = false
      let prompt: number | undefined,
        completion: number | undefined,
        total = 0
      let providerRequestId: string | undefined
      let cachedTokens: number | undefined, reasoningTokens: number | undefined
      const usage = (data: any) => {
        const id = data?.id ?? data?.message?.id ?? data?.responseId
        if (typeof id === 'string') providerRequestId ??= id.slice(0, 200)
        const value = data?.usage ?? data?.message?.usage ?? data?.usageMetadata
        if (!value) return
        const integer = (number: unknown) =>
          Number.isSafeInteger(number) && Number(number) >= 0 ? Number(number) : undefined
        prompt =
          integer(value.prompt_tokens ?? value.input_tokens ?? value.promptTokenCount) ?? prompt
        completion =
          integer(value.completion_tokens ?? value.output_tokens ?? value.candidatesTokenCount) ??
          completion
        total = integer(value.total_tokens ?? value.totalTokenCount) ?? total
        cachedTokens =
          integer(
            value.prompt_tokens_details?.cached_tokens ??
              value.cache_read_input_tokens ??
              value.cachedContentTokenCount,
          ) ?? cachedTokens
        reasoningTokens =
          integer(value.completion_tokens_details?.reasoning_tokens ?? value.thoughtsTokenCount) ??
          reasoningTokens
      }
      const finish = (status: number | undefined, complete: boolean, aborted = false) => {
        if (finished) return
        finished = true
        const reported = complete && prompt !== undefined && completion !== undefined
        const charged = reported ? Math.max(total, prompt! + completion!) : reservation.units
        const delta = charged - reservation.units
        this.state.days[reservation.day].tokenUnits += delta
        this.state.tasks[context.taskId].tokenUnits += delta
        const actualCost =
          reported && reservation.priced
            ? Math.ceil(
                prompt! * reservation.inputRate! +
                  Math.max(completion!, total - prompt!) * reservation.outputRate!,
              )
            : reservation.costMicros
        this.state.days[reservation.day].costMicros += actualCost - reservation.costMicros
        this.state.tasks[context.taskId].costMicros += actualCost - reservation.costMicros
        try {
          this.persist()
          this.log({
            type: 'response',
            id: reservation.id,
            ...trackedContext,
            status,
            aborted,
            elapsedMs: this.now() - reservation.started,
            usageSource: reported ? 'provider' : 'conservative_reservation',
            promptTokens: prompt,
            completionTokens: completion,
            chargedTokenUnits: charged,
            providerRequestId,
            cachedTokens,
            reasoningTokens,
            estimatedCostYuan: reservation.priced ? actualCost / 1000000 : undefined,
          })
        } catch {
          this.storageError = true
        }
      }
      let response: Response
      try {
        response = await fetcher(input, { ...init, body: payload, redirect: 'error', signal })
      } catch (error) {
        finish(undefined, false, signal.aborted)
        throw error
      }
      providerRequestId = (
        response.headers.get('x-request-id') ?? response.headers.get('request-id')
      )?.slice(0, 200)
      // Fail closed across tasks and restarts. Retrying an overloaded provider
      // must not create a burst through another agent/browser/compaction route.
      if (response.status === 429 || response.status >= 500) {
        const retry = response.headers.get('retry-after')
        const seconds = retry !== null && /^\d+(\.\d+)?$/.test(retry) ? Number(retry) : NaN
        const requested = Number.isFinite(seconds)
          ? seconds * 1000
          : Date.parse(retry ?? '') - this.now()
        const cooldown = Math.max(30_000, Number.isFinite(requested) ? requested : 0)
        this.state.cooldownUntil = Math.max(this.state.cooldownUntil, this.now() + cooldown)
        try {
          this.persist()
          this.log({ type: 'cooldown', status: response.status, until: this.state.cooldownUntil })
        } catch {
          this.storageError = true
        }
      }
      if (!response.body) {
        finish(response.status, false)
        return response
      }
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      const streaming = response.headers.get('content-type')?.includes('text/event-stream')
      let buffer = ''
      const parse = (text: string) => {
        try {
          usage(JSON.parse(text))
        } catch {
          /* Non-usage chunks remain untouched. */
        }
      }
      const consume = (text: string, final = false) => {
        buffer += text
        if (streaming) {
          let end: number
          while ((end = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, end).trim()
            buffer = buffer.slice(end + 1)
            if (line.startsWith('data:')) parse(line.slice(5).trim())
          }
          if (final && buffer.startsWith('data:')) parse(buffer.slice(5).trim())
        } else if (final) parse(buffer)
        if (buffer.length > 1000000) buffer = ''
      }
      const abort = () => {
        finish(response.status, false, true)
        void reader.cancel().catch(() => {})
      }
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
      return new Response(
        new ReadableStream({
          pull: async (controller) => {
            try {
              signal.throwIfAborted()
              const chunk = await reader.read()
              signal.throwIfAborted()
              if (chunk.done) {
                consume(decoder.decode(), true)
                signal.removeEventListener('abort', abort)
                finish(response.status, response.ok)
                controller.close()
              } else {
                consume(decoder.decode(chunk.value, { stream: true }))
                controller.enqueue(chunk.value)
              }
            } catch (error) {
              signal.removeEventListener('abort', abort)
              finish(response.status, false, signal.aborted)
              await reader.cancel().catch(() => {})
              controller.error(error)
            }
          },
          cancel: async () => {
            signal.removeEventListener('abort', abort)
            finish(response.status, false, true)
            await reader.cancel().catch(() => {})
          },
        }),
        { status: response.status, statusText: response.statusText, headers: response.headers },
      )
    }
  }
}
