import { describe, expect, it, vi } from 'vitest'
import { planDesktopTask } from '../src/main/services/desktop-planner'
import { desktopPlannerPolicy, desktopRoutePolicy } from '../src/main/services/desktop-tasks'
import type { DesktopRequest } from '../src/shared/desktop'

const request: DesktopRequest = {
  goal: 'Fill code',
  windowTitle: 'Lab',
  expectedText: 'Applied:',
  planner: 'auto',
  maxSteps: 8,
  authorizeInput: true,
}
const plan = {
  observation_id: 'abcdef012345',
  actions: [
    { action: 'fill', target_id: 1, text: '0012' },
    { action: 'click', target_id: 2 },
  ],
}
function fixture(route = '{"route":"local"}') {
  const privacyAgent = vi.fn(async (system: string) =>
    system === desktopRoutePolicy ? route : JSON.stringify(plan),
  )
  const cooperate = vi.fn(async () => ({ answer: JSON.stringify(plan), cloudUsed: true }))
  return { board: { privacyAgent }, cooperate, onSource: vi.fn() }
}
describe('desktop planning stays separate from prose answers', () => {
  it('routes locally then obtains a raw action plan with the fixed desktop policy', async () => {
    const f = fixture()
    expect(
      JSON.parse(await planDesktopTask(request, 'observation', new AbortController().signal, f)),
    ).toEqual(plan)
    expect(f.board.privacyAgent.mock.calls.map((c) => c[0])).toEqual([
      desktopRoutePolicy,
      desktopPlannerPolicy,
    ])
    expect(f.cooperate).not.toHaveBeenCalled()
    expect(f.onSource).toHaveBeenCalledWith('local')
  })
  it('hands an actual cloud route to privacy cooperation without another routing decision', async () => {
    const f = fixture('{"route":"cloud"}')
    await planDesktopTask(request, 'observation', new AbortController().signal, f)
    expect(f.board.privacyAgent).toHaveBeenCalledOnce()
    expect(f.cooperate).toHaveBeenCalledWith('observation', expect.any(AbortSignal), true)
  })
  it('blocks malformed or denied routes without invoking either planner', async () => {
    for (const raw of ['{"route":"blocked"}', '{"route":"local","extra":true}', 'not JSON']) {
      const f = fixture(raw)
      await expect(
        planDesktopTask(request, 'observation', new AbortController().signal, f),
      ).rejects.toThrow()
      expect(f.cooperate).not.toHaveBeenCalled()
      expect(f.board.privacyAgent).toHaveBeenCalledOnce()
    }
  })
  it('does not reinterpret prose or a finish claim as executable action data', async () => {
    const f = fixture()
    f.board.privacyAgent.mockImplementation(async (system) =>
      system === desktopRoutePolicy ? '{"route":"local"}' : '任务已完成',
    )
    await expect(
      planDesktopTask(request, 'observation', new AbortController().signal, f),
    ).rejects.toThrow()
    expect(f.cooperate).not.toHaveBeenCalled()
  })
})
