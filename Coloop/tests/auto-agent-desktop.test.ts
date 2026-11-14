import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { AutoAgentDesktop } from '../src/main/services/auto-agent-desktop'
import type { AutoAgentAction, AutoAgentTask } from '../src/shared/auto-agent-work'

function fixture() {
  const at = new Date().toISOString()
  const text =
    'Exact original assistant response with enough content to bind this target conversation. ' +
    'A'.repeat(100) +
    ' End of the original response.'
  const session = {
    id: 'desktop:one',
    source: 'chatgpt-desktop' as const,
    instanceId: 'instance',
    sessionId: 'native',
    title: 'ChatGPT',
    workspace: 'D:\\Coloop',
    turnId: 'turn',
    revision: 2,
    state: 'idle' as const,
    lastSeenAt: at,
    capabilities: {
      events: 'available' as const,
      nativeContinue: 'unknown' as const,
      reply: 'unknown' as const,
      stop: 'unknown' as const,
      desktopWrite: 'unknown' as const,
    },
  }
  const task: AutoAgentTask = {
    id: randomUUID(),
    version: 1,
    session,
    goal: 'finish',
    authorization: 'current task',
    acceptance: ['done'],
    supplements: [],
    state: 'watching',
    createdAt: at,
    updatedAt: at,
    lastEvaluatedRevision: 1,
    decisions: [],
    actions: [],
    feedback: [],
    costTaskId: 'test',
    events: [
      {
        id: randomUUID(),
        sessionId: session.id,
        instanceId: session.instanceId,
        turnId: 'turn',
        revision: 2,
        type: 'stopped',
        at,
        text,
        origin: 'agent',
      },
    ],
  }
  const action: AutoAgentAction = {
    id: randomUUID(),
    decisionId: randomUUID(),
    taskVersion: 1,
    eventRevision: 2,
    channel: 'desktop',
    status: 'prepared',
    message: 'Continue the unfinished checks.',
    expectedChange: 'check result',
    createdAt: at,
    updatedAt: at,
  }
  const message = `[Coloop Auto Agent Work:${action.id}]\n${action.message}`
  const frame = {
    window_id: '42',
    process_id: 100,
    fingerprint: 'image',
    png: Buffer.from('x'),
    control_targets: [{ name: text }],
  }
  const view = {
    ...frame,
    observation_id: 'view',
    captured_at: Date.now(),
    content_hash: 'image',
    ocr_text: text,
    ocr_items: [],
    targets: [{ id: 1, type: 'Edit', runtime_id: [1, 2] }],
    editable_runtime_id: [1, 2],
  }
  const capture = {
    withAgentWindow: vi.fn(async (callback: () => Promise<unknown>) => callback()),
    captureFrame: vi.fn(async () => frame),
    recognize: vi.fn(async () => view),
    readDraft: vi.fn().mockResolvedValueOnce({ text: '' }).mockResolvedValue({ text: message }),
    verifyCurrentText: vi.fn(async (..._args: unknown[]) => ({ verified: true, source: 'uia' })),
  }
  const execution = {
    begin: vi.fn(async () => {}),
    execute: vi.fn(async (_value: unknown) => ({ effect: 'confirmed' })),
    stop: vi.fn(async () => {}),
    status: vi.fn(async (_value: unknown): Promise<Record<string, unknown>> => ({})),
    resumeDraft: vi.fn(async (_value: unknown) => ({})),
  }
  const forget = vi.fn()
  const register = vi.fn()
  const renew = vi.fn(() => true)
  const desktop = new AutoAgentDesktop({
    capture,
    execution,
    assertAvailable: () => {},
    session: () => session,
    registerMessage: register,
    renewMessage: renew,
    forgetMessage: forget,
  } as unknown as ConstructorParameters<typeof AutoAgentDesktop>[0])
  return {
    desktop,
    task,
    action,
    capture,
    execution,
    forget,
    register,
    renew,
    frame,
    view,
    message,
  }
}

