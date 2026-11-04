import type { Server } from 'node:http'
export function createRelay(options: {
  channels: { channelId: string; tokenHash: string }[]
  accessKeySalt: string
  accessKeyHash: string
  timeoutMs?: number
  pollMs?: number
  onlineMs?: number
  trustProxy?: boolean
}): { server: Server; close(): Promise<void> }
