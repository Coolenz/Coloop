import { app, safeStorage, session } from 'electron'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'
import { randomUUID, createHash } from 'node:crypto'
import { win32 } from 'node:path'
const root = 'D:/Coloop',
  output = process.env.COLOOP_AGENT_STATE_OUTPUT
app.setPath('userData', process.env.APPDATA + '/coloop')
app.on('window-all-closed', () => {})

async function main() {
  let board,
    observer,
    lab,
    key = ''
  const packets = [],
    cloudCalls = [],
    pcTimings = []
  const save = async (name, value) => {
    const text = JSON.stringify(value, null, 2)
    if (key && text.includes(key)) throw Error('KEY_IN_EVIDENCE')
    await writeFile(output + '/' + name, text)
  }
  const until = async (fn) => {
    const deadline = Date.now() + 10000
    while (Date.now() < deadline) {
      try {
        const result = await fn()
        if (result) return result
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw Error('LAB_START_TIMEOUT')
  }
  try {
    const lib = await import(pathToFileURL(process.env.COLOOP_AGENT_STATE_LIB).href)
    const profile = JSON.parse(await readFile(process.env.APPDATA + '/coloop/state.json', 'utf8'))
    key = safeStorage.decryptString(Buffer.from(profile.encryptedKey, 'base64'))
    const network = session.fromPartition('rk-state-' + randomUUID())
    const cloud = new lib.CloudGateway(async (url, init) => {
      if (cloudCalls.length >= 3) throw Error('QA_CLOUD_LIMIT')
      const row = { request: JSON.parse(init.body) }
      cloudCalls.push(row)
      const response = await network.fetch(url, init)
      row.status = response.status
      if (response.ok) row.response = await response.clone().json()
      await save('cloud.json', cloudCalls)
      return response
    })
    const runId = randomUUID().replaceAll('-', '')
    const qaKey = 'test:coloop:rk-agent-state:' + runId
    const labDir = output + '/lab'
    await mkdir(labDir)
    const config = {
      folder: labDir,
      title: 'RK Agent State Lab ' + runId.slice(0, 8),
      code: runId.slice(0, 8),
    }
    await save('lab-config.json', config)
    const exe = output + '/AgentStateLab.exe'
    await promisify(execFile)(
      process.env.WINDIR + '/Microsoft.NET/Framework64/v4.0.30319/csc.exe',
      [
        '/nologo',
        '/target:winexe',
        '/out:' + win32.normalize(exe),
        '/reference:System.Windows.Forms.dll',
        '/reference:System.Drawing.dll',
        '/reference:System.Web.Extensions.dll',
        'D:\\RK\\rk-opencode\\pc\\AgentLab.cs',
      ],
      { windowsHide: true },
    )
    // The instrumented target must expose its visible form; this is the UI being tested.
    lab = spawn(exe, [output + '/lab-config.json'], { stdio: 'ignore' })
    await until(async () => {
      const data = JSON.parse(await readFile(labDir + '/fixture-state.json', 'utf8'))
      return data.pid === lab.pid ? data : null
    })
    observer = spawn(
      'D:/RK/deployment/screen-ocr/.venv/Scripts/python.exe',
      [
        '-u',
        root + '/tests/rk-agent-state-observer.py',
        labDir,
        output + '/lab-config.json',
        String(lab.pid),
      ],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    )
    const queue = []
    let observerReady
    const readyPromise = new Promise((resolve) => {
      observerReady = resolve
    })
    createInterface({ input: observer.stdout }).on('line', (line) => {
      const value = JSON.parse(line)
      if (value.ready) observerReady(value)
      else queue.shift()?.(value)
    })
    let observerErrors = ''
    observer.stderr.on('data', (data) => {
      observerErrors += data.toString()
    })
    const observed = await Promise.race([
      readyPromise,
      new Promise((_, reject) => setTimeout(() => reject(Error('OBSERVER_TIMEOUT')), 15000)),
    ])
    if (process.env.COLOOP_LAB_WAIT_FOR_FOREGROUND === '1') {
      await save('lab-ready.json', { pid: lab.pid, title: config.title, executable: exe })
      const deadline = Date.now() + 60000
      while (Date.now() < deadline) {
        try {
          if (JSON.parse(await readFile(output + '/lab-armed.json', 'utf8')).ready) break
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
    }
    const observe = async (op, value) => {
      const response = new Promise((resolve) => queue.push(resolve))
      observer.stdin.write(JSON.stringify({ op, value }) + '\n')
      const reply = await Promise.race([
        response,
        new Promise((_, reject) => setTimeout(() => reject(Error('QA_OBSERVE_TIMEOUT')), 5000)),
      ])
      if (!reply.ok) throw Error(reply.error)
      return reply.value
    }
    board = new lib.BoardGateway(() => {})
    await save(
      'device.json',
      await board.connect(
        lib.importRkBoard('D:/RK/config/board.json'),
        process.env.RK_BOARD_PASSWORD,
      ),
    )
    const agentBytes = await readFile(root + '/resources/rk-cloud-agent.py')
    const runtimeBytes = await readFile(root + '/resources/browser-runtime.py')
    const bootstrap = `import sys,types,base64,hashlib,json,uuid
from pathlib import Path
sys.path.insert(0,str(Path(sys.argv[1]).expanduser()/'agent'))
from memory_client import MemoryClient
_bytes=base64.b64decode('${agentBytes.toString('base64')}')
_agent=types.ModuleType('rk_cloud_agent')
_agent.__source_bytes__=_bytes
_agent.__source_sha256__=hashlib.sha256(_bytes).hexdigest()
exec(_bytes,_agent.__dict__)
_Original=_agent.RKCloudAgent
class QAMemory:
    def __init__(self,root):self.client=MemoryClient(root)
    def request(self,path,body,timeout):
        if path!='/call':return self.client.request(path,body,timeout=timeout)
        if body.get('key')!='procedure:coloop:bilibili-home:mouse-v1':raise ValueError('QA_KEY_SCOPE')
        request={**body,'key':'${qaKey}'}
        if body['op']=='set':request['ttl']=60
        row=self.client.request(path,request,timeout=timeout)
        if body['op']=='get':
            if row.get('memory'):row['memory']['key']=body['key']
        else:row['key']=body['key']
        return row
def factory(*args,**kwargs):return _Original(*args,**kwargs,memory=QAMemory(args[0]))
_agent.RKCloudAgent=factory
sys.modules['rk_cloud_agent']=_agent
`
    const source =
      bootstrap +
      `\n_runtime=types.ModuleType('qa_runtime')\nexec(base64.b64decode('${runtimeBytes.toString('base64')}'),_runtime.__dict__)\n_runtime.main()\n`
    await save('input.json', {
      goal: '打开 Bilibili',
      qaKey,
      scope: 'native lab only; synthetic browser observations',
      agentSha256: createHash('sha256').update(agentBytes).digest('hex'),
    })
    const channel = await board.openDesktopRuntime(source)
    let buffer = '',
      terminal,
      terminalMs,
      submittedMs,
      stderr = ''
    let runtimeReady
    const runtimeReadyPromise = new Promise((resolve) => {
      runtimeReady = resolve
    })
    channel.stderr.on('data', (data) => {
      stderr += data.toString()
    })
    channel.on('data', (chunk) => {
      buffer += chunk.toString()
      let end
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + 1)
        let packet
        try {
          packet = JSON.parse(line)
        } catch {
          continue
        }
        packets.push(packet)
        if (packet.type === 'ready') runtimeReady(packet.value)
        if (packet.type === 'request')
          void (async () => {
            const start = performance.now(),
              startedAt = new Date().toISOString()
            let success = false
            try {
              const value =
                packet.op === 'cloud_transport'
                  ? await cloud.relayText(
                      profile.settings.provider,
                      key,
                      packet.value.system,
                      packet.value.content,
                      AbortSignal.timeout(120000),
                    )
                  : await observe(packet.op, packet.value)
              channel.write(JSON.stringify({ type: 'reply', id: packet.id, value }) + '\n')
              success = true
            } catch (error) {
              channel.write(
                JSON.stringify({ type: 'reply', id: packet.id, error: error.message }) + '\n',
              )
            } finally {
              pcTimings.push({
                name: packet.op,
                startedAt,
                finishedAt: new Date().toISOString(),
                elapsedMs: performance.now() - start,
                clockHost: 'pc',
                success,
              })
            }
          })()
        if (
          packet.type === 'state' &&
          ['completed', 'failed', 'cancelled'].includes(packet.phase)
        ) {
          terminal = packet
          terminalMs = performance.now()
          channel.end()
        }
      }
    })
    const closed = new Promise((resolve) => channel.on('close', resolve))
    await runtimeReadyPromise
    const heartbeat = setInterval(() => channel.write('{"type":"heartbeat"}\n'), 1000)
    submittedMs = performance.now()
    channel.write(
      JSON.stringify({
        type: 'start',
        value: {
          authorizeInput: true,
          planner: 'cloud-hid',
          windowTitle: 'Chrome → Bilibili',
          agentLocation: 'rk',
          goal: '打开 Bilibili',
          browserTask: 'home',
          maxSteps: 4,
          observerSession: observed.session_id,
        },
      }) + '\n',
    )
    const code = await closed
    clearInterval(heartbeat)
    await save('runtime.json', packets)
    await save('pc-timings.json', pcTimings)
    await save('channel.json', { code, stderr, observerErrors })
    const state = await until(async () =>
      JSON.parse(await readFile(labDir + '/fixture-state.json', 'utf8')),
    )
    const metadata = packets.find((p) => p.type === 'agent_ready')
    const getSource =
      bootstrap +
      `
import contextlib
client=MemoryClient(Path(sys.argv[1]).expanduser())
raw=client.request('/call',{'op':'get','key':'${qaKey}'},timeout=12)
fresh=_Original(Path(sys.argv[1]).expanduser(),'打开 Bilibili','home',uuid.uuid4().hex,lambda s,c: (_ for _ in ()).throw(ValueError('NO_CLOUD_IN_RECALL')),lambda e:None,lambda n,c:contextlib.nullcontext(),lambda:None,memory=QAMemory(Path(sys.argv[1]).expanduser()))
try:
    fresh.recall()
    directory=Path(${JSON.stringify(metadata.directory)})
    if directory.parent!=Path(sys.argv[1]).expanduser()/'logs/cloud-hid-agent' or directory.name!=${JSON.stringify(metadata.task_id)}:raise ValueError('QA_ARTIFACT_SCOPE')
    files={p.name:base64.b64encode(p.read_bytes()).decode() for p in directory.iterdir() if p.is_file()}
    print(json.dumps({'independentMemory':raw,'freshAgentRecall':fresh.recalled,'files':files}),flush=True)
finally:fresh.close()
`
    const readbackChannel = await board.openDesktopRuntime(getSource)
    let readbackText = '',
      readbackError = ''
    readbackChannel.on('data', (chunk) => {
      readbackText += chunk.toString()
    })
    readbackChannel.stderr.on('data', (chunk) => {
      readbackError += chunk.toString()
    })
    const readbackCode = await new Promise((resolve) => readbackChannel.on('close', resolve))
    if (readbackCode !== 0) throw Error('READBACK_FAILED:' + readbackError)
    const readback = JSON.parse(readbackText)
    await mkdir(output + '/board')
    for (const [name, data] of Object.entries(readback.files)) {
      if (!/^[a-zA-Z0-9_.-]+$/.test(name)) throw Error('ARTIFACT_NAME_INVALID')
      await writeFile(output + '/board/' + name, Buffer.from(data, 'base64'))
    }
    delete readback.files
    await save('independent-readback.json', readback)
    const summary = {
      terminal,
      code,
      labClicks: state.clicks,
      cloudCalls: cloudCalls.length,
      rkModelCalls: 0,
      agentLocation: 'rk',
      inputBackend: 'rk_usb_hid',
      protocolStartToTerminalMs: terminalMs - submittedMs,
      timingBoundary:
        'RK BrowserRuntime protocol start -> terminal, one PC monotonic clock; no product 4s notice, GUI/phone or preparation included',
      realBilibiliTest: false,
      observations: 'synthetic phases mapped to guarded native Apply button',
      qaKey,
      memoryId: readback.independentMemory.memory?.id,
      freshSessionRecallId: readback.freshAgentRecall?.id,
      agentMetadata: metadata,
    }
    await save('summary.json', summary)
    if (
      terminal?.phase !== 'completed' ||
      state.clicks !== 2 ||
      cloudCalls.length !== 2 ||
      summary.memoryId !== summary.freshSessionRecallId ||
      !summary.memoryId
    )
      throw Error('LIVE_ACCEPTANCE_FAILED')
    console.log(JSON.stringify({ passed: true, ...summary }))
  } catch (error) {
    await save('failure.json', {
      message: error.message,
      stdout: error.stdout,
      stderr: error.stderr,
    })
    process.exitCode = 1
  } finally {
    observer?.kill()
    lab?.kill()
    await board?.disconnect()
    app.exit(process.exitCode ?? 0)
  }
}
app.whenReady().then(main)
