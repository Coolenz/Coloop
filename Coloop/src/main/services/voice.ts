import { z } from 'zod'
import { runJsonWorker } from '../infrastructure/json-worker'
import { voiceAudioSchema, type VoiceTranscript } from '../../shared/contracts'

export const voiceTranscriptSchema = z.object({
  text: z.string().trim().min(1).max(24000),
  confidence: z.number().min(0).max(1),
  language: z.literal('zh-CN'),
  engine: z.literal('windows_offline_speech'),
  rejected_segments: z.number().int().nonnegative(),
  segments: z.array(z.object({ text: z.string(), confidence: z.number().min(0).max(1) })).max(100),
})

export function validateVoiceWave(bytes: Buffer) {
  if (
    bytes.length < 44 ||
    bytes.length > 5 * 1024 * 1024 ||
    bytes.toString('ascii', 0, 4) !== 'RIFF' ||
    bytes.toString('ascii', 8, 12) !== 'WAVE'
  )
    throw new Error('VOICE_REQUIRES_PCM_WAV')
  if (bytes.readUInt32LE(4) + 8 !== bytes.length) throw new Error('VOICE_WAV_LENGTH_INVALID')
  let format = false
  let dataBytes = 0
  let offset = 12
  let data = false
  while (offset + 8 <= bytes.length) {
    const name = bytes.toString('ascii', offset, offset + 4)
    const size = bytes.readUInt32LE(offset + 4)
    const payload = offset + 8
    if (size > bytes.length - payload) throw new Error('VOICE_WAV_LENGTH_INVALID')
    if (name === 'fmt ') {
      if (format) throw new Error('VOICE_WAV_DUPLICATE_CHUNK')
      if (
        size < 16 ||
        bytes.readUInt16LE(payload) !== 1 ||
        bytes.readUInt16LE(payload + 2) !== 1 ||
        bytes.readUInt32LE(payload + 4) !== 16000 ||
        bytes.readUInt32LE(payload + 8) !== 32000 ||
        bytes.readUInt16LE(payload + 12) !== 2 ||
        bytes.readUInt16LE(payload + 14) !== 16
      )
        throw new Error('VOICE_REQUIRES_16KHZ_MONO_PCM16')
      format = true
    }
    if (name === 'data') {
      if (data || !format) throw new Error('VOICE_WAV_DUPLICATE_OR_UNORDERED_CHUNK')
      data = true
      dataBytes = size
    }
    offset = payload + size + (size % 2)
  }
  if (offset !== bytes.length) throw new Error('VOICE_WAV_LENGTH_INVALID')
  if (!format || dataBytes < 2 || dataBytes % 2 || dataBytes > 32000 * 120)
    throw new Error('VOICE_DURATION_INVALID')
  return { durationSeconds: dataBytes / 32000 }
}

export class VoiceTranscriptionService {
  private active?: { abort: AbortController; work: Promise<VoiceTranscript> }
  constructor(private readonly script: string) {}
  async transcribe(value: unknown) {
    if (this.active) throw new Error('VOICE_BUSY')
    const audio = voiceAudioSchema.parse(value)
    validateVoiceWave(Buffer.from(audio, 'base64'))
    const abort = new AbortController()
    const work = runJsonWorker(
      this.script,
      { audio },
      { signal: abort.signal, timeoutMs: 180000, errorPrefix: 'VOICE' },
    ).then((result) => voiceTranscriptSchema.parse(result))
    const active = { abort, work }
    this.active = active
    try {
      return await work
    } finally {
      if (this.active === active) this.active = undefined
    }
  }
  async stop() {
    const active = this.active
    active?.abort.abort()
    await active?.work.catch(() => {})
  }
}
