import { Duplex } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { ProactiveAgentService } from '../src/main/services/proactive-agent'

class Channel extends Duplex {
  sent: Record<string, any>[] = []
  _read() {}
  _write(chunk: Buffer, _encoding: string, callback: () => void) {
    this.sent.push(JSON.parse(chunk.toString()))
    callback()
  }
  close() {
    this.push(null)
  }
  receive(packet: unknown) {
    this.push(JSON.stringify(packet) + '\n')
  }
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 10))
async function setup() {
  const channel = new Channel()
  const observation = { observation_id: 'view-1', window_id: '100', ocr_text: '产品发布计划' }
  const input = vi.fn(async () => ({ allowed: true }))
  const cloud = vi.fn(async () => '{"type":"suggestion"}')
  const executeScript = vi.fn(async () => ({ verified: true, evidence: 'readback' }))
  const observe = vi.fn(async () => observation)
  const clipboard = vi.fn(async () => ({ lease_id: 'lease' }))
  const service = new ProactiveAgentService({
    script: 'resources/rk-proactive-agent.py',
    openRuntime: async () => {
      setTimeout(() => channel.receive({ type: 'ready', value: {} }), 1)
      return channel
    },
    available: () => true,
    assertStart: () => {},
    observe,
    executeScript,
    cloud,
    input,
    clipboard,
    releaseClipboard: async () => {},
    prepareInput: async () => {},
    onChange: () => {},
  })
  await service.connect()
  return { service, channel, observation, input, cloud, clipboard, observe, executeScript }
}

