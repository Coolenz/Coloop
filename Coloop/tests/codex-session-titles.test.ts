import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CodexSessionTitles } from '../src/main/services/codex-session-titles'
import type { AutoAgentSession } from '../src/shared/auto-agent-work'

const directories: string[] = []
afterEach(async () => {
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true })
})
const session = (id: string, source: AutoAgentSession['source'] = 'chatgpt-desktop') =>
  ({
    sessionId: id,
    source,
    title: '原名称',
    revision: 4,
    state: 'idle',
  }) as AutoAgentSession
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'coloop-titles-'))
  directories.push(directory)
  return join(directory, 'session_index.jsonl')
}
describe('local Codex session names', () => {
  it('matches exact native IDs, handles duplicate rename rows and ignores partial rows', async () => {
    const path = await fixture()
    await writeFile(
      path,
      [
        JSON.stringify({ id: 'one', thread_name: '旧名' }),
        JSON.stringify({ id: 'two', thread_name: '其他会话' }),
        JSON.stringify({ id: 'one', thread_name: '导出功能修复' }),
        '{"id":"partial',
      ].join('\n'),
    )
    const titles = new CodexSessionTitles(path)
    await titles.refresh()
    const original = session('one')
    expect(titles.session(original).title).toBe('导出功能修复')
    expect(original.title).toBe('原名称')
    expect(titles.session(original).revision).toBe(4)
    expect(titles.session(session('missing')).title).toBe('原名称')
    expect(titles.session(session('one', 'opencode')).title).toBe('原名称')
  })
  it('caches routine events and picks up renames on explicit refresh', async () => {
    const path = await fixture()
    const titles = new CodexSessionTitles(path, () => 100)
    await writeFile(path, JSON.stringify({ id: 'one', thread_name: '名称 A' }))
    await titles.refresh()
    await writeFile(path, JSON.stringify({ id: 'one', thread_name: '名称 B' }))
    await titles.refresh()
    expect(titles.session(session('one')).title).toBe('名称 A')
    await titles.refresh(true)
    expect(titles.session(session('one')).title).toBe('名称 B')
  })
  it('does not block when metadata is missing, malformed or oversized', async () => {
    const path = await fixture()
    const titles = new CodexSessionTitles(path)
    await expect(titles.refresh()).resolves.toBeUndefined()
    await writeFile(path, '{bad json}\n' + JSON.stringify({ id: 'one', thread_name: 42 }))
    await titles.refresh(true)
    expect(titles.session(session('one')).title).toBe('原名称')
    await writeFile(path, 'x'.repeat(8 * 1024 * 1024 + 1))
    await titles.refresh(true)
    expect(titles.session(session('one')).title).toBe('原名称')
  })
})
