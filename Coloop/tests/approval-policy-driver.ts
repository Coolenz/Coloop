/** Fixed-suite policy driver. No NPU, no allow result, no permit issuance. */
import { createHash, randomUUID } from 'node:crypto'
import { lstat, readFile, writeFile, unlink, link, symlink, mkdir } from 'node:fs/promises'
import { extname, join, relative, resolve, sep, posix } from 'node:path'
import { performance } from 'node:perf_hooks'
import { evaluateReviewPolicy } from '../src/main/domain/review-policy'
import { ManagedApprovalAuthority } from '../src/main/services/managed-approvals'
import { AgentHookService } from '../src/main/services/agent-hooks'
import { CoordinatorService, requestHash } from '../src/main/services/coordinator'
import { canonicalJson, reviewEventSchema, type ReviewEvent } from '../src/shared/coordinator'
import { managedEvidenceSchema, type ManagedEvidence } from '../src/shared/managed'
import type { HookEnvelope } from '../src/shared/hooks'
// @ts-ignore -- the production core is deliberately JavaScript, bundled unchanged.
import * as managedCore from '../../RK/rk-opencode/agent/coloop_managed_core.mjs'
const { normalizedRelativePath, checkedSnapshot, proofFor } = managedCore

type Value = Record<string, any>
const sha = (input: string | Buffer) => createHash('sha256').update(input).digest('hex')
const blocked = (value: string) => ['deny', 'defer', 'reject', 'block'].includes(value)
const publicError = (error: unknown) => {
  const value = error as { reasonCode?: string; code?: string; message?: string }
  return (
    [value.reasonCode, value.code, value.message].find(
      (v) => typeof v === 'string' && /^[A-Z][A-Z0-9_]{0,99}$/.test(v),
    ) ?? 'POLICY_DRIVER_ERROR'
  )
}
const sources = (value: unknown) => sha(canonicalJson(value))

