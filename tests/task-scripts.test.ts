import { describe, it, expect } from 'vitest'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { TaskScriptExecutor } from '../src/main/infrastructure/task-scripts'
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'coloop-script-test-'))
  return { root, executor: new TaskScriptExecutor(root, join(process.cwd(), 'node_modules')) }
}
const request = () => ({
  execution_id: randomUUID(),
  runtime: 'node' as const,
  code: "require('node:fs').appendFileSync('result.txt','中文验收\\n'); console.log('written')",
  verify_code:
    "const actual=require('node:fs').readFileSync('result.txt','utf8'); console.log(JSON.stringify({verified:actual==='中文验收\\n',evidence:actual}))",
  timeout_ms: 3000,
})
describe('task script execution', () => {
  it('executes a real script and independent readback, once per execution ID', async () => {
    const { root, executor } = await setup()
    const input = request()
    const [one, two] = await Promise.all([
      executor.execute('task1', input, new AbortController().signal),
      executor.execute('task1', input, new AbortController().signal),
    ])
    expect(one.verified).toBe(true)
    expect(two).toEqual(one)
    const restarted = new TaskScriptExecutor(root, join(process.cwd(), 'node_modules'))
    expect(await restarted.execute('task1', input, new AbortController().signal)).toEqual(one)
    expect(await readFile(join(root, 'task1', 'result.txt'), 'utf8')).toBe('中文验收\n')
    expect(() =>
      executor.execute('task1', { ...input, code: 'different' }, new AbortController().signal),
    ).toThrow('SCRIPT_EXECUTION_CONFLICT')
  })
  it('accepts structured readback evidence from a real script', async () => {
    const { executor } = await setup()
    const result = await executor.execute(
      'structured',
      {
        ...request(),
        verify_code:
          "const actual=require('node:fs').readFileSync('result.txt','utf8');console.log(JSON.stringify({verified:actual==='中文验收\\n',evidence:{content:actual,bytes:Buffer.byteLength(actual)}}))",
      },
      new AbortController().signal,
    )
    expect(result.verified).toBe(true)
    expect(JSON.parse(result.evidence).content).toBe('中文验收\n')
  })
  it('does not confuse exit zero with verified success', async () => {
    const { executor } = await setup()
    const result = await executor.execute(
      'task1',
      { ...request(), verify_code: "console.log('not a proof')" },
      new AbortController().signal,
    )
    expect(result.exit_code).toBe(0)
    expect(result.verified).toBe(false)
  })
  it('cancels a running script and does not run verification afterwards', async () => {
    const { executor } = await setup()
    const controller = new AbortController()
    const result = executor.execute(
      'task1',
      { ...request(), code: 'setInterval(()=>{},1000)' },
      controller.signal,
    )
    setTimeout(() => controller.abort(), 200)
    await expect(result).rejects.toMatchObject({ name: 'AbortError' })
  })
  it('times out a process then checks actual effects', async () => {
    const { executor } = await setup()
    const result = await executor.execute(
      'task1',
      {
        ...request(),
        timeout_ms: 500,
        code: 'setInterval(()=>{},1000)',
        verify_code: "console.log(JSON.stringify({verified:false,evidence:'not finished'}))",
      },
      new AbortController().signal,
    )
    expect(result.timed_out).toBe(true)
    expect(result.verified).toBe(false)
  })
  it.each(['powershell', 'python'] as const)(
    'runs a real %s script with actual readback',
    async (runtime) => {
      const { executor } = await setup()
      const code =
        runtime === 'powershell'
          ? "Set-Content -LiteralPath 'native.txt' -Value 'SCRIPT_OK' -Encoding UTF8"
          : "from pathlib import Path; Path('native.txt').write_text('SCRIPT_OK',encoding='utf8')"
      const verify =
        runtime === 'powershell'
          ? "$actual=(Get-Content -LiteralPath 'native.txt' -Raw).Trim(); @{verified=($actual -eq 'SCRIPT_OK');evidence=$actual}|ConvertTo-Json -Compress"
          : "import json; from pathlib import Path; actual=Path('native.txt').read_text(encoding='utf8'); print(json.dumps({'verified':actual=='SCRIPT_OK','evidence':actual}))"
      const result = await executor.execute(
        'native',
        { ...request(), runtime, code, verify_code: verify },
        new AbortController().signal,
      )
      expect(result.verified).toBe(true)
      expect(result.evidence).toBe('SCRIPT_OK')
    },
  )
  it('reads UTF-8 JSON without a BOM through default PowerShell file commands', async () => {
    const { executor, root } = await setup()
    const node = await executor.execute(
      'utf8',
      {
        ...request(),
        code: `require('fs').writeFileSync('todo.json',JSON.stringify({text:'晚饭后散步'}),'utf8')`,
        verify_code: `console.log(JSON.stringify({verified:true,evidence:require('fs').readFileSync('todo.json','utf8')}))`,
      },
      new AbortController().signal,
    )
    expect(node.verified).toBe(true)
    const ps = await executor.execute(
      'utf8',
      {
        ...request(),
        runtime: 'powershell',
        code: `$value=Get-Content -Raw 'todo.json'|ConvertFrom-Json; Set-Content 'copy.txt' $value.text -NoNewline`,
        verify_code: `$value=Get-Content -Raw 'todo.json'|ConvertFrom-Json; @{verified=($value.text -eq '晚饭后散步');evidence=@{text=$value.text}}|ConvertTo-Json -Compress`,
      },
      new AbortController().signal,
    )
    expect(ps.verified).toBe(true)
    expect(JSON.parse(ps.evidence).text).toBe('晚饭后散步')
    expect((await readFile(join(root, 'utf8', 'copy.txt'), 'utf8')).replace(/^\ufeff/, '')).toBe(
      '晚饭后散步',
    )
  })
})
