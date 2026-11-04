import { describe, it, expect } from 'vitest'
import { reviewTaskCandidate } from '../src/main/services/workspace-dispatch'
const content = {
  goal: '打开 Edge 收集 Bilibili 视频',
  context: '',
  candidate: '我不能操作设备',
  feedback: '',
}
describe('task outcome review', () => {
  it.each([['0', 'complete'], ['1', 'revise'], ['2', 'execute']])(
    'accepts the bounded digit %s without generating long JSON feedback', async (digit, decision) => {
      const result = await reviewTaskCandidate(content, async () => digit)
      expect(result.decision).toBe(decision)
      expect(result.feedback).toBeTruthy()
    },
  )
  it('does not infer a routing digit from explanatory prose', async () => {
    await expect(reviewTaskCandidate(content, async () => 'choose 2 because tools')).rejects.toThrow()
  })
  it('feeds the original goal and candidate back for capability recovery', async () => {
    const result = await reviewTaskCandidate(content, async (_system, input) => {
      expect(JSON.parse(input)).toEqual(content)
      return '{"decision":"execute","feedback":"use desktop tools"}'
    })
    expect(result.decision).toBe('execute')
  })
  it('rejects malformed review instead of treating it as completion', async () => {
    await expect(reviewTaskCandidate(content, async () => 'done')).rejects.toThrow()
    await expect(
      reviewTaskCandidate(content, async () => '{"decision":"complete"}'),
    ).rejects.toThrow()
  })
})
