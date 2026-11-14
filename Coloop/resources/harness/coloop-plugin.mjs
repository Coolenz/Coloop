import { randomUUID } from 'node:crypto'

// Host tools delegate to task-scoped services. Official MCP browser tools use
// DSH's native registry and share the host's current visibility gate.
export const name = 'coloop-capabilities'
export const inject = ['tools', 'systemPrompt', 'agents', 'workingDirectory', 'approval', 'userQuestions']

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
  const promptState = await call('/state', {})
  ctx.systemPrompt.section({
    name: 'coloop',
    order: ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
    text: () => promptState.instructions,
    interpolate: false,
  })
  // The host is the answer UI. DSH owns question validation and cancellation.
  ctx.on('user-questions/request', async (request) => {
    const question = request.questions[0]
    const response = await call('/tool', {
      name: 'coloop_ask_user',
      arguments: {
        question: question.question,
        ...(question.options ? { options: question.options.map(option => option.label) } : {}),
      },
      callId: question.id,
      sessionId: request.agent.id,
    }, request.signal)
    return { answers: [{ id: question.id, selected: [], custom: response.result.answer }] }
  })
  const visible = (state, name) => state.tools.includes(name) ||
    (state.playwrightEnabled && state.playwrightTools.includes(name))
  ctx.on('tools/pre-execute', async (execution, next) => {
    const decision = await next()
    if (decision.kind !== 'allow') return decision
    const state = await call('/state', { browserTools: [execution.name] }, execution.signal)
    if (!visible(state, execution.name)) return { kind: 'deny', reason: 'HARNESS_TOOL_DENIED' }
    return call('/tool-policy', {
      name: execution.name, arguments: execution.arguments,
      callId: execution.callId, sessionId: execution.agent?.id,
    }, execution.signal)
  })
  ctx.on('approval/request', async (request) => {
    const result = await call('/approval', {
      name: request.toolName, callId: request.callId, sessionId: request.agent.id,
    }, request.signal)
    return result.outcome
  })
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
        if (tool.name === 'coloop_ask_user') {
          const result = await ctx.userQuestions.ask({
            questions: [{
              id: execution.callId,
              question: args.question,
              ...(args.options ? { options: args.options.map(label => ({ label })) } : {}),
            }],
            agent: execution.agent,
            signal: execution.signal,
          })
          return JSON.stringify({ answer: result.answers[0].custom ?? result.answers[0].selected.join(', ') })
        }
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

  // Preserve registered sections from every plugin. This seam limits tools
  // and synchronizes the host-authorized working directory only.
  ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    const result = await next()
    const state = await call('/state', { browserTools: result.tools.map(tool => tool.name) }, context.signal)
    // Keep the original SDK project/history identity. The official service
    // validates the host-selected directory and records a durable transition;
    // no model argument can select or broaden this root.
    if (context.agent && state.workingDirectory &&
        ctx.workingDirectory.get(context.agent.session) !== state.workingDirectory) {
      await ctx.workingDirectory.set(context.agent, state.workingDirectory, context.signal)
    }
    return {
      ...result,
      sections: result.sections.map(section => section.name === 'coloop'
        ? { ...section, text: state.instructions }
        : section),
      tools: result.tools.filter(tool => visible(state, tool.name)),
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
