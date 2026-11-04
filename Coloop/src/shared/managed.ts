import { z } from 'zod'

const id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/)
const hash = z.string().regex(/^[a-f0-9]{64}$/)
export const managedEvidenceSchema = z
  .object({
    version: z.literal(1),
    enrollmentId: id,
    operation: z.literal('read'),
    snapshotId: id,
    sessionId: id,
    messageId: id,
    instanceId: id,
    taskId: id,
    pid: z.number().int().positive(),
    relativePath: z.string().min(1).max(1024),
    sha256: hash,
    bytes: z.number().int().min(1).max(65536),
    returnedBytes: z.number().int().min(1).max(4096),
    returnedSha256: hash,
    truncated: z.boolean(),
    extension: z
      .string()
      .min(1)
      .max(16)
      .regex(/^\.[a-z0-9]+$/),
    routeDigest: hash,
    proof: hash,
  })
  .strict()

export const managedPermitSchema = z
  .object({
    version: z.literal(1),
    authorityId: hash,
    enrollmentId: id,
    snapshotId: id,
    operation: z.literal('read'),
    sha256: hash,
    returnedBytes: z.number().int().min(1).max(4096),
    returnedSha256: hash,
    truncated: z.boolean(),
    sessionId: id,
    requestHash: hash,
    instanceId: id,
    taskId: id,
    expiresAt: z.string().datetime({ offset: true }),
    nonce: id,
    signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/),
  })
  .strict()

export type ManagedEvidence = z.infer<typeof managedEvidenceSchema>
export type ManagedPermit = z.infer<typeof managedPermitSchema>
export interface ManagedConnection {
  version: 1
  enrollmentId: string
  root: string
  routeDigest: string
  proofKey: string
  approvalPublicKey: string
  authorityId: string
  configPath: string
  configSha256: string
}
