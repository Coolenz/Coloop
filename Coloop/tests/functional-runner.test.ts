import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { expect, it } from 'vitest'

const execute = promisify(execFile)
const runner = join(process.cwd(), 'tests', 'violoop-functional-runner.mjs')

it('rejects missing follow values before contacting the production app', async () => {
  await expect(
    execute(
      process.execPath,
      [runner, 'A06', '--workspace', process.cwd(), '--evidence', 'unused', '--follow-proactive'],
      { timeout: 5000 },
    ),
  ).rejects.toMatchObject({
    stderr: expect.stringContaining('Supply a value for --follow-proactive'),
  })
})

it('rejects an option used as another option value before production dispatch', async () => {
  await expect(
    execute(
      process.execPath,
      [runner, 'A06', '--workspace', process.cwd(), '--follow-proactive', '--evidence', 'unused'],
      { timeout: 5000 },
    ),
  ).rejects.toMatchObject({
    stderr: expect.stringContaining('Supply a value for --follow-proactive'),
  })
})
