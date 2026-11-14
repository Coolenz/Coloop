import { taskApprovalAnswerSchema, type TaskApproval } from './task-approval'
import { z } from 'zod'
import { sessionCommandSchema } from './sessions'
import type { SessionControlSnapshot } from './sessions'
import { violoopMessageSchema, type VioloopSnapshot } from './violoop'
import type { RemoteConnection } from './connection'

const uuid = z.string().uuid()
const base64url = z.string().regex(/^[A-Za-z0-9_-]+$/)
export const remoteFrameSchema = z
  .object({
    version: z.literal(1),
    hostId: uuid,
    epoch: uuid,
    actorId: uuid,
    requestId: uuid,
    sequence: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    nonce: base64url.length(16),
    data: base64url.min(22).max(90_000),
  })
  .strict()
export const remotePairRequestSchema = z
  .object({
    deviceName: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .regex(/^[^\x00-\x1f]+$/),
  })
  .strict()
const empty = z.object({}).strict()
export const remoteRpcSchema = z.discriminatedUnion('operation', [
  z
    .object({
      operation: z.literal('approval_answer'),
      payload: taskApprovalAnswerSchema,
      expiresAt: z.number().int().safe(),
    })
    .strict(),
  z
    .object({
      operation: z.literal('reconnect'),
      payload: empty,
      expiresAt: z.number().int().safe(),
    })
    .strict(),
  z
    .object({
      operation: z.literal('violoop_message'),
      payload: violoopMessageSchema,
      expiresAt: z.number().int().safe(),
    })
    .strict(),
  z
    .object({
      operation: z.literal('snapshot'),
      payload: empty,
      expiresAt: z.number().int().safe(),
    })
    .strict(),
  z
    .object({
      operation: z.literal('command'),
      payload: sessionCommandSchema,
      expiresAt: z.number().int().safe(),
    })
    .strict(),
  z
    .object({ operation: z.literal('stop'), payload: empty, expiresAt: z.number().int().safe() })
    .strict(),
  z
    .object({ operation: z.literal('resume'), payload: empty, expiresAt: z.number().int().safe() })
    .strict(),
  z
    .object({ operation: z.literal('unpair'), payload: empty, expiresAt: z.number().int().safe() })
    .strict(),
])
export type RemoteFrame = z.infer<typeof remoteFrameSchema>
export type RemoteRpcRequest = z.infer<typeof remoteRpcSchema>
export interface RemotePairingPayload {
  version: 1
  endpoint: string
  hostId: string
  pairingId: string
  secret: string
  expiresAt: string
  accessKey?: string
}
export interface RemotePairingInvitation {
  payload: RemotePairingPayload
  uri: string
}
export interface RemoteMobileSnapshot {
  approval?: TaskApproval
  hostName: string
  sessionControl: SessionControlSnapshot
  progress: { sessionHandle: string; text: string; at: string }[]
  violoop?: VioloopSnapshot
  connection?: RemoteConnection
}
export interface RemoteGatewaySnapshot {
  status: 'stopped' | 'listening' | 'error'
  url?: string
  hostId: string
  devices: { id: string; name: string; createdAt: string; lastSeenAt: string }[]
  error?: string
}
export type RemoteResult =
  { ok: true; value: unknown } | { ok: false; error: { code: string; message: string } }
