import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

// Persistent native Schedule host. The Session controller adapts delivery to
// Coloop's task queue, while DSH owns timing, storage and durable inboxes.
const require = createRequire(process.env.COLOOP_SCHEDULER_MANIFEST)
const modules = []
const load = async name => {
  if (name.startsWith('dsh-') && require('@deepseek-ai/' + name + '/package.json').version !== '0.2.1-rc.5')
    throw new Error('NATIVE_SCHEDULER_VERSION_MISMATCH')
  const path = require.resolve('@deepseek-ai/' + name)
  modules.push(path)
  return import(pathToFileURL(path).href)
}
const { Context } = await load('cordis')
const ctx = new Context()
const pending = new Map()
let sequence = 0
const host = (sessionId) => new Promise((resolve, reject) => {
  const id = ++sequence
  pending.set(id, { resolve, reject })
  process.send({ event: 'due', id, sessionId })
})
process.on('message', message => {
  if (message.reply === undefined) return
  const request = pending.get(message.reply)
  pending.delete(message.reply)
  if (message.error) request?.reject(new Error(message.error))
  else request?.resolve()
})
const root = process.env.COLOOP_SCHEDULER_HOME
for (const [name, config] of [
  ['dsh-llm'], ['dsh-session'], ['dsh-session-projection'], ['dsh-agent'],
  ['dsh-tools'], ['dsh-system-prompt'],
  ['dsh-session-persistence-jsonl', { root: join(root, 'sessions'), compression: 'none' }],
  ['dsh-agent-loop', { agents: [], maxParallelToolCalls: 1 }],
  ['dsh-storage'], ['dsh-storage-json', { root: join(root, 'storage') }],
  ['dsh-storage-domain', { backend: 'json' }],
]) {
  const module = await load(name)
  await ctx.plugin(module.default ?? module, config)
}
const handles = new Map()
const resolveAgent = async sessionId => {
  if (handles.has(sessionId)) return handles.get(sessionId)
  const existing = await ctx.sessionPersistence.stat(sessionId)
  const handle = existing
    ? await ctx.agents.resume({ resumeSessionId: sessionId })
    : await ctx.agents.create({ sessionId, meta: { cwd: root } })
  handles.set(sessionId, handle)
  return handle
}
ctx.provide('sessionController', { resolveAgent })
ctx.on('agent/pre-step', async ({ agent, messages }) => {
  if (messages.some(message => message.source?.kind === 'schedule')) await host(agent.id)
  return { kind: 'reject' }
})
const scheduleModule = await load('dsh-schedule')
const scheduleFiber = await ctx.plugin(scheduleModule.default ?? scheduleModule)
const close = async () => {
  await scheduleFiber.dispose()
  for (const handle of handles.values()) await handle.dispose()
  await ctx.fiber.dispose()
}
await ctx.schedule.catalog()
process.on('message', async message => {
  if (message.id === undefined || !message.method) return
  try {
    let value
    if (message.method === 'create') {
      await resolveAgent(message.sessionId)
      value = await ctx.schedule.create(message.sessionId, message.request)
    } else if (message.method === 'catalog') value = await ctx.schedule.catalog()
    else if (message.method === 'delete') value = await ctx.schedule.delete(message.request)
    else if (message.method === 'close') {
      await close()
      process.send({ id: message.id, value: true }, () => process.disconnect())
      return
    } else throw new Error('UNKNOWN_SCHEDULE_COMMAND')
    process.send({ id: message.id, value })
  } catch (error) {
    process.send({ id: message.id, error: error.message })
  }
})
process.on('disconnect', () => {
  for (const request of pending.values()) request.reject(new Error('HOST_DISCONNECTED'))
  pending.clear()
  void close().finally(() => process.exit())
})
process.send({ event: 'ready', modules })
