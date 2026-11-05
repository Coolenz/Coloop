import { afterEach, expect, it, vi } from 'vitest'
import { VoiceTranscriptionService, validateVoiceWave } from '../src/main/services/voice'
import { runJsonWorker } from '../src/main/infrastructure/json-worker'
vi.mock('../src/main/infrastructure/json-worker', () => ({ runJsonWorker: vi.fn() }))
afterEach(() => vi.resetAllMocks())

function wave(samples = 160) {
  const bytes = Buffer.alloc(44 + samples * 2)
  bytes.write('RIFF', 0)
  bytes.writeUInt32LE(bytes.length - 8, 4)
  bytes.write('WAVEfmt ', 8)
  bytes.writeUInt32LE(16, 16)
  bytes.writeUInt16LE(1, 20)
  bytes.writeUInt16LE(1, 22)
  bytes.writeUInt32LE(16000, 24)
  bytes.writeUInt32LE(32000, 28)
  bytes.writeUInt16LE(2, 32)
  bytes.writeUInt16LE(16, 34)
  bytes.write('data', 36)
  bytes.writeUInt32LE(samples * 2, 40)
  return bytes
}
it('validates actual PCM frame format and duration before starting recognition', () => {
  expect(validateVoiceWave(wave())).toEqual({ durationSeconds: 0.01 })
  const stereo = wave()
  stereo.writeUInt16LE(2, 22)
  expect(() => validateVoiceWave(stereo)).toThrow('VOICE_REQUIRES_16KHZ_MONO_PCM16')
  const truncated = wave()
  truncated.writeUInt32LE(10000, 40)
  expect(() => validateVoiceWave(truncated)).toThrow('VOICE_WAV_LENGTH_INVALID')
  expect(() => validateVoiceWave(Buffer.from('not audio'))).toThrow('VOICE_REQUIRES_PCM_WAV')
  expect(() => validateVoiceWave(wave(16000 * 121))).toThrow('VOICE_DURATION_INVALID')
})
it('returns the real worker transcript and keeps recognition local', async () => {
  vi.mocked(runJsonWorker).mockResolvedValue({
    ok: true,
    text: '将计划改为语音验证完成',
    confidence: 0.8,
    language: 'zh-CN',
    engine: 'windows_offline_speech',
    rejected_segments: 0,
    segments: [{ text: '将计划改为语音验证完成', confidence: 0.8 }],
  })
  const service = new VoiceTranscriptionService('voice-runtime.ps1')
  expect(await service.transcribe(wave().toString('base64'))).toMatchObject({
    text: '将计划改为语音验证完成',
    confidence: 0.8,
  })
  expect(runJsonWorker).toHaveBeenCalledWith(
    'voice-runtime.ps1',
    { audio: wave().toString('base64') },
    expect.objectContaining({ errorPrefix: 'VOICE', signal: expect.any(AbortSignal) }),
  )
})
it('serializes requests and waits for cancellation to drain', async () => {
  vi.mocked(runJsonWorker).mockImplementation(
    (_script, _input, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError')), {
          once: true,
        })
      }),
  )
  const service = new VoiceTranscriptionService('voice-runtime.ps1')
  const pending = service.transcribe(wave().toString('base64'))
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  await expect(service.transcribe(wave().toString('base64'))).rejects.toThrow('VOICE_BUSY')
  await service.stop()
  await rejected
})
