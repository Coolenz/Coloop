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
async function setup({ connect = true, autoReady = true } = {}) {
  const channel = new Channel()
  const observation = { observation_id: 'view-1', window_id: '100', ocr_text: '产品发布计划' }
  const input = vi.fn(async () => ({ allowed: true }))
  const cloud = vi.fn(async (_system: string, _content: string, _signal: AbortSignal) =>
    JSON.stringify({
      type: 'suggestion',
      title: '发布计划',
      text: '补充提纲',
      goal: '保留标题并追加发布提纲',
    }),
  )
  const executeScript = vi.fn(async () => ({ verified: true, evidence: 'readback' }))
  const observe = vi.fn(async () => observation)
  const clipboard = vi.fn(async () => ({ lease_id: 'lease' }))
  const retry = vi.fn()
  const available = vi.fn(() => true)
  const openRuntime = vi.fn(async () => {
    if (autoReady) setTimeout(() => channel.receive({ type: 'ready', value: {} }), 1)
    return channel
  })
  const service = new ProactiveAgentService({
    script: 'resources/rk-proactive-agent.py',
    openRuntime,
    available,
    assertStart: () => {},
    observe,
    executeScript,
    cloud,
    input,
    clipboard,
    releaseClipboard: async () => {},
    prepareInput: async () => {},
    onChange: () => {},
    onObservationRetry: retry,
  })
  if (connect) await service.connect()
  return {
    service,
    channel,
    observation,
    input,
    cloud,
    clipboard,
    observe,
    executeScript,
    openRuntime,
    retry,
    available,
  }
}