describe('guarded Auto Work desktop send', () => {
  it.each(['my unsent draft', '和 Codex 一起工作', ' \n'])(
    'preserves an existing draft %j without pasting or sending',
    async (text) => {
      const f = fixture()
      f.capture.readDraft.mockReset().mockResolvedValue({ text })
      await expect(
        f.desktop.send(f.task, f.action, new AbortController().signal),
      ).rejects.toMatchObject({ notSent: true })
      expect(f.execution.execute).not.toHaveBeenCalled()
      expect(f.forget).toHaveBeenCalledWith(f.action.id)
    },
  )
  it('rejects a different conversation before touching input', async () => {
    const f = fixture()
    f.capture.recognize.mockResolvedValue({ ...f.view, ocr_text: 'another chat' })
    f.capture.captureFrame.mockResolvedValue({ ...f.frame, control_targets: [] })
    await expect(
      f.desktop.send(f.task, f.action, new AbortController().signal),
    ).rejects.toMatchObject({ notSent: true })
    expect(f.execution.execute).not.toHaveBeenCalled()
  })
  it('preserves the matching RK focus failure receipt and safe checks before submission', async () => {
    const f = fixture()
    f.capture.recognize.mockResolvedValue({ ...f.view, editable_runtime_id: [] })
    const diagnostics = {
      category: 'input_target',
      stage: 'input.validate',
      checks: {
        same: true,
        inside: true,
        observedPointMatches: false,
      },
    }
    const receipt = {
      task_id: f.task.id,
      generation: f.action.id,
      command_id: `${f.action.id}:focus`,
      action: 'click',
      outcome: 'not_sent',
      release_confirmed: true,
      error: 'INPUT_TARGET_CHANGED',
      diagnostics: {
        ...diagnostics,
        text: 'private draft',
        checks: { ...diagnostics.checks, title: 'private title' },
      },
    }
    f.execution.execute.mockRejectedValueOnce(
      Object.assign(new Error('INPUT_TARGET_CHANGED'), { receipt }),
    )
    const error = await f.desktop
      .send(f.task, f.action, new AbortController().signal)
      .catch((error) => error)
    expect(error).toMatchObject({
      notSent: true,
      message: 'INPUT_TARGET_CHANGED',
      diagnostics,
      receipt: { ...receipt, diagnostics },
    })
    expect(error.receipt).not.toBe(receipt)
    expect(JSON.stringify(error.receipt)).not.toContain('private')
    expect(f.execution.execute).toHaveBeenCalledTimes(1)
    expect(f.execution.execute.mock.calls[0]?.[0]).toMatchObject({
      action: { action: 'click' },
      command_id: `${f.action.id}:focus`,
    })
    expect(f.capture.readDraft).not.toHaveBeenCalled()
    expect(f.register).not.toHaveBeenCalled()
    expect(f.forget).toHaveBeenCalledWith(f.action.id)
    expect(f.execution.stop).toHaveBeenCalledOnce()
  })
  it.each(['task_id', 'generation', 'command_id', 'oversized', 'cyclic'])(
    'does not preserve an invalid pre-submit focus receipt: %s',
    async (invalid) => {
      const f = fixture()
      f.capture.recognize.mockResolvedValue({ ...f.view, editable_runtime_id: [] })
      const receipt: Record<string, unknown> = {
        task_id: f.task.id,
        generation: f.action.id,
        command_id: `${f.action.id}:focus`,
        outcome: 'not_sent',
        release_confirmed: true,
      }
      if (invalid === 'oversized') receipt.padding = 'x'.repeat(16384)
      else if (invalid === 'cyclic') receipt.cycle = receipt
      else receipt[invalid] = 'another-action'
      f.execution.execute.mockRejectedValueOnce(
        Object.assign(new Error('INPUT_TARGET_CHANGED'), { receipt }),
      )
      const error = await f.desktop
        .send(f.task, f.action, new AbortController().signal)
        .catch((error) => error)
      expect(error.notSent).toBe(true)
      expect(error.receipt).toBeUndefined()
      expect(f.execution.execute).toHaveBeenCalledTimes(1)
    },
  )
  it('keeps safe local binding checks but does not accept a capture error as an RK receipt', async () => {
    const f = fixture()
    const diagnostics = {
      category: 'editor_binding',
      checks: { targetRuntime: false, focused: true },
    }
    f.capture.readDraft.mockReset().mockRejectedValueOnce(
      Object.assign(new Error('EDITOR_BINDING_CHANGED'), {
        diagnostics: {
          ...diagnostics,
          text: 'private draft',
          checks: { ...diagnostics.checks, editable_text: 'private draft' },
        },
        receipt: {
          task_id: f.task.id,
          generation: f.action.id,
          command_id: `${f.action.id}:focus`,
        },
      }),
    )
    const error = await f.desktop
      .send(f.task, f.action, new AbortController().signal)
      .catch((error) => error)
    expect(error).toMatchObject({ notSent: true, diagnostics })
    expect(error.receipt).toBeUndefined()
    expect(f.execution.execute).not.toHaveBeenCalled()
  })
  it('stops before Enter when a person changes the pasted draft', async () => {
    const f = fixture()
    f.capture.readDraft
      .mockReset()
      .mockResolvedValueOnce({ text: '' })
      .mockResolvedValue({ text: 'human edit' })
    await expect(f.desktop.send(f.task, f.action, new AbortController().signal)).rejects.toThrow(
      '不符',
    )
    expect(f.execution.execute).toHaveBeenCalledTimes(1)
    expect(f.forget).not.toHaveBeenCalled()
  })
  it('rejects a switch to another window even when it displays the same assistant reply', async () => {
    const f = fixture()
    f.capture.captureFrame
      .mockResolvedValueOnce(f.frame)
      .mockResolvedValue({ ...f.frame, window_id: 'other-window', process_id: 101 })
    f.capture.recognize
      .mockResolvedValueOnce(f.view)
      .mockResolvedValue({ ...f.view, window_id: 'other-window', process_id: 101 })
    await expect(
      f.desktop.send(f.task, f.action, new AbortController().signal),
    ).rejects.toBeTruthy()
    expect(f.execution.execute).toHaveBeenCalledTimes(1)
    expect(f.execution.execute.mock.calls[0]?.[0]).toMatchObject({ action: { action: 'paste' } })
  })
  it('keeps a paste transport timeout unknown and does not retry or press Enter', async () => {
    const f = fixture()
    f.execution.execute.mockRejectedValueOnce(new Error('transport timeout'))
    const error = await f.desktop
      .send(f.task, f.action, new AbortController().signal)
      .catch((value) => value)
    expect(error.message).toBe('transport timeout')
    expect(error.notSent).toBeUndefined()
    expect(f.execution.execute).toHaveBeenCalledTimes(1)
    expect(f.forget).not.toHaveBeenCalled()
  })
  it('does not send after user cancellation following paste', async () => {
    const f = fixture()
    const controller = new AbortController()
    f.execution.execute.mockImplementationOnce(async () => {
      controller.abort()
      return { effect: 'confirmed' }
    })
    await expect(f.desktop.send(f.task, f.action, controller.signal)).rejects.toBeTruthy()
    expect(f.execution.execute).toHaveBeenCalledTimes(1)
  })
  it('sends only once and leaves delivery acceptance distinct from task completion', async () => {
    const f = fixture()
    expect((await f.desktop.send(f.task, f.action, new AbortController().signal)).status).toBe(
      'accepted',
    )
    expect(f.execution.execute).toHaveBeenCalledTimes(2)
    expect(f.register).toHaveBeenCalledWith(f.task, f.action, f.message)
  })
  it('rechecks the full draft at paste and Enter guards without needing a selection', async () => {
    const f = fixture()
    let draft = ''
    f.action.message = '中文\nCODE \n'
    const message = `[Coloop Auto Agent Work:${f.action.id}]\n${f.action.message}`
    f.capture.readDraft.mockReset().mockImplementation(async () => ({ text: draft }))
    f.execution.execute.mockImplementation(async (value) => {
      const request = value as { action: { action: string }; task_id: string; command_id: string }
      await f.desktop.guardInput('input.validate', f.view as never, request)
      await f.desktop.guardInput('input.guard', f.view as never, request)
      if (request.action.action === 'paste') draft = message
      return { effect: 'confirmed' }
    })
    await expect(
      f.desktop.send(f.task, f.action, new AbortController().signal),
    ).resolves.toMatchObject({ status: 'accepted' })
    expect(f.capture.readDraft).toHaveBeenCalledTimes(6)
    expect(f.register).toHaveBeenCalledWith(f.task, f.action, message)
  })
  it('rejects user takeover after observation but before the first input guard', async () => {
    const f = fixture()
    f.capture.readDraft
      .mockReset()
      .mockResolvedValueOnce({ text: '' })
      .mockResolvedValue({ text: 'human draft' })
    f.execution.execute.mockImplementation(async (value) => {
      await f.desktop.guardInput('input.guard', f.view as never, value as Record<string, unknown>)
      return { effect: 'confirmed' }
    })
    await expect(f.desktop.send(f.task, f.action, new AbortController().signal)).rejects.toThrow(
      'USER_DRAFT_CHANGED',
    )
    expect(f.execution.execute).toHaveBeenCalledTimes(1)
    expect(f.forget).not.toHaveBeenCalled()
  })
  it('rechecks user takeover after clipboard preparation before the actual key-down', async () => {
    const f = fixture()
    let draft = ''
    f.capture.readDraft.mockReset().mockImplementation(async () => ({ text: draft }))
    let pressed = false
    f.execution.execute.mockImplementation(async (value) => {
      const request = value as Record<string, unknown>
      await f.desktop.guardInput('input.guard', f.view as never, request)
      draft = 'human edit after clipboard.prepare'
      await f.desktop.guardInput('input.guard', f.view as never, request)
      pressed = true
      return { effect: 'confirmed' }
    })
    await expect(f.desktop.send(f.task, f.action, new AbortController().signal)).rejects.toThrow(
      'USER_DRAFT_CHANGED',
    )
    expect(pressed).toBe(false)
    expect(f.execution.execute).toHaveBeenCalledTimes(1)
    expect(f.capture.readDraft).toHaveBeenCalledTimes(3)
  })
  it('scopes exact paste verification to the owned command, target and full expected message', async () => {
    const f = fixture()
    f.execution.execute.mockImplementation(async (value) => {
      const request = value as { action: { action: string; target_id: number; text: string } }
      if (request.action.action === 'paste') {
        const callback = {
          ...(value as Record<string, unknown>),
          observation_id: f.view.observation_id,
        }
        expect(
          await f.desktop.verifyPaste(f.view as never, { ...callback, task_id: 'other' }),
        ).toBeUndefined()
        expect(
          await f.desktop.verifyPaste(f.view as never, { ...callback, command_id: 'other' }),
        ).toBeUndefined()
        for (const changed of [
          { observation_id: 'other' },
          { action: { ...request.action, target_id: 2 } },
          { action: { ...request.action, text: 'partial match' } },
          { action: { ...request.action, action: 'type' } },
        ])
          expect(
            await f.desktop.verifyPaste(f.view as never, { ...callback, ...changed }),
          ).toMatchObject({ verified: false })
        expect(f.capture.verifyCurrentText).not.toHaveBeenCalled()
        expect(await f.desktop.verifyPaste(f.view as never, callback)).toMatchObject({
          verified: true,
        })
      }
      return { effect: 'confirmed' }
    })
    await f.desktop.send(f.task, f.action, new AbortController().signal)
    expect(f.capture.verifyCurrentText).toHaveBeenCalledExactlyOnceWith(
      f.view,
      f.message,
      true,
      'editor-height',
    )
    expect(await f.desktop.verifyPaste(f.view as never, {})).toBeUndefined()
  })
})

