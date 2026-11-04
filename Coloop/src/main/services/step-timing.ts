import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'

export const stepTimingSchema = z
  .object({
    name: z.string().regex(/^[a-zA-Z0-9_.-]{1,100}$/),
    category: z.string().max(40),
    elapsedMs: z.number().finite().nonnegative(),
    success: z.boolean(),
    startedAt: z.string().datetime(),
    finishedAt: z.string().datetime(),
    clockHost: z.enum(['pc', 'rk']),
  })
  .strict()
export type StepTiming = z.infer<typeof stepTimingSchema>

export async function timed<T>(
  name: string,
  category: string,
  record: (row: StepTiming) => void,
  action: () => Promise<T>,
): Promise<T> {
  const startedAt = new Date().toISOString(),
    start = performance.now()
  let success = false
  try {
    const result = await action()
    success = true
    return result
  } finally {
    record({
      name,
      category,
      startedAt,
      finishedAt: new Date().toISOString(),
      elapsedMs: performance.now() - start,
      success,
      clockHost: 'pc',
    })
  }
}

export function appendTiming(path: string, row: StepTiming) {
  row = stepTimingSchema.parse(row)
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, JSON.stringify(row) + '\n', { mode: 0o600 })
}

/** Only successful samples are normal-duration evidence; small samples are explicit. */
export function timingSummary(rows: StepTiming[]) {
  const grouped: Record<string, number[]> = {}
  for (const row of rows)
    if (row.success) (grouped[`${row.clockHost}:${row.name}`] ??= []).push(row.elapsedMs)
  return Object.fromEntries(
    Object.entries(grouped).map(([name, values]) => {
      values.sort((a, b) => a - b)
      return [
        name,
        {
          samples: values.length,
          minMs: values[0],
          medianMs: values[Math.floor(values.length / 2)],
          maxMs: values.at(-1),
          totalMs: values.reduce((a, b) => a + b, 0),
          measuredSamplesOnly: true,
        },
      ]
    }),
  )
}

export function writeTimingSummary(path: string, rows: StepTiming[]) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(
    path,
    JSON.stringify(
      {
        timeZone: 'Asia/Shanghai',
        note: 'Durations use each host monotonic clock; nested steps must not be summed twice. Only successful samples enter normal durations.',
        normal: timingSummary(rows),
        failedSteps: rows.filter((r) => !r.success),
      },
      null,
      2,
    ),
  )
}
