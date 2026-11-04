import { z } from 'zod'
import { remoteFrameSchema } from './remote'

export const relayConfigurationSchema = z
  .object({
    version: z.literal(1),
    endpoint: z
      .string()
      .max(2048)
      .url()
      .refine((value) => {
        const url = new URL(value)
        return (
          url.protocol === 'https:' &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash &&
          /^\/h\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(url.pathname)
        )
      }, '请使用服务器生成的 HTTPS 连接地址'),
    token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    accessKey: z
      .string()
      .min(6)
      .max(128)
      .regex(/^[\x21-\x7e]+$/),
  })
  .strict()
export type RelayConfiguration = z.infer<typeof relayConfigurationSchema>
export const relayJobsSchema = z
  .object({
    jobs: z
      .array(
        z
          .object({
            id: z.string().uuid(),
            path: z.enum(['/v1/remote/pair', '/v1/remote/rpc']),
            frame: remoteFrameSchema,
          })
          .strict(),
      )
      .max(8),
  })
  .strict()

export function isRemoteEndpoint(url: URL): boolean {
  return (
    url.protocol === 'https:' &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash &&
    (url.pathname === '/' ||
      /^\/h\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(url.pathname))
  )
}
