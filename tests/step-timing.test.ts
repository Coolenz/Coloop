import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import {
  appendTiming,
  timed,
  timingSummary,
  writeTimingSummary,
  type StepTiming,
} from '../src/main/services/step-timing'

it('records duration for success and failure and excludes failure from normal samples', async () => {
  const rows: StepTiming[] = []
  await timed(
    'usb.click',
    'usb_input',
    (r) => rows.push(r),
    async () => 42,
  )
  await expect(
    timed(
      'usb.click',
      'usb_input',
      (r) => rows.push(r),
      async () => {
        throw Error('lost')
      },
    ),
  ).rejects.toThrow('lost')
  expect(rows).toHaveLength(2)
  expect(rows.map((r) => r.success)).toEqual([true, false])
  expect(
    rows.every((r) => r.elapsedMs >= 0 && r.clockHost === 'pc' && r.startedAt.endsWith('Z')),
  ).toBe(true)
  expect(timingSummary(rows)['pc:usb.click'].samples).toBe(1)
  const dir = mkdtempSync(join(tmpdir(), 'step-timing-'))
  try {
    for (const row of rows) appendTiming(join(dir, 'nested', 'steps.jsonl'), row)
    writeTimingSummary(join(dir, 'normal.json'), rows)
    expect(
      readFileSync(join(dir, 'nested', 'steps.jsonl'), 'utf8')
        .trim()
        .split('\n'),
    ).toHaveLength(2)
    expect(JSON.parse(readFileSync(join(dir, 'normal.json'), 'utf8')).failedSteps).toHaveLength(1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