describe('RK proactive host transport', () => {
  it('keeps a task active after a retryable OCR failure and serves a fresh observation', async () => {
    const { service, channel, observe, observation } = await setup()
    try {
      const task_id = await service.startTask('继续观察')
      observe.mockRejectedValueOnce(new Error('OBSERVATION_RETRY'))
      channel.receive({ type: 'request', id: 'retry', op: 'observe.request', value: { task_id } })
      await settle()
      expect(channel.sent.find((p) => p.id === 'retry')).toMatchObject({
        value: {
          window_id: '0',
          observation_error: 'screen_unavailable',
          available_tools: ['script', 'ask_user'],
        },
      })
      expect(service.active).toBe(true)
      channel.receive({ type: 'request', id: 'fresh', op: 'observe.request', value: { task_id } })
      await settle()
      expect(channel.sent.find((p) => p.id === 'fresh')).toMatchObject({ value: observation })
      expect(service.active).toBe(true)
    } finally {
      await service.dispose()
    }
  })
  it('dispatches scripts only for the active task and blocks them after stop', async () => {
    const { service, channel, executeScript } = await setup()
    try {
      const task_id = await service.startTask('execute a script')
      const script = { runtime: 'node', code: 'action', verify_code: 'verify' }
      channel.receive({
        type: 'request',
        id: 'script-ok',
        op: 'script.execute',
        value: { task_id, script },
      })
      await settle()
      expect(executeScript).toHaveBeenCalledTimes(1)
      expect(channel.sent.find((p) => p.id === 'script-ok')).toMatchObject({
        value: { verified: true },
      })
      executeScript.mockRejectedValueOnce(new Error('SCRIPT_ARGUMENT_INVALID'))
      channel.receive({
        type: 'request',
        id: 'script-invalid',
        op: 'script.execute',
        value: { task_id, script },
      })
      await settle()
      expect(channel.sent.find((p) => p.id === 'script-invalid')).toMatchObject({
        error: 'SCRIPT_ARGUMENT_INVALID',
      })
      await service.stop()
      channel.receive({
        type: 'request',
        id: 'script-stopped',
        op: 'script.execute',
        value: { task_id, script },
      })
      await settle()
      expect(executeScript).toHaveBeenCalledTimes(2)
      expect(channel.sent.find((p) => p.id === 'script-stopped')).toMatchObject({
        error: 'TASK_STOPPED',
      })
    } finally {
      await service.dispose()
    }
  })
  it('accepts a suggestion once and preserves task identity for answers', async () => {
    const { service, channel, observation } = await setup()
    try {
      await service.submitObservation(observation)
      channel.receive({
        type: 'suggestion',
        value: { suggestion_id: 's1', observation_id: 'view-1', text: 'outline' },
      })
      await settle()
      await service.acceptSuggestion('s1')
      await expect(service.acceptSuggestion('s1')).rejects.toThrow()
      const taskId = service.snapshot().taskId!
      channel.receive({
        type: 'question',
        value: { task_id: taskId, question_id: 'q1', question: '类型？' },
      })
      await settle()
      expect(() => service.answer(taskId, 'old', '硬件')).toThrow()
      service.answer(taskId, 'q1', '硬件')
      expect(channel.sent.at(-1)?.value).toEqual({
        task_id: taskId,
        question_id: 'q1',
        answer: '硬件',
      })
    } finally {
      await service.dispose()
    }
  })
  it('rejects input RPCs for another task and stale observations', async () => {
    const { service, channel, input } = await setup()
    try {
      await service.startTask('写大纲')
      channel.receive({
        type: 'request',
        id: 'wrong',
        op: 'input.guard',
        value: { task_id: 'other' },
      })
      channel.receive({
        type: 'request',
        id: 'old',
        op: 'input.validate',
        value: { task_id: service.snapshot().taskId, observation_id: 'expired' },
      })
      await settle()
      expect(input).not.toHaveBeenCalled()
      expect(channel.sent.find((p) => p.id === 'wrong')).toMatchObject({ error: 'TASK_MISMATCH' })
      expect(channel.sent.find((p) => p.id === 'old')).toMatchObject({
        error: 'OBSERVATION_EXPIRED',
      })
    } finally {
      await service.dispose()
    }
  })
  it('blocks subsequent USB guards immediately after stop', async () => {
    const { service, channel, input } = await setup()
    try {
      const task_id = await service.startTask('执行')
      await service.stop()
      channel.receive({
        type: 'request',
        id: 'guard',
        op: 'input.guard',
        value: { task_id, observation_id: 'view-1' },
      })
      await settle()
      expect(input).not.toHaveBeenCalled()
      expect(channel.sent.at(-1)).toMatchObject({ id: 'guard', error: 'TASK_STOPPED' })
    } finally {
      await service.dispose()
    }
  })
  it('will not prepare clipboard if the target guard refuses', async () => {
    const { service, channel, observation, input, clipboard } = await setup()
    try {
      await service.submitObservation(observation)
      const task_id = await service.startTask('粘贴')
      input.mockResolvedValue({ allowed: false })
      channel.receive({
        type: 'request',
        id: 'paste',
        op: 'clipboard.prepare',
        value: { task_id, observation_id: 'view-1', text: '大纲' },
      })
      await settle()
      expect(clipboard).not.toHaveBeenCalled()
      expect(channel.sent.at(-1)).toMatchObject({ id: 'paste', error: 'INPUT_GUARD_CHANGED' })
    } finally {
      await service.dispose()
    }
  })
  it('refuses a permit if stop arrives while native validation is pending', async () => {
    const { service, channel, observation, input } = await setup()
    try {
      await service.submitObservation(observation)
      const task_id = await service.startTask('执行')
      let permit!: (value: { allowed: boolean }) => void
      input.mockImplementation(
        () =>
          new Promise((resolve) => {
            permit = resolve
          }),
      )
      channel.receive({
        type: 'request',
        id: 'race',
        op: 'input.guard',
        value: { task_id, observation_id: 'view-1' },
      })
      await settle()
      await service.stop()
      permit({ allowed: true })
      await settle()
      expect(channel.sent.at(-1)).toMatchObject({ id: 'race', error: 'TASK_STOPPED' })
    } finally {
      await service.dispose()
    }
  })
  it('invalidates a displayed suggestion when new OCR is submitted', async () => {
    const { service, channel, observation } = await setup()
    try {
      await service.submitObservation(observation)
      channel.receive({
        type: 'suggestion',
        value: { suggestion_id: 'old', observation_id: 'view-1' },
      })
      await settle()
      await service.submitObservation({
        ...observation,
        observation_id: 'view-2',
        ocr_text: '其他内容',
      })
      expect(service.snapshot().suggestion).toBeUndefined()
      await expect(service.acceptSuggestion('old')).rejects.toThrow('STALE_SUGGESTION')
      channel.receive({
        type: 'suggestion',
        value: { suggestion_id: 'late', observation_id: 'view-1' },
      })
      await settle()
      expect(service.snapshot().suggestion).toBeUndefined()
    } finally {
      await service.dispose()
    }
  })
  it('reserves admission before awaiting the RK connection', async () => {
    const { service } = await setup()
    try {
      const first = service.startTask('第一个任务')
      await expect(service.startTask('第二个任务')).rejects.toThrow('TASK_BUSY')
      await first
    } finally {
      await service.dispose()
    }
  })
  it('ignores another task result and retains completed business state if memory fails', async () => {
    const { service, channel } = await setup()
    try {
      const task_id = await service.startTask('执行')
      channel.receive({ type: 'task.result', value: { task_id: 'old', phase: 'completed' } })
      await settle()
      expect(service.active).toBe(true)
      channel.receive({
        type: 'task.result',
        value: { task_id, phase: 'completed', summary: '完成' },
      })
      channel.receive({ type: 'memory.saved', value: { task_id, saved: false } })
      await settle()
      expect(service.snapshot()).toMatchObject({
        active: false,
        phase: 'completed',
        memorySaved: false,
      })
    } finally {
      await service.dispose()
    }
  })
})