function recoveryFixture() {
  const f = fixture()
  f.action.status = 'unknown'
  f.capture.readDraft.mockReset().mockResolvedValue({ text: f.message })
  const pasteReceipt = {
    task_id: f.task.id,
    generation: f.action.id,
    command_id: `${f.action.id}:paste`,
    action: 'paste',
    outcome: 'unknown',
    release_confirmed: true,
  }
  f.execution.status.mockImplementation(async (raw) => {
    const value = raw as { command_id: string }
    if (value.command_id.endsWith(':paste')) return { receipt: pasteReceipt }
    throw Object.assign(new Error('COMMAND_NOT_FOUND'), { code: 'COMMAND_NOT_FOUND' })
  })
  const claim = vi.fn()
  return { ...f, pasteReceipt, claim }
}

describe('explicit recovery of an owned unsent draft', () => {
  it('proves the old paste and absence of Enter, then sends Enter once without pasting again', async () => {
    const f = recoveryFixture()
    expect(
      await f.desktop.resumeDraft(f.task, f.action, new AbortController().signal, f.claim),
    ).toMatchObject({ status: 'accepted' })
    expect(f.execution.begin).not.toHaveBeenCalled()
    expect(f.execution.execute).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        command_id: `${f.action.id}:send`,
        generation: f.action.id,
        action: { action: 'hotkey', target_id: 1, keys: 'ENTER' },
      }),
    )
    expect(f.claim).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        draftLength: f.message.length,
        draftSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        sendAbsent: true,
      }),
    )
    expect(f.renew).toHaveBeenCalledWith(f.task, f.action, f.message)
  })
  it.each(['input_sent', 'unknown', 'not_sent'])(
    'never repeats an already journaled Enter (%s)',
    async (outcome) => {
      const f = recoveryFixture()
      f.execution.status.mockImplementation(async (raw) => ({
        receipt: (raw as { command_id: string }).command_id.endsWith(':paste')
          ? f.pasteReceipt
          : { outcome },
      }))
      await expect(
        f.desktop.resumeDraft(f.task, f.action, new AbortController().signal, f.claim),
      ).rejects.toThrow('已记录')
      expect(f.execution.resumeDraft).not.toHaveBeenCalled()
      expect(f.execution.execute).not.toHaveBeenCalled()
      expect(f.claim).not.toHaveBeenCalled()
    },
  )
  it('does not interpret an RPC error as proof that Enter is absent', async () => {
    const f = recoveryFixture()
    f.execution.status.mockImplementation(async (raw) => {
      if ((raw as { command_id: string }).command_id.endsWith(':paste'))
        return { receipt: f.pasteReceipt }
      throw new Error('COMMAND_NOT_FOUND') // message alone is insufficient
    })
    await expect(
      f.desktop.resumeDraft(f.task, f.action, new AbortController().signal, f.claim),
    ).rejects.toThrow()
    expect(f.execution.execute).not.toHaveBeenCalled()
  })
  it.each([
    { release_confirmed: false },
    { generation: 'other' },
    { action: 'hotkey' },
    { outcome: 'dispatching' },
  ])('rejects insufficient paste proof %j', async (change) => {
    const f = recoveryFixture()
    Object.assign(f.pasteReceipt, change)
    await expect(
      f.desktop.resumeDraft(f.task, f.action, new AbortController().signal, f.claim),
    ).rejects.toThrow('回执不足')
    expect(f.execution.execute).not.toHaveBeenCalled()
  })
  it('preserves a person-edited draft, including whitespace changes', async () => {
    const f = recoveryFixture()
    f.capture.readDraft.mockResolvedValue({ text: f.message + ' ' })
    await expect(
      f.desktop.resumeDraft(f.task, f.action, new AbortController().signal, f.claim),
    ).rejects.toThrow('草稿已变化')
    expect(f.execution.resumeDraft).not.toHaveBeenCalled()
    expect(f.execution.execute).not.toHaveBeenCalled()
  })
  it('honors pause after claiming the durable action and before Enter', async () => {
    const f = recoveryFixture(),
      controller = new AbortController()
    f.claim.mockImplementation(() => controller.abort())
    await expect(
      f.desktop.resumeDraft(f.task, f.action, controller.signal, f.claim),
    ).rejects.toThrow()
    expect(f.execution.execute).not.toHaveBeenCalled()
    expect(f.execution.stop).toHaveBeenCalledOnce()
  })
  it('checks takeover again at the actual Enter guard', async () => {
    const f = recoveryFixture()
    let pressed = false
    f.execution.execute.mockImplementation(async (value) => {
      f.capture.readDraft.mockResolvedValue({ text: 'new human draft' })
      await f.desktop.guardInput('input.guard', f.view as never, value as Record<string, unknown>)
      pressed = true
      return { effect: 'confirmed' }
    })
    await expect(
      f.desktop.resumeDraft(f.task, f.action, new AbortController().signal, f.claim),
    ).rejects.toThrow('USER_DRAFT_CHANGED')
    expect(pressed).toBe(false)
  })
  it('requires a renewed same-action receipt registration before input', async () => {
    const f = recoveryFixture()
    f.renew.mockReturnValue(false)
    await expect(
      f.desktop.resumeDraft(f.task, f.action, new AbortController().signal, f.claim),
    ).rejects.toThrow('归属无法续期')
    expect(f.execution.resumeDraft).not.toHaveBeenCalled()
    expect(f.execution.execute).not.toHaveBeenCalled()
  })
})
