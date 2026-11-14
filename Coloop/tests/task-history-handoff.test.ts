import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { readTaskHistory } from '../src/main/services/task-history'
import { ExecutionCheckpointStore } from '../src/main/infrastructure/execution-checkpoints'

it('reads local and cloud continuation evidence under the original task ID', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'coloop-history-handoff-'))
  const taskId = randomUUID()
  const cloudSessionId = randomUUID()
  try {
    for (const [id, text, time] of [
      [taskId, 'local result', 1],
      [cloudSessionId, 'cloud result', 2],
    ] as const) {
      const path = join(
        directory,
        '.coloop-harness',
        createHash('sha256').update(id).digest('hex'),
        'sessions',
        'project',
        id,
      )
      await mkdir(path, { recursive: true })
      await writeFile(
        join(path, 'session.v4.jsonl'),
        [
          { id },
          {
            type: 'assistant/message',
            time,
            data: { message: { content: [{ type: 'text', text }] } },
          },
        ]
          .map((value) => JSON.stringify(value) + '\n')
          .join(''),
      )
    }
    await new ExecutionCheckpointStore(join(directory, 'execution-checkpoints')).save({
      taskId,
      cloudSessionId,
      goal: 'continue',
      preference: 'auto',
      autoRoute: 'cloud',
      approvedFields: [],
      supplements: [],
      commands: [],
      artifacts: [],
      phase: 'completed',
      runtime: 'harness',
      updatedAt: Date.now(),
    })
    expect((await readTaskHistory(directory, taskId)).entries.map((entry) => entry.text)).toEqual([
      'local result',
      'cloud result',
    ])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
