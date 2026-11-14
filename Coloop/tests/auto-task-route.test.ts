import { afterEach, describe, expect, it, vi } from 'vitest'
import { classifyAutoTask } from '../src/main/domain/auto-task-route'

describe('bounded local task routing', () => {
  afterEach(() => vi.useRealTimers())

  it.each([
    ['0', 'rk'],
    ['1', 'cloud'],
    ['简单任务，选0', 'cloud'],
    ['', 'cloud'],
  ])('accepts only an exact local decision (%s)', async (answer, route) => {
    const infer = vi.fn(async () => answer)
    expect(await classifyAutoTask('记录今天的会议', new AbortController().signal, infer)).toBe(
      route,
    )
    expect(infer).toHaveBeenCalledWith(
      JSON.stringify({ goal: '记录今天的会议' }),
      expect.any(AbortSignal),
    )
  })

  it('routes to cloud after eight seconds even if inference ignores cancellation', async () => {
    vi.useFakeTimers()
    const infer = vi.fn(() => new Promise<string>(() => {}))
    // AbortSignal.timeout uses native timers, so inject its signal for this test.
    const timeout = new AbortController()
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal)
    try {
      const result = classifyAutoTask('打开网页', new AbortController().signal, infer)
      expect(timeoutSpy).toHaveBeenCalledWith(8000)
      timeout.abort(new DOMException('Timeout', 'TimeoutError'))
      expect(await result).toBe('cloud')
    } finally {
      timeoutSpy.mockRestore()
    }
  })

  it('propagates cancellation without selecting cloud', async () => {
    const controller = new AbortController()
    const result = classifyAutoTask('记录文本', controller.signal, () => new Promise(() => {}))
    controller.abort()
    await expect(result).rejects.toThrow()
  })

  it('routes unavailable inference and oversized goals to cloud', async () => {
    const infer = vi.fn(async () => {
      throw new Error('busy')
    })
    expect(await classifyAutoTask('复杂操作', new AbortController().signal, infer)).toBe('cloud')
    infer.mockClear()
    expect(await classifyAutoTask('字'.repeat(3000), new AbortController().signal, infer)).toBe(
      'cloud',
    )
    expect(infer).not.toHaveBeenCalled()
  })
})
