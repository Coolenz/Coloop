import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import {
  ExecutionCheckpointStore,
  type ExecutionCheckpoint,
} from '../src/main/infrastructure/execution-checkpoints'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
async function setup() {
  const path = await mkdtemp(join(tmpdir(), 'coloop-checkpoint-'))
  directories.push(path)
  return { path, store: new ExecutionCheckpointStore(path) }
}
function record(): ExecutionCheckpoint {
  return {
    taskId: randomUUID(),
    goal: '核验实际订单',
    preference: 'rk',
    approvedFields: [{ name: '金额', type: 'number' }],
    supplements: ['保留原始来源'],
    commands: [
      { command_id: 'command-1', receipt: { outcome: 'unknown', release_confirmed: true } },
    ],
    artifacts: [{ id: 'a', path: 'result.pdf', sha256: 'a'.repeat(64) }],
    phase: 'input_unknown',
    runtime: 'harness',
    updatedAt: 100,
  }
}

it('persists explicit recovery evidence across store instances without changing unknown receipts', async () => {
  const { path, store } = await setup()
  const entry = record()
  await store.save(entry)
  const reopened = new ExecutionCheckpointStore(path)
  expect(await reopened.get(entry.taskId)).toEqual(entry)
  expect(await reopened.listRecoverable()).toEqual([entry])
  expect(await readdir(path)).toEqual([entry.taskId + '.json'])
})

it('serializes updates and snapshots caller data before writing', async () => {
  const { store } = await setup()
  const entry = record()
  const first = store.save(entry)
  entry.supplements.push('后来变化')
  await first
  expect((await store.get(entry.taskId))?.supplements).toEqual(['保留原始来源'])
  await Promise.all([
    store.save({ ...entry, updatedAt: 101 }),
    store.save({ ...entry, phase: 'completed', updatedAt: 102 }),
  ])
  expect((await store.get(entry.taskId))?.phase).toBe('completed')
  expect(await store.listRecoverable()).toEqual([])
})

it('rejects stale updates and keeps the last durable evidence', async () => {
  const { store } = await setup()
  const entry = record()
  await store.save(entry)
  await expect(store.save({ ...entry, updatedAt: 99 })).rejects.toThrow('CHECKPOINT_STALE_WRITE')
  expect(await store.get(entry.taskId)).toEqual(entry)
  await store.save({ ...entry, updatedAt: 101 })
  expect((await store.get(entry.taskId))?.updatedAt).toBe(101)
})

it('does not treat corrupt state or a mismatched UUID as a missing checkpoint', async () => {
  const { path, store } = await setup()
  const entry = record()
  await store.save(entry)
  const file = join(path, entry.taskId + '.json')
  await writeFile(file, 'broken', 'utf8')
  await expect(store.get(entry.taskId)).rejects.toThrow('CHECKPOINT_UNREADABLE')
  await expect(store.save({ ...entry, updatedAt: 101 })).rejects.toThrow('CHECKPOINT_UNREADABLE')
  expect(await readFile(file, 'utf8')).toBe('broken')
  await writeFile(file, JSON.stringify({ ...entry, taskId: randomUUID() }), 'utf8')
  await expect(store.listRecoverable()).rejects.toThrow('CHECKPOINT_UNREADABLE')
})

it('rejects path traversal and non-JSON receipts before creating any file', async () => {
  const { path, store } = await setup()
  const entry = record()
  expect(() => store.save({ ...entry, taskId: '../outside' })).toThrow()
  await expect(store.get('../outside')).rejects.toThrow()
  expect(() => store.save({ ...entry, commands: [{ callback: () => true }] })).toThrow()
  expect(await readdir(path)).toEqual([])
})

it('ignores interrupted temporary files and includes failed, cancelled and waiting tasks', async () => {
  const { path, store } = await setup()
  const phases = [
    'failed',
    'cancelled',
    'blocked',
    'waiting_user',
    'waiting_source',
    'completed',
    'idle',
  ]
  for (const phase of phases) await store.save({ ...record(), phase })
  await writeFile(join(path, randomUUID() + '.tmp'), 'partial', 'utf8')
  expect((await store.listRecoverable()).map((entry) => entry.phase).sort()).toEqual(
    ['failed', 'cancelled', 'blocked', 'waiting_user', 'waiting_source'].sort(),
  )
})
