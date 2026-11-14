import { z } from 'zod'

export const credentialFieldSchema = z.enum(['username', 'password'])
export type CredentialField = z.infer<typeof credentialFieldSchema>
export const credentialRecordSchema = z
  .object({
    id: z.uuid(),
    origin: z.string().max(500),
    createdAt: z.number().int().nonnegative(),
  })
  .strict()
export type CredentialRecord = z.infer<typeof credentialRecordSchema>
export const credentialCreateSchema = z
  .object({
    origin: z.string().max(500),
    username: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[\x20-\x7e]+$/),
    password: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[\x20-\x7e]+$/),
  })
  .strict()
export type CredentialCreate = z.infer<typeof credentialCreateSchema>
export type CredentialProtection = { protected: boolean; loginOpen: boolean; editorOpen?: boolean }
export interface PrivateMemoryEntryApi {
  save(input: CredentialCreate): Promise<{ ok: boolean; indexed?: boolean }>
  close(): Promise<void>
}
export type PrivateLoginState = {
  recordId: string
  origin: string
  busy: boolean
  message: string
  outcome?: 'not_sent' | 'input_sent' | 'unknown'
}
export interface PrivateLoginApi {
  state(): Promise<PrivateLoginState>
  fill(field: CredentialField): Promise<PrivateLoginState>
  close(): Promise<void>
  onChange(callback: (state: PrivateLoginState) => void): () => void
}
