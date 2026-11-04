import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DesktopProcedureMemory,
  procedureContract,
  procedureMemoryKey,
} from '../src/main/services/desktop-procedure-memory'
import { CloudHIDRelay } from '../src/main/services/cloud-hid-relay'

const goal = '打开bilibili，点击主页的一个任意视频，然后三连点赞'
const signal = new AbortController().signal
const value = () => ({
  ...procedureContract,
  sourceEpisode: 'D:/RK/logs/evidence/verification.json',
  cloudSummaryVerified: false,
  measurement: { scope: 'command_to_end', elapsedMs: 63821.0551 },
})
const row = () => ({
  id: 'id-1',
  key: procedureMemoryKey,
  kind: 'procedure',
  source: 'agent',
  verified: 0,
  value: JSON.stringify(value()),
})
const directories: string[] = []
afterEach(async () => {
  for (const d of directories.splice(0)) await rm(d, { recursive: true, force: true })
})

it('writes a bounded explicit procedure with provenance and reads the persisted record', async () => {
  const call = vi.fn(async (input) => (input.op === 'get' ? { memory: row() } : row()))
  const memory = new DesktopProcedureMemory({ call })
  await memory.remember(value().sourceEpisode, 63821.0551, 'command_to_end', signal)
  const stored = JSON.parse(call.mock.calls[0][0].value!)
  expect(stored.cloudSummaryVerified).toBe(false)
  expect(stored.steps).toEqual(procedureContract.steps)
  expect(await memory.recall(goal, signal)).toMatchObject({
    id: 'id-1',
    verified: false,
    kind: 'procedure',
  })
})
it('does not query memory for additional or unrelated account operations', async () => {
  const call = vi.fn(async () => ({ memory: row() }))
  const memory = new DesktopProcedureMemory({ call })
  expect(await memory.recall(goal + '并关注', signal)).toBeNull()
  expect(call).not.toHaveBeenCalled()
})
it('rejects modified steps, protected references, or unsupported trust claims', async () => {
  for (const record of [
    { ...row(), value: JSON.stringify({ ...value(), steps: ['arbitrary_click'] }) },
    { ...row(), key: 'private:credential:test' },
    { ...row(), key: 'procedure:coloop:bilibili-triple:v1' },
    { ...row(), verified: true },
  ]) {
    const memory = new DesktopProcedureMemory({ call: async () => ({ memory: record }) })
    await expect(memory.recall(goal, signal)).rejects.toThrow()
  }
})
it('does not revive a deleted or unavailable procedure from a previous hit', async () => {
  const call = vi
    .fn()
    .mockResolvedValueOnce({ memory: row() })
    .mockResolvedValueOnce({ memory: null })
    .mockRejectedValueOnce(Error('unavailable'))
  const memory = new DesktopProcedureMemory({ call })
  const relay = new CloudHIDRelay({
    directory: 'unused',
    procedureMemory: memory,
    cloud: vi.fn(),
    rk: vi.fn(),
  })
  expect(await relay.recallProcedure(goal, signal)).toBe(true)
  expect(await relay.recallProcedure(goal, signal)).toBe(false)
  expect(await relay.recallProcedure(goal, signal)).toBe(false)
})
it('writes to Mem0 only after real three-state verification, after cloud review', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'procedure-memory-'))
  directories.push(directory)
  const call = vi.fn(async (_input: { op: 'get' | 'set'; value?: string }) => row())
  const memory = new DesktopProcedureMemory({ call })
  const remember = vi.spyOn(memory, 'remember')
  const relay = new CloudHIDRelay({
    directory,
    procedureMemory: memory,
    cloud: async () => ({ summary: '操作已核验。', lessons: ['保持新观察。'] }),
    rk: vi.fn(),
  })
  const facts = {
    verified: true,
    elapsedMs: 20000,
    receipts: [],
    observation: { states: { like: true, coin: false, favorite: true } },
  }
  expect(await relay.call('review', goal, facts, signal)).toMatchObject({ memorySaved: false })
  expect(remember).not.toHaveBeenCalled()
  facts.observation.states.coin = true
  expect(await relay.call('review', goal, facts, signal)).toMatchObject({ memorySaved: true })
  expect(remember).toHaveBeenCalledOnce()
  expect(remember.mock.calls[0][4]).toEqual({ summary: '操作已核验。', lessons: ['保持新观察。'] })
  const stored = JSON.parse(call.mock.calls[0][0].value!)
  expect(stored.cloudReview).toEqual({ summary: '操作已核验。', lessons: ['保持新观察。'] })
  expect(stored.cloudSummaryVerified).toBe(false)
})