async function execute(input: Value) {
  if (
    input.layer !== 'policy' ||
    !/^[a-z][a-z0-9-]{1,95}$/.test(input.case_id ?? '') ||
    !input.aliases?.WORKSPACE
  )
    throw new Error('POLICY_CASE_REQUIRED')
  const started = performance.now(),
    workspace = resolve(input.aliases.WORKSPACE)
  const sourceMetadata = JSON.parse(
    await readFile(process.argv[1].replace(/\.mjs$/, '.sources.json'), 'utf8'),
  )
  const sourceCoreHash = (Object.entries(sourceMetadata.files) as [string, string][]).find(
    ([path]) => path.replaceAll('\\', '/').endsWith('/rk-opencode/agent/coloop_managed_core.mjs'),
  )?.[1]
  if (!sourceCoreHash) throw new Error('POLICY_SOURCE_MANIFEST_REQUIRED')
  const folder = resolve(workspace, '..')
  const evidenceFolder = resolve(folder, '../../evidence', input.case_id)
  const configFile = join(input.aliases.AUX, 'policy-source-config.json')
  const links: string[] = []
  const trace: Value = {
    case_id: input.case_id,
    layer: 'policy',
    source_verification_simulated_for_policy_only: true,
    linux_snapshot_open_exercised: false,
    npu_calls: 0,
    permit_issued: false,
    public_input_sha256: sources(input),
    bundle_sha256: sha(await readFile(process.argv[1])),
    product_sources: sourceMetadata.files,
    steps: [],
  }
  const receipt: Value = {
    case_id: input.case_id,
    status: 'completed',
    policy: 'unsupported',
    decision: 'defer',
    source: 'policy',
    rk_request_ids: [],
    reply_mode: 'none',
    reply_count: 0,
    release_count: 0,
    release_bytes: 0,
    builtin_read_count: 0,
    scan_open_count: 0,
    output_text: '',
    final_text: '',
    assertions: {},
    policy_only: true,
    source_verification_simulated_for_policy_only: true,
    npu_called: false,
    managed_tool: input.request.tool,
    tool_attempted: false,
  }
  const sourceId = 'source-' + randomUUID(),
    instanceId = 'instance-' + randomUUID()
  const sessionId = 'session-' + randomUUID(),
    taskId = 'task-' + randomUUID()
  let sequence = 0,
    captured: ReviewEvent | undefined,
    assessed: Value | undefined
  let sourceConnected = true,
    privacyAck = true,
    sourceVerifyCalls = 0,
    modelAttempts = 0
  let authority: ManagedApprovalAuthority
  const hooks = new AgentHookService({
    workspaceRoots: () => [workspace],
    onChange: () => {},
    review: async (event) => {
      captured = event
      assessed = event.managed
        ? await authority.assess(event)
        : await evaluateReviewPolicy(event, [workspace])
      trace.steps.push({
        method: event.managed ? 'ManagedApprovalAuthority.assess' : 'evaluateReviewPolicy',
        event_sha256: requestHash(event),
        result: assessed,
      })
      // This callback is explicitly a policy classifier. A candidate is not
      // converted into an approval, model response or signed permit.
      return {
        version: 1,
        id: event.id,
        sessionId: event.sessionId,
        requestHash: requestHash(event),
        decision: assessed.decision === 'candidate' ? 'defer' : assessed.decision,
        source: 'policy',
        reasonCode: assessed.reasonCode ?? 'POLICY_ONLY_NO_MODEL',
        expiresAt: event.expiresAt,
      }
    },
  })
  const baseConfig: Value = {
    enabled_providers: ['rkllm'],
    memory: 'disabled',
    plugins: ['production-managed-tool'],
    provider: {
      rkllm: {
        model: 'qwen35-4b-rkllm',
        url: 'http://127.0.0.1:8088/v1',
        headers: { 'X-RK-Privacy': 'metadata-only', 'X-RK-Cache': 'off' },
      },
    },
  }
  await writeFile(configFile, canonicalJson(baseConfig), { mode: 0o600 })
  const initialConfig = await readFile(configFile)
  authority = new ManagedApprovalAuthority({
    origin: (event) => hooks.resolveOrigin(event),
    verifySource: async (enrollment, value) => {
      sourceVerifyCalls++
      if (!sourceConnected) throw new Error('SIMULATED_SSH_DISCONNECTED')
      const current = await readFile(configFile)
      const verified =
        sha(current) === enrollment.configSha256 && privacyAck && value.pid === process.pid
      trace.steps.push({
        method: 'policy_only_source_verifier',
        current_config_sha256: sha(current),
        enrolled_config_sha256: enrollment.configSha256,
        pid_matches: value.pid === process.pid,
        privacy_ack: privacyAck,
        result: verified,
      })
      return verified
    },
  })
  const connection = authority.enroll({
    sourceId,
    workspace,
    root: '/managed/project',
    configPath: '/managed/.runtime/coloop-managed/config.json',
    config: initialConfig,
    sourceHashes: { 'agent/coloop_managed_core.mjs': sourceCoreHash },
  })
  const coordinator = new CoordinatorService({
    generate: async () => {
      modelAttempts++
      throw new Error('POLICY_DRIVER_FORBIDS_MODEL')
    },
    managedAuthority: authority,
    isBusy: () => false,
    onChange: () => {},
    workspaceRoots: () => [workspace],
    resolveContext: (event) => hooks.resolveContext(event),
    hookHandler: (path, body) =>
      path === '/v1/hooks' ? hooks.ingest(body) : hooks.reviewHook(body),
  })
  const event = (kind: HookEnvelope['kind'], payload: Value, changes: Value = {}): HookEnvelope =>
    ({
      version: 1,
      source: 'opencode',
      sourceId,
      instanceId,
      sessionId,
      taskId,
      sequence: ++sequence,
      eventId: 'event-' + randomUUID(),
      workspace,
      kind,
      payload,
      ...changes,
    }) as HookEnvelope
  const safePath = (path: string) => {
    const value = resolve(path),
      boundary = relative(folder, value)
    if (boundary === '..' || boundary.startsWith('..' + sep) || resolve(value) === folder)
      throw new Error('POLICY_FIXTURE_ESCAPE')
    return value
  }
  const mutateConfig = async (change: (value: Value) => void) => {
    const value = JSON.parse((await readFile(configFile)).toString('utf8'))
    change(value)
    await writeFile(configFile, canonicalJson(value), { mode: 0o600 })
  }
  const originalNow = Date.now
  let clockShift = 0
  const advance = (milliseconds: number) => {
    clockShift += milliseconds
    Date.now = () => originalNow() + clockShift
    trace.steps.push({ method: 'controlled_clock_advance', milliseconds })
  }
  try {
    await hooks.ingest(
      event('message', {
        role: 'user',
        messageId: taskId,
        partId: 'part-initial',
        text: 'Synthetic policy case; no fixture content is sent here.',
      }),
    )
    for (const [index, value] of (input.history ?? []).entries()) {
      await hooks.ingest(
        event('message', {
          role: 'assistant',
          messageId: 'history-' + index,
          partId: 'history-part-' + index,
          text:
            (value.role === 'memory' ? 'Untrusted, unverified memory observation: ' : '') +
            value.text,
        }),
      )
    }
    for (const value of input.fixture_links ?? []) {
      const path = safePath(value.path),
        target = safePath(value.target)
      try {
        if (value.kind === 'hardlink') await link(target, path)
        else if (value.kind === 'symlink') await symlink(target, path, 'file')
        else throw new Error('UNSUPPORTED_LINK_KIND')
        links.push(path)
        const info = await lstat(path)
        trace.steps.push({
          method: 'lstat_fixture_link',
          symbolic: info.isSymbolicLink(),
          nlink: info.nlink,
          path_sha256: sha(path),
          linux_directory_fd_open_tested: false,
        })
      } catch (error) {
        receipt.status = 'unsupported'
        receipt.error_code = 'HOST_LINK_CREATION_UNAVAILABLE'
        trace.steps.push({ method: 'create_fixture_link', error: publicError(error) })
        return receipt
      }
    }
    let snapshot: Value | undefined,
      relativePath = 'src/main.py'
    const request: Value = input.request
    if (request.kind === 'permission') {
      const template = input.request_template.filePath as string
      relativePath = template.startsWith('${WORKSPACE}/')
        ? template.slice('${WORKSPACE}/'.length)
        : request.filePath
      try {
        relativePath = normalizedRelativePath(relativePath)
        trace.steps.push({
          method: 'normalizedRelativePath',
          input_sha256: sha(relativePath),
          result: 'accepted',
        })
      } catch (error) {
        receipt.policy = 'deny'
        receipt.reason_code = publicError(error)
        trace.steps.push({ method: 'normalizedRelativePath', error: publicError(error) })
        return receipt
      }
      if (request.tool === 'coloop_read') {
        const path = safePath(join(workspace, ...relativePath.split('/')))
        try {
          // Portable lstat screening is policy-only. Native Linux descriptor
          // pinning is exercised separately by the root/native controller.
          let ancestor = workspace
          for (const part of relativePath.split('/')) {
            ancestor = join(ancestor, part)
            const info = await lstat(ancestor)
            if (
              info.isSymbolicLink() ||
              (!info.isDirectory() && (!info.isFile() || info.nlink !== 1))
            )
              throw new Error('POLICY_LSTAT_UNSAFE_FILE')
          }
          const info = await lstat(path)
          if (!info.isFile()) throw new Error('POLICY_LSTAT_UNSAFE_FILE')
          receipt.scan_open_count++
          snapshot = checkedSnapshot(await readFile(path)) as Value
          trace.steps.push({
            method: 'checkedSnapshot',
            result: { ...snapshot, text: undefined },
            snapshot_text_omitted: true,
          })
          if (input.scenario.type === 'replace_after_snapshot') {
            await writeFile(path, await readFile(safePath(input.scenario.replacement)))
          } else if (input.scenario.type === 'delete_after_snapshot') await unlink(path)
          else if (input.scenario.type === 'symlink_after_snapshot') {
            await unlink(path)
            try {
              await symlink(safePath(input.scenario.replacement), path, 'file')
              links.push(path)
              const after = await lstat(path)
              trace.steps.push({
                method: 'lstat_after_snapshot_replacement',
                symbolic: after.isSymbolicLink(),
                nlink: after.nlink,
                path_sha256: sha(path),
                linux_directory_fd_open_tested: false,
              })
            } catch (error) {
              receipt.status = 'unsupported'
              receipt.error_code = 'HOST_LINK_CREATION_UNAVAILABLE'
              trace.steps.push({ method: 'symlink_after_snapshot', error: publicError(error) })
              return receipt
            }
          }
          if (
            ['replace_after_snapshot', 'delete_after_snapshot', 'symlink_after_snapshot'].includes(
              input.scenario.type,
            )
          ) {
            receipt.assertions.snapshot_unchanged =
              sha(Buffer.from(snapshot.text)) === snapshot.returnedSha256
            receipt.assertions.no_reopen_after_snapshot = receipt.scan_open_count === 1
            trace.steps.push({
              method: 'inspect_frozen_checkedSnapshot_after_mutation',
              unchanged: receipt.assertions.snapshot_unchanged,
            })
          }
          if (input.scenario.type === 'long_utf8_prefix')
            receipt.assertions.utf8_prefix_truncation_marked =
              snapshot.truncated === true &&
              snapshot.returnedBytes <= 4096 &&
              !snapshot.text.includes('\ufffd')
        } catch (error) {
          receipt.policy = 'deny'
          receipt.reason_code = publicError(error)
          trace.steps.push({ method: 'portable_snapshot_prescan', error: publicError(error) })
          return receipt
        }
      }
    }
    const first = input.fixture_files?.[0]
    // Wrong-tool requests are blocked before scan. Metadata inputs for that
    // adversarial authority call come from preparation, never a claimed scan.
    const fields: Value = {
      version: 1,
      enrollmentId: connection.enrollmentId,
      operation: 'read',
      snapshotId: 'snapshot-' + randomUUID(),
      sessionId,
      instanceId,
      taskId,
      messageId: 'assistant-message',
      pid: process.pid,
      relativePath,
      sha256: snapshot?.sha256 ?? first?.sha256 ?? sha('fixture'),
      bytes: snapshot?.bytes ?? first?.bytes ?? 7,
      returnedBytes: snapshot?.returnedBytes ?? first?.bytes ?? 7,
      returnedSha256: snapshot?.returnedSha256 ?? first?.sha256 ?? sha('fixture'),
      truncated: snapshot?.truncated ?? false,
      extension: extname(relativePath).toLowerCase(),
      routeDigest: connection.routeDigest,
    }
    const route = input.route_scenario
    if (route === 'session_mismatch') fields.sessionId = 'other-session'
    if (route === 'instance_mismatch') fields.instanceId = 'other-instance'
    if (route === 'model_changed')
      await mutateConfig((value) => {
        value.provider.rkllm.model = 'other-model'
      })
    if (route === 'provider_changed')
      await mutateConfig((value) => {
        value.provider.rkllm.url = 'https://example.invalid/v1'
      })
    if (route === 'extra_plugin')
      await mutateConfig((value) => {
        value.plugins.push('untrusted-extra-plugin')
      })
    if (route === 'cloud_fallback')
      await mutateConfig((value) => {
        value.enabled_providers.push('cloud')
      })
    if (route === 'redirect')
      await mutateConfig((value) => {
        value.provider.rkllm.url += '/redirect'
      })
    if (route === 'privacy_header_missing')
      await mutateConfig((value) => {
        delete value.provider.rkllm.headers['X-RK-Privacy']
      })
    if (route === 'memory_remote')
      await mutateConfig((value) => {
        value.memory = 'remote'
      })
    if (route === 'config_changed_after_snapshot')
      await mutateConfig((value) => {
        value.changed_after_snapshot = true
      })
    if (route === 'gateway_disconnected') sourceConnected = false
    if (route === 'privacy_ack_missing') privacyAck = false
    const managed: Value = { ...fields, proof: proofFor(fields, connection.proofKey) }
    if (route === 'unsigned') managed.proof = '0'.repeat(64)
    const base: Value =
      request.kind === 'question'
        ? { ...request, id: 'permission', sessionId }
        : {
            id: 'permission',
            sessionId,
            kind: 'permission',
            tool: request.tool,
            patterns: [posix.join(connection.root, relativePath)],
            managed,
            ...(request.command !== undefined ? { command: request.command } : {}),
          }
    if (route === 'missing') delete base.managed
    const raw = {
      version: 1,
      ...base,
      workspace,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 180000).toISOString(),
    }
    if (
      !reviewEventSchema.safeParse(raw).success ||
      (base.managed && !managedEvidenceSchema.safeParse(base.managed).success)
    ) {
      receipt.policy = 'reject'
      receipt.reason_code = 'INVALID_REVIEW_EVENT'
      trace.steps.push({ method: 'reviewEventSchema', result: 'rejected' })
      return receipt
    }
    trace.steps.push({ method: 'reviewEventSchema', result: 'accepted' })
    const approval: Value = { ...base, originalDigest: sources(base) }
    const modifications: Value = {}
    if (route === 'source_mismatch' || input.scenario.type === 'cross_source')
      modifications.sourceId = 'other-source'
    if (input.scenario.type === 'cross_instance') modifications.instanceId = 'other-instance'
    if (input.scenario.type === 'cross_task') modifications.taskId = 'other-task'
    if (input.scenario.type === 'cross_session') {
      modifications.sessionId = 'other-session'
      approval.sessionId = 'other-session'
    }
    const packet = event('approval', { approval }, modifications)
    if (input.scenario.type === 'snapshot_digest_changed')
      packet.payload.approval!.managed!.sha256 = '0'.repeat(64)
    if (route === 'expired') authority.revokeSource(sourceId)
    if (input.scenario.type === 'old_sequence') packet.sequence = 1
    if (input.scenario.type === 'conflicting_event') {
      const seed = event('message', { text: 'Original observation' })
      await hooks.ingest(seed)
      await hooks.ingest({ ...seed, payload: { text: 'Conflicting observation' } })
      throw new Error('CONFLICTING_EVENT_UNEXPECTEDLY_ACCEPTED')
    }
    if (input.scenario.type === 'duplicate_json_key') {
      const token = 'policy-only-' + randomUUID()
      const { url } = await coordinator.start({ token })
      const message = event('message', { text: 'Duplicate-key grammar probe.' })
      const body = JSON.stringify(message).replace(
        `"sequence":${message.sequence}`,
        `"sequence":${message.sequence},"sequence":${message.sequence}`,
      )
      const response = await fetch(url + '/v1/hooks', {
        method: 'POST',
        body,
        headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      })
      const result = await response.json()
      receipt.policy = response.status >= 400 ? 'reject' : 'accepted'
      receipt.reason_code =
        response.status >= 400
          ? String((result as Value).error ?? 'HTTP_REJECTED')
          : 'DUPLICATE_FIELD_ACCEPTED'
      receipt.assertions.stale_or_untrusted_context_not_authority = response.status >= 400
      trace.steps.push({
        method: 'CoordinatorService_authenticated_HTTP_duplicate_field',
        status: response.status,
        result_sha256: sources(result),
        duplicate_field: 'sequence',
        body_sha256: sha(body),
      })
      return receipt
    }
    const response = await hooks.reviewHook(packet)
    receipt.policy = assessed?.decision ?? response.decision.decision
    receipt.reason_code = assessed?.reasonCode ?? response.decision.reasonCode
    if (input.scenario.type === 'original_digest_changed') {
      const changed = structuredClone(packet)
      changed.sequence = ++sequence
      changed.eventId = 'event-' + randomUUID()
      changed.payload.approval!.originalDigest = '0'.repeat(64)
      await hooks.reviewHook(changed)
      receipt.policy = 'accepted'
      receipt.assertions.stale_or_untrusted_context_not_authority = false
    }
    if (
      ['compacted', 'closed', 'approval_expired', 'path_changed_after_approval'].includes(
        input.scenario.type,
      ) &&
      captured
    ) {
      const previous = structuredClone(captured)
      if (input.scenario.type === 'approval_expired') advance(180001)
      else if (input.scenario.type === 'path_changed_after_approval')
        previous.patterns = ['/managed/other-project/changed.py']
      else await hooks.ingest(event(input.scenario.type as 'compacted' | 'closed', {}))
      const replay = await coordinator.review(previous)
      receipt.policy = replay.decision
      receipt.reason_code = replay.reasonCode
      receipt.assertions.stale_or_untrusted_context_not_authority =
        blocked(replay.decision) && !replay.permit && modelAttempts === 0
      trace.steps.push({
        method: 'CoordinatorService.review_legacy_after_invalidation',
        result: replay,
        cached_allow_tested: false,
        actual_model_calls: 0,
      })
    }
    if (input.scenario.type === 'replay_consumed' && captured) {
      const previous = structuredClone(captured)
      const completion = event('status', {
        state: 'approval.completed',
        relatedEventId: packet.eventId,
        originalDigest: packet.payload.approval!.originalDigest,
      })
      await hooks.ingest(completion)
      let retiredReplay = false
      try {
        await hooks.reviewHook(event('approval', { approval }))
      } catch (error) {
        retiredReplay = publicError(error) === 'HOOK_APPROVAL_EXPIRED'
      }
      const replay = await coordinator.review(previous)
      receipt.policy = replay.decision
      receipt.reason_code = replay.reasonCode
      receipt.assertions.stale_or_untrusted_context_not_authority =
        retiredReplay &&
        !hooks.resolveContext(previous) &&
        blocked(replay.decision) &&
        !replay.permit &&
        modelAttempts === 0
      trace.steps.push({
        method: 'AgentHookService_approval_completed_then_generic_replay',
        related_event_sha256: sha(packet.eventId),
        retired_approval_replay_blocked: retiredReplay,
        result: replay,
        completion_simulated_for_policy_only: true,
        native_consumption_exercised: false,
        actual_model_calls: 0,
      })
    }
    if (input.scenario.type === 'replay_after_release') {
      receipt.status = 'unsupported'
      receipt.error_code = 'POLICY_ONLY_CANNOT_ASSERT_NATIVE_RELEASE_REPLAY'
    }
    if (route !== 'managed_local')
      receipt.assertions.unverified_route_not_released =
        blocked(receipt.policy) && !response.decision.permit
    if (
      [
        'cross_source',
        'cross_instance',
        'cross_session',
        'cross_task',
        'snapshot_digest_changed',
        'untrusted_authority',
      ].includes(input.scenario.type)
    )
      receipt.assertions.stale_or_untrusted_context_not_authority =
        blocked(receipt.policy) && !response.decision.permit
    return receipt
  } catch (error) {
    const code = publicError(error)
    trace.steps.push({ method: 'product_exception', error: code })
    if (code === 'POLICY_DRIVER_ERROR') {
      receipt.status = 'error'
      receipt.error_code = code
    } else {
      receipt.policy = 'reject'
      receipt.reason_code = code
    }
    if (
      ['old_sequence', 'conflicting_event', 'original_digest_changed'].includes(input.scenario.type)
    )
      receipt.assertions.stale_or_untrusted_context_not_authority = code.startsWith('HOOK_')
    return receipt
  } finally {
    Date.now = originalNow
    await coordinator.dispose()
    await hooks.dispose()
    authority.revokeAll()
    for (const path of links) await unlink(path).catch(() => {})
    trace.source_verifier_calls = sourceVerifyCalls
    trace.model_callback_attempts = modelAttempts
    if (input.scenario.type === 'untrusted_authority' && (input.history?.length ?? 0) > 0)
      receipt.assertions.stale_or_untrusted_context_not_authority =
        blocked(receipt.policy) && modelAttempts === 0 && receipt.reply_count === 0
    trace.actual_policy = receipt.policy
    trace.reason_code = receipt.reason_code ?? receipt.error_code
    trace.cleanup = {
      hooks_stopped: hooks.snapshot().status === 'stopped',
      remaining_scopes: hooks.snapshot().sessionCount,
    }
    await mkdir(evidenceFolder, { recursive: true })
    const path = join(evidenceFolder, 'policy-trace.json')
    await writeFile(path, JSON.stringify(trace, null, 2), { mode: 0o600 })
    const runRoot = resolve(folder, '../..')
    receipt.evidence = [
      { kind: 'policy_trace', path: relative(runRoot, path), sha256: sha(await readFile(path)) },
    ]
    receipt.cleanup = {
      sessions: trace.cleanup.remaining_scopes === 0,
      processes: true,
      leases: true,
      connections: coordinator.snapshot().status === 'stopped',
    }
    receipt.timing_ms = { total: performance.now() - started }
    if (modelAttempts) {
      receipt.status = 'error'
      receipt.error_code = 'POLICY_MODEL_CALLBACK_ATTEMPTED'
    }
  }
}

const chunks: Buffer[] = []
let size = 0
for await (const chunk of process.stdin) {
  size += chunk.length
  if (size > 1024 * 1024) throw new Error('POLICY_INPUT_LIMIT')
  chunks.push(Buffer.from(chunk))
}
const input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))
const receipt = await execute(input)
process.stdout.write(JSON.stringify(receipt) + '\n')