describe('RK proactive host transport', () => {
  it('requests a retry if readiness changes before or during a recommendation', async () => {
    const { service, observation, cloud, available, retry } = await setup({ connect: false })
    let complete!: (value: string) => void
    try {
      available.mockReturnValue(false)
      await service.submitObservation(observation)
      expect(cloud).not.toHaveBeenCalled()
      expect(retry).toHaveBeenCalledWith('view-1')
      available.mockReturnValue(true)
      cloud.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            complete = resolve
          }),
      )
      await service.submitObservation({ ...observation, observation_id: 'view-2' })
      available.mockReturnValue(false)
      complete('{"type":"suggestion","title":"提纲","text":"补充内容","goal":"追加正文"}')
      await settle()
      expect(service.snapshot().suggestion).toBeUndefined()
      expect(retry).toHaveBeenCalledWith('view-2')
    } finally {
      await service.dispose()
    }
  })
  it('gets OCR recommendations directly from the cloud without opening RK runtime', async () => {
    const { service, observation, cloud, openRuntime, channel } = await setup({ connect: false })
    try {
      await service.submitObservation(observation)
      await settle()
      expect(openRuntime).not.toHaveBeenCalled()
      expect(channel.sent).toEqual([])
      const request = JSON.parse(cloud.mock.calls[0][1] as string)
      expect(request).toMatchObject({ mode: 'suggest', ocr_text: observation.ocr_text })
      expect(service.snapshot().suggestion).toMatchObject({
        observation_id: observation.observation_id,
      })
    } finally {
      await service.dispose()
    }
  })
  it('shares readiness across concurrent connection and task admission', async () => {
    const { service, channel, openRuntime } = await setup({ connect: false, autoReady: false })
    try {
      const opening = service.connect()
      await settle()
      const starting = service.startTask('ready之后才发送')
      await settle()
      expect(openRuntime).toHaveBeenCalledTimes(1)
      expect(channel.sent.some((p) => p.type === 'task.start')).toBe(false)
      channel.receive({ type: 'ready', value: {} })
      await Promise.all([opening, starting])
      expect(channel.sent.filter((p) => p.type === 'task.start')).toHaveLength(1)
    } finally {
      await service.dispose()
    }
  })
  it('cancels obsolete recommendations and refuses late answers even if provider ignores abort', async () => {
    const { service, observation, cloud } = await setup({ connect: false })
    let resolveOld!: (value: string) => void
    cloud.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve
        }),
    )
    try {
      await service.submitObservation(observation)
      const oldSignal = cloud.mock.calls[0][2] as AbortSignal
      await service.submitObservation({
        ...observation,
        observation_id: 'view-2',
        ocr_text: '新内容',
      })
      await settle()
      expect(oldSignal.aborted).toBe(true)
      resolveOld('{"type":"suggestion","title":"旧建议","text":"旧页面","goal":"旧任务"}')
      await settle()
      expect(service.snapshot().suggestion).toMatchObject({
        observation_id: 'view-2',
        title: '发布计划',
      })
    } finally {
      await service.dispose()
    }
  })
  it('retries invalid recommendation JSON once and requests a fresh observation after defer', async () => {
    const { service, observation, cloud, retry } = await setup({ connect: false })
    cloud.mockResolvedValueOnce('invalid').mockResolvedValueOnce('{"type":"defer"}')
    try {
      await service.submitObservation(observation)
      await settle()
      expect(cloud).toHaveBeenCalledTimes(2)
      expect(retry).toHaveBeenCalledWith('view-1')
      expect(service.snapshot().suggestion).toBeUndefined()
    } finally {
      await service.dispose()
    }
  })
  it('keeps recommendation provider errors private and requests retry', async () => {
    const { service, observation, cloud, retry } = await setup({ connect: false })
    cloud.mockRejectedValueOnce(new Error('private-key-and-screen-data'))
    try {
      await service.submitObservation(observation)
      await settle()
      expect(service.snapshot().error).toBe('PROACTIVE_RECOMMENDATION_FAILED')
      expect(retry).toHaveBeenCalledWith('view-1')
    } finally {
      await service.dispose()
    }
  })
  it('keeps unknown input blocked after disconnect until explicit acknowledgement', async () => {
    const { service, channel } = await setup()
    try {
      await service.startTask('执行')
      channel.close()
      await settle()
      expect(service.snapshot().phase).toBe('input_unknown')
      await expect(service.startTask('再次执行')).rejects.toThrow('INPUT_OUTCOME_UNKNOWN')
      service.acknowledgeStopped()
      expect(service.snapshot().phase).toBe('blocked')
    } finally {
      await service.dispose()
    }
  })
  it('rejects stopped task cloud calls and discards in-flight results after cancellation', async () => {
    const { service, channel, cloud } = await setup()
    let complete!: (value: string) => void
    cloud.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve
        }),
    )
    try {
      const task_id = await service.startTask('执行')
      const value = { mode: 'task', task_id, system: 'planner', content: '{"goal":"执行"}' }
      channel.receive({ type: 'request', id: 'in-flight', op: 'cloud_transport', value })
      await settle()
      await service.stop()
      complete('{"type":"finish"}')
      channel.receive({ type: 'request', id: 'after-stop', op: 'cloud_transport', value })
      await settle()
      expect(cloud).toHaveBeenCalledTimes(1)
      expect(channel.sent.find((p) => p.id === 'in-flight')).toMatchObject({
        error: 'TASK_STOPPED',
      })
      expect(channel.sent.find((p) => p.id === 'after-stop')).toMatchObject({
        error: 'TASK_STOPPED',
      })
    } finally {
      await service.dispose()
    }
  })
  it('recognizes legacy passive format retries and blocks them during a task', async () => {
    const { service, channel, cloud } = await setup()
    try {
      await service.startTask('执行')
      channel.receive({
        type: 'request',
        id: 'legacy',
        op: 'cloud_transport',
        value: {
          system: 'suggestion',
          content: JSON.stringify({ original_request: { mode: 'suggest', observation_id: 'old' } }),
        },
      })
      await settle()
      expect(cloud).not.toHaveBeenCalled()
      expect(channel.sent.find((p) => p.id === 'legacy')).toMatchObject({
        error: 'OBSERVATION_EXPIRED',
      })
    } finally {
      await service.dispose()
    }
  })
  it('ignores late task state and question packets after completion', async () => {
    const { service, channel } = await setup()
    try {
      const task_id = await service.startTask('执行')
      channel.receive({
        type: 'task.result',
        value: { task_id, phase: 'completed', summary: '已完成' },
      })
      await settle()
      channel.receive({ type: 'task.state', value: { task_id, phase: 'dispatching' } })
      channel.receive({
        type: 'question',
        value: { task_id, question_id: 'late', question: '迟到问题' },
      })
      await settle()
      expect(service.snapshot()).toMatchObject({
        active: false,
        phase: 'completed',
        summary: '已完成',
      })
      expect(service.snapshot().question).toBeUndefined()
    } finally {
      await service.dispose()
    }
  })
  it('does not send a task when stopped before the connection becomes ready', async () => {
    const { service, channel } = await setup({ connect: false, autoReady: false })
    try {
      const starting = service.startTask('待连接任务')
      const rejected = expect(starting).rejects.toThrow('TASK_STOPPED')
      await settle()
      await service.stop()
      channel.receive({ type: 'ready', value: {} })
      await rejected
      expect(channel.sent.some((p) => p.type === 'task.start')).toBe(false)
      expect(service.snapshot()).toMatchObject({ active: false, phase: 'cancelled' })
    } finally {
      await service.dispose()
    }
  })
  it('isolates a late cloud failure from a replacement connection and omits raw provider errors', async () => {
    const { service, channel, cloud, openRuntime } = await setup()
    const log = vi.spyOn(console, 'info').mockImplementation(() => {})
    let rejectCloud!: (error: Error) => void
    cloud.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectCloud = reject
        }),
    )
    try {
      const task_id = await service.startTask('原任务')
      channel.receive({
        type: 'request',
        id: 'old-request',
        op: 'cloud_transport',
        value: {
          mode: 'task',
          task_id,
          system: 'planner',
          content: '{}',
        },
      })
      await settle()
      channel.close()
      await settle()
      service.acknowledgeStopped()
      const replacement = new Channel()
      openRuntime.mockImplementationOnce(async () => {
        setTimeout(() => replacement.receive({ type: 'ready', value: {} }), 1)
        return replacement
      })
      const replacementId = await service.startTask('新任务')
      rejectCloud(new Error('secret-upstream-response'))
      await settle()
      expect(service.snapshot()).toMatchObject({
        active: true,
        taskId: replacementId,
        phase: 'queued',
      })
      expect(service.snapshot().error).toBeUndefined()
      expect(replacement.sent.some((p) => p.id === 'old-request')).toBe(false)
      expect(JSON.stringify(log.mock.calls)).not.toContain('secret-upstream-response')
    } finally {
      log.mockRestore()
      await service.dispose()
    }
  })
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
      await settle()
      const suggestionId = String(service.snapshot().suggestion!.suggestion_id)
      await service.acceptSuggestion(suggestionId)
      await expect(service.acceptSuggestion(suggestionId)).rejects.toThrow()
      const taskId = service.snapshot().taskId!
      expect(channel.sent.find((p) => p.type === 'task.start')).toMatchObject({
        value: { task_id: taskId, goal: expect.stringContaining('保留标题并追加发布提纲') },
      })
      expect(channel.sent.some((p) => p.type === 'suggestion.accept')).toBe(false)
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
    const { service, channel, observation, cloud } = await setup()
    try {
      await service.submitObservation(observation)
      await settle()
      const oldId = String(service.snapshot().suggestion!.suggestion_id)
      cloud.mockImplementationOnce(() => new Promise(() => {}))
      await service.submitObservation({
        ...observation,
        observation_id: 'view-2',
        ocr_text: '其他内容',
      })
      expect(service.snapshot().suggestion).toBeUndefined()
      await expect(service.acceptSuggestion(oldId)).rejects.toThrow('STALE_SUGGESTION')
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
