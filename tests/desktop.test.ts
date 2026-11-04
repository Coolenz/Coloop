import { describe, expect, it } from 'vitest'
import { PassThrough } from 'node:stream'
import { DesktopPipe } from '../src/main/infrastructure/desktop-pipe'
import { desktopActionSchema, desktopRequestSchema, desktopPlanSchema } from '../src/shared/desktop'

describe('desktop command boundary', () => {
  it('requires explicit task input authorization and finite steps', () => {
    const request = {
      goal: 'Fill Input',
      windowTitle: 'Lab',
      expectedText: 'Applied:',
      planner: 'rk',
      authorizeInput: true,
    }
    expect(desktopRequestSchema.parse(request).maxSteps).toBe(8)
    expect(desktopRequestSchema.safeParse({ ...request, authorizeInput: false }).success).toBe(
      false,
    )
    expect(desktopRequestSchema.safeParse({ ...request, maxSteps: 21 }).success).toBe(false)
    expect(desktopRequestSchema.safeParse({ ...request, agentLocation: 'host' }).success).toBe(
      false,
    )
  })
  it('rejects extra operations and non-ASCII hardware input', () => {
    expect(
      desktopActionSchema.safeParse({
        action: 'type',
        observation_id: 'abcdef012345',
        text: '中文',
      }).success,
    ).toBe(false)
    expect(
      desktopActionSchema.safeParse({
        action: 'click',
        observation_id: 'abcdef012345',
        target_id: 1,
        command: 'run',
      }).success,
    ).toBe(false)
  })
  it('allows a bounded same-page fill and confirmation plan using one observation', () => {
    const plan = {
      observation_id: 'abcdef012345',
      actions: [
        { action: 'fill', target_id: 1, text: '0032' },
        { action: 'click', target_id: 2 },
      ],
    }
    expect(desktopPlanSchema.parse(plan).actions).toHaveLength(2)
    expect(
      desktopPlanSchema.safeParse({ ...plan, actions: Array(9).fill(plan.actions[1]) }).success,
    ).toBe(false)
    expect(
      desktopPlanSchema.safeParse({
        ...plan,
        actions: [{ ...plan.actions[0], observation_id: plan.observation_id }],
      }).success,
    ).toBe(false)
  })
  it('reassembles fragmented replies and ignores a duplicate completed response', async () => {
    const input = new PassThrough(),
      output = new PassThrough()
    const pipe = new DesktopPipe(input, output, () => {})
    input.write('{"type":"ready","value":true}\n')
    await pipe.ready
    let id = ''
    output.on('data', (line) => {
      id = JSON.parse(line.toString()).id
      input.write(`{"type":"reply","id":"${id}",`)
      input.write('"value":{"valid":true}}\n')
    })
    await expect(pipe.request('validate')).resolves.toEqual({ valid: true })
    input.write(JSON.stringify({ type: 'reply', id, value: { valid: false } }) + '\n')
    pipe.close()
  })
  it('rejects an in-flight observation on disconnect', async () => {
    const input = new PassThrough(),
      output = new PassThrough()
    const pipe = new DesktopPipe(input, output, () => {})
    input.write('{"type":"ready","value":true}\n')
    await pipe.ready
    const request = pipe.request('observe')
    input.end()
    await expect(request).rejects.toThrow('断开')
    pipe.close()
  })
})
