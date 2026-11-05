import { randomUUID } from 'node:crypto'

// This plugin has no filesystem, shell, browser or input implementation. Every
// effect is delegated to the host's existing, task-scoped capability registry.
export const name = 'coloop-capabilities'
export const inject = ['tools', 'systemPrompt', 'agents']

export async function apply(ctx, config) {
  const { validateJsonSchemaValue } = await import(process.env.COLOOP_HARNESS_TOOLS_MODULE)
  const endpoint = process.env.COLOOP_HARNESS_BRIDGE
  const token = process.env.COLOOP_HARNESS_BRIDGE_TOKEN
  if (!endpoint || !token) throw new Error('COLOOP_BRIDGE_NOT_CONFIGURED')
  async function call(path, body, signal) {
    const response = await fetch(endpoint + path, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    })
    const result = await response.json()
    if (!response.ok) throw new Error(result.error ?? 'COLOOP_BRIDGE_ERROR')
    return result
  }

  const definition = await call('/definition', {})
  for (const tool of definition.tools) {
    if (!/^coloop_[a-z0-9_]+$/.test(tool.name)) throw new Error('COLOOP_TOOL_NAME_INVALID')
    ctx.tools.register({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      isConcurrencySafe: () => false,
      async execute(args, execution) {
        const errors = validateJsonSchemaValue(tool.parameters, args)
        if (errors.length) throw new Error('COLOOP_TOOL_ARGUMENTS_INVALID: ' + errors.join('; '))
        const response = await call('/tool', {
          name: tool.name,
          arguments: args,
          callId: execution.callId,
          sessionId: execution.agent.id,
        }, execution.signal)
        return JSON.stringify(response.result ?? null)
      },
    })
  }

  // Complete prompt replacement happens inside the official assembly seam;
  // tool visibility is enforced again by the host at dispatch time.
  ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    const state = await call('/state', {}, context.signal)
    const result = await next()
    return {
      ...result,
      sections: [{ name: 'coloop', text: state.instructions, interpolate: false }],
      tools: result.tools.filter(tool => state.tools.includes(tool.name)),
    }
  })
  ctx.on('agent/turn-stopping', async ({ agent, signal }) => {
    const result = await call('/completion', {}, signal)
    if (!result.finished) agent.steer({
      id: randomUUID(),
      content: [{ type: 'text', text: result.message ?? 'Continue the task and verify the result.' }],
      source: { kind: 'user' },
    })
  })
}
