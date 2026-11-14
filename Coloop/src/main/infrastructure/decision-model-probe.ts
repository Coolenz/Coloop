import { randomInt, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { deflateSync } from 'node:zlib'
import { createHarnessRuntime } from './harness-runtime'
import { createDecisionModelFetch } from './decision-model'
import type { DecisionModelRoute } from './model-role'
import type { ModelUsageLedger } from './model-usage'

const digits = [
  ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  ['11111', '10000', '10000', '11110', '00001', '00001', '11110'],
  ['01110', '10000', '10000', '11110', '10001', '10001', '01110'],
  ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  ['01110', '10001', '10001', '01111', '00001', '00001', '01110'],
]
function crc32(bytes: Buffer) {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}
function chunk(name: string, value: Buffer) {
  const data = Buffer.concat([Buffer.from(name), value])
  const length = Buffer.alloc(4),
    checksum = Buffer.alloc(4)
  length.writeUInt32BE(value.length)
  checksum.writeUInt32BE(crc32(data))
  return Buffer.concat([length, data, checksum])
}
/** Synthetic pixels contain the random answer. No prompt, filename, alt text,
 * provider metadata or tool schema supplies that answer to a text-only model. */
export function createDecisionProbeImage() {
  const code = Array.from({ length: 8 }, () => String(randomInt(10))).join('')
  const scale = 8,
    margin = 16,
    cell = 7 * scale,
    width = margin * 2 + 8 * cell,
    height = margin * 2 + 7 * scale
  const pixels = Buffer.alloc((width + 1) * height, 255)
  for (let y = 0; y < height; y++) pixels[y * (width + 1)] = 0
  for (let digit = 0; digit < code.length; digit++)
    for (let y = 0; y < 7; y++)
      for (let x = 0; x < 5; x++) {
        if (digits[Number(code[digit])][y][x] !== '1') continue
        for (let yy = 0; yy < scale; yy++)
          for (let xx = 0; xx < scale; xx++)
            pixels[
              (margin + y * scale + yy) * (width + 1) + 1 + margin + digit * cell + x * scale + xx
            ] = 0
      }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0)),
  ])
  return { code, dataUrl: 'data:image/png;base64,' + png.toString('base64') }
}
export interface DecisionModelProbeOptions {
  workspace: string
  cacheDirectory: string
  nodePath?: string
  runtimeResources?: string
  usage?: ModelUsageLedger
  fetch?: typeof fetch
  signal?: AbortSignal
}

/** Two bounded connection checks through the actual official SDK and same
 * protocol adapter. No screenshots or user memory are used. */
export async function testDecisionModel(
  route: DecisionModelRoute,
  options: DecisionModelProbeOptions,
): Promise<{ text: string; image: 'supported' | 'unsupported' | 'unknown' }> {
  const selected = structuredClone(route)
  await mkdir(options.cacheDirectory, { recursive: true })
  const cacheRoot = await realpath(options.cacheDirectory)
  const home = await mkdtemp(join(cacheRoot, 'decision-probe-'))
  const child = relative(cacheRoot, await realpath(home))
  if (!child || child === '..' || child.startsWith('..' + sep) || isAbsolute(child))
    throw new Error('DECISION_PROBE_PATH_INVALID')
  const taskId = randomUUID()
  let imageRejected = false
  let safeToRemove = true
  const signal = AbortSignal.any([
    ...(options.signal ? [options.signal] : []),
    AbortSignal.timeout(120000),
  ])
  const phase = async (image?: ReturnType<typeof createDecisionProbeImage>) => {
    signal.throwIfAborted()
    let verified = false
    const expected = image?.code ?? `text-${randomUUID()}`
    const modelRoute = structuredClone(selected)
    // This is the actual capability test, not a persisted user declaration.
    if (image) modelRoute.provider.imageInput = 'supported'
    const network: typeof fetch = async (input, init) => {
      const response = await (options.fetch ?? globalThis.fetch)(input, init)
      if (image && [400, 415, 422].includes(response.status)) {
        const error = (await response.clone().text()).slice(0, 4000)
        imageRejected =
          /image|vision|multimodal|图片|图像/i.test(error) &&
          /unsupported|not support|does not|not enabled|不支持/i.test(error)
      }
      return response
    }
    const runtime = createHarnessRuntime({
      id: `${taskId}-${image ? 'image' : 'text'}`,
      workspace: options.workspace,
      home,
      runtimeResources: options.runtimeResources,
      nodePath: options.nodePath,
      model: {
        provider: 'openai',
        id: modelRoute.provider.model,
        apiKey: modelRoute.apiKey,
        baseURL: modelRoute.provider.baseUrl,
      },
      fetch: createDecisionModelFetch(modelRoute, { taskId, usage: options.usage, fetch: network }),
      instructions:
        'You are performing a harmless connection capability check. Call coloop_report_probe with the requested code, then finish. No other actions are available.',
      maxTokens: 1024,
      historyBoundary: 'remote',
      requestImages: () => (image ? [{ dataUrl: image.dataUrl, mimeType: 'image/png' }] : []),
      tools: [
        {
          name: 'coloop_report_probe',
          description: 'Report the exact code requested by the connection test.',
          parameters: {
            type: 'object',
            properties: { code: { type: 'string' } },
            required: ['code'],
            additionalProperties: false,
          },
          execute: (args) => {
            verified =
              !!args && typeof args === 'object' && (args as { code?: unknown }).code === expected
            return { matched: verified }
          },
        },
      ],
      completion: () => ({ finished: true }),
    })
    safeToRemove = false
    const abort = () => runtime.abort()
    signal.addEventListener('abort', abort, { once: true })
    try {
      if (signal.aborted) abort()
      const result = await runtime.run(
        image
          ? 'Read the eight-digit code in the host-provided image from left to right, retaining any leading zero. Call coloop_report_probe with exactly those eight digits. The answer is not present in the text.'
          : `Call coloop_report_probe with code ${JSON.stringify(expected)}, then finish.`,
      )
      signal.throwIfAborted()
      return verified && result.finishReason === 'stop'
    } finally {
      signal.removeEventListener('abort', abort)
      await runtime.dispose()
      safeToRemove = true
    }
  }
  try {
    if (!(await phase())) throw new Error('DECISION_MODEL_TEXT_PROBE_FAILED')
    let supported = false
    try {
      supported = await phase(createDecisionProbeImage())
    } catch (error) {
      if (signal.aborted) throw error
    }
    return {
      text: `${selected.provider.model} 文字与工具调用验证通过`,
      image: supported ? 'supported' : imageRejected ? 'unsupported' : 'unknown',
    }
  } finally {
    // Only the freshly created, resolved child is removed. dispose above has
    // stopped its official SDK process before this temporary home is removed.
    if (safeToRemove) await rm(home, { recursive: true, force: true })
  }
}
