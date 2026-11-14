import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import {
  BrowserAdapterMaintenance,
  browserRepairSchema,
} from '../src/main/services/browser-adapter-maintenance'

it('restricts repairs to adapter source and validates request fields', () => {
  expect(() => browserRepairSchema.parse({ operation: 'read', path: '../state.json' })).toThrow()
  expect(() =>
    browserRepairSchema.parse({ operation: 'read', path: 'src/main/index.ts' }),
  ).toThrow()
})
it('reads and patches exact source, refuses stale writes and requires tests before commit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'coloop-browser-repair-'))
  const git = (args: string[]) => promisify(execFile)('git', args, { cwd: root, windowsHide: true })
  const path = 'src/main/infrastructure/browser-executable.ts'
  const goal = '修复浏览器适配代码'
  const signal = new AbortController().signal
  try {
    await mkdir(join(root, 'src/main/infrastructure'), { recursive: true })
    await mkdir(join(root, 'src/main/services'), { recursive: true })
    await mkdir(join(root, 'tests'), { recursive: true })
    await mkdir(join(root, 'scripts'), { recursive: true })
    for (const file of [
      'src/main/infrastructure/stagehand-runtime.ts',
      'src/main/infrastructure/web-reader.ts',
      'src/main/services/browser-preferences.ts',
      'tests/browser-executable.test.ts',
      'tests/browser-preferences.test.ts',
      'tests/stagehand-runtime.test.ts',
    ])
      await writeFile(join(root, file), '// validation fixture\n')
    // This fixture checks maintenance sequencing, not actual compiler execution.
    await writeFile(
      join(root, 'scripts/validate-browser-adapter.ps1'),
      'Write-Output "fixture validation"\n',
    )
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'coloop' }))
    await writeFile(join(root, path), 'export const browser = "chrome"\n')
    await git(['init'])
    await git(['config', 'user.name', 'Test'])
    await git(['config', 'user.email', 'test@example.invalid'])
    await git(['add', 'package.json', 'src', 'tests', 'scripts'])
    await git([
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '-m',
      'fixture',
    ])
    const service = new BrowserAdapterMaintenance(root)
    const read = await service.call({ operation: 'read', path }, goal, signal)
    const request = {
      operation: 'patch',
      path,
      expected_sha256: read.sha256,
      old_text: '"chrome"',
      new_text: '"edge"',
      source_quote: goal,
    }
    await expect(service.call(request, '打开邮箱', signal)).rejects.toThrow(
      'BROWSER_REPAIR_REQUIRES_USER_INSTRUCTION',
    )
    expect(await service.call(request, goal, signal)).toMatchObject({
      patched: true,
      installed: false,
      validated: false,
    })
    expect(await readFile(join(root, path), 'utf8')).toContain('"edge"')
    await expect(service.call(request, goal, signal)).rejects.toThrow(
      'BROWSER_REPAIR_SOURCE_CHANGED',
    )
    await expect(
      service.call({ operation: 'commit', source_quote: goal }, goal, signal),
    ).rejects.toThrow('BROWSER_REPAIR_REQUIRES_CURRENT_VALIDATION')
    const another = new BrowserAdapterMaintenance(root)
    const current = await another.call({ operation: 'read', path }, goal, signal)
    await expect(
      another.call(
        { ...request, expected_sha256: current.sha256, old_text: '"edge"', new_text: '"chrome"' },
        goal,
        signal,
      ),
    ).rejects.toThrow('BROWSER_REPAIR_SOURCE_HAS_UNCOMMITTED_CHANGES')
    expect(
      await service.call({ operation: 'validate', source_quote: goal }, goal, signal),
    ).toMatchObject({ validated: true, installed: false })
    await writeFile(join(root, path), '// concurrent change\n')
    await expect(
      service.call({ operation: 'commit', source_quote: goal }, goal, signal),
    ).rejects.toThrow('BROWSER_REPAIR_REQUIRES_CURRENT_VALIDATION')
    await writeFile(join(root, path), 'export const browser = "edge"\n')
    await service.call({ operation: 'validate', source_quote: goal }, goal, signal)
    const committed = await service.call({ operation: 'commit', source_quote: goal }, goal, signal)
    expect(committed).toMatchObject({ committed: true, installed: false })
    expect((await git(['status', '--porcelain', '--', path])).stdout).toBe('')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30000)
