import {
  createHash,
  createHmac,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
  timingSafeEqual,
} from 'node:crypto'
import { posix } from 'node:path'
import { canonicalJson, type ReviewEvent } from '../../shared/coordinator'
import type { ManagedConnection, ManagedEvidence, ManagedPermit } from '../../shared/managed'
import { managedReadPolicy, type PolicyResult } from '../domain/review-policy'

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
export interface ManagedOrigin {
  sourceId: string
  instanceId: string
  sessionId: string
  taskId: string
  workspace: string
}
export interface ManagedEnrollment extends ManagedConnection {
  sourceId: string
  workspace: string
  sourceHashes: Record<string, string>
}
export interface ManagedAuthorityOptions {
  origin: (event: ReviewEvent) => ManagedOrigin | undefined
  verifySource: (enrollment: ManagedEnrollment, evidence: ManagedEvidence) => Promise<boolean>
}

/** Private signing key stays in the host process. Neither the source nor the model receives it. */
export class ManagedApprovalAuthority {
  private keys = generateKeyPairSync('ed25519')
  private enrollments = new Map<string, ManagedEnrollment>()
  private validated = new Map<string, { enrollment: ManagedEnrollment; at: number }>()
  readonly approvalPublicKey = this.keys.publicKey
    .export({ type: 'spki', format: 'pem' })
    .toString()
  readonly authorityId = hash(this.keys.publicKey.export({ type: 'spki', format: 'der' }))
  constructor(private options: ManagedAuthorityOptions) {}

  enroll(input: {
    sourceId: string
    workspace: string
    root: string
    configPath: string
    config: Buffer
    sourceHashes: Record<string, string>
  }): ManagedConnection {
    const configSha256 = hash(input.config)
    const routeDigest = hash(
      canonicalJson({
        configSha256,
        root: input.root,
        sourceHashes: input.sourceHashes,
        model: 'qwen35-4b-rkllm',
        endpoint: 'http://127.0.0.1:8088/v1',
        memory: 'disabled',
      }),
    )
    const connection: ManagedConnection = {
      version: 1,
      enrollmentId: randomUUID(),
      root: input.root,
      configPath: input.configPath,
      configSha256,
      routeDigest,
      proofKey: randomBytes(32).toString('hex'),
      approvalPublicKey: this.approvalPublicKey,
      authorityId: this.authorityId,
    }
    this.enrollments.set(connection.enrollmentId, {
      ...connection,
      sourceId: input.sourceId,
      workspace: input.workspace,
      sourceHashes: { ...input.sourceHashes },
    })
    return connection
  }
  revokeAll() {
    this.enrollments.clear()
    this.validated.clear()
  }
  revokeSource(sourceId: string) {
    for (const [id, value] of this.enrollments)
      if (value.sourceId === sourceId) this.enrollments.delete(id)
    for (const [id, value] of this.validated)
      if (value.enrollment.sourceId === sourceId) this.validated.delete(id)
  }

  private authenticated(event: ReviewEvent): ManagedEnrollment | undefined {
    const value = event.managed
    const origin = this.options.origin(event)
    if (
      !value ||
      !origin ||
      !event.contextRef ||
      event.kind !== 'permission' ||
      event.tool !== 'coloop_read' ||
      event.command !== undefined ||
      event.question ||
      event.choices ||
      origin.sessionId !== value.sessionId ||
      origin.instanceId !== value.instanceId ||
      origin.taskId !== value.taskId ||
      event.sessionId !== value.sessionId
    )
      return
    const enrollment = this.enrollments.get(value.enrollmentId)
    if (
      !enrollment ||
      origin.sourceId !== enrollment.sourceId ||
      origin.workspace !== enrollment.workspace ||
      event.workspace !== enrollment.workspace ||
      value.routeDigest !== enrollment.routeDigest ||
      event.patterns?.length !== 1 ||
      event.patterns[0] !== posix.join(enrollment.root, value.relativePath)
    )
      return
    const { proof, ...fields } = value
    const expected = createHmac('sha256', Buffer.from(enrollment.proofKey, 'hex'))
      .update(canonicalJson(fields))
      .digest()
    const actual = Buffer.from(proof, 'hex')
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return
    return enrollment
  }
  async assess(event: ReviewEvent): Promise<PolicyResult> {
    const enrollment = this.authenticated(event)
    if (!enrollment || !event.managed)
      return { decision: 'defer', reasonCode: 'UNVERIFIED_MANAGED_ROUTE' }
    const policy = managedReadPolicy(event.managed)
    if (policy.decision !== 'candidate') return policy
    try {
      if (!(await this.options.verifySource(enrollment, event.managed)))
        return { decision: 'defer', reasonCode: 'MANAGED_ROUTE_CHANGED' }
    } catch {
      return { decision: 'defer', reasonCode: 'MANAGED_ROUTE_UNAVAILABLE' }
    }
    if (this.authenticated(event) !== enrollment)
      return { decision: 'defer', reasonCode: 'MANAGED_ROUTE_CHANGED' }
    const key = hash(canonicalJson(event))
    this.validated.set(key, { enrollment, at: Date.now() })
    for (const [id, value] of this.validated)
      if (Date.now() - value.at > 180_000) this.validated.delete(id)
    return policy
  }
  issuePermit(event: ReviewEvent, requestHash: string): ManagedPermit | undefined {
    const enrollment = this.authenticated(event),
      value = event.managed
    const checked = this.validated.get(requestHash)
    if (
      !value ||
      !enrollment ||
      checked?.enrollment !== enrollment ||
      Date.now() - checked.at > 90_000 ||
      Date.now() >= Date.parse(event.expiresAt)
    )
      return
    const fields = {
      version: 1 as const,
      authorityId: this.authorityId,
      enrollmentId: enrollment.enrollmentId,
      snapshotId: value.snapshotId,
      operation: value.operation,
      sha256: value.sha256,
      returnedBytes: value.returnedBytes,
      returnedSha256: value.returnedSha256,
      truncated: value.truncated,
      sessionId: event.sessionId,
      instanceId: value.instanceId,
      taskId: value.taskId,
      requestHash,
      expiresAt: event.expiresAt,
      nonce: randomUUID(),
    }
    return {
      ...fields,
      signature: sign(null, Buffer.from(canonicalJson(fields)), this.keys.privateKey).toString(
        'base64',
      ),
    }
  }
  isCurrent(event: ReviewEvent): boolean {
    const enrollment = this.authenticated(event)
    const checked = this.validated.get(hash(canonicalJson(event)))
    return (
      !!enrollment &&
      checked?.enrollment === enrollment &&
      Date.now() - checked.at < 90_000 &&
      Date.now() < Date.parse(event.expiresAt)
    )
  }
}
