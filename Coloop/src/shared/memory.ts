import { z } from 'zod'

export const memoryKindSchema = z.enum(['fact', 'preference', 'procedure', 'task'])
export const memoryCategorySchema = z.enum(['all', 'ordinary', 'private'])
export const memoryTagsSchema = z
  .array(
    z
      .string()
      .trim()
      .min(1)
      .max(64)
      .refine((tag) => !/[\u0000-\u001f]/.test(tag)),
  )
  .max(8)
export const memoryBrowseSchema = z
  .object({
    query: z.string().max(1000).default(''),
    category: memoryCategorySchema.default('all'),
    offset: z.number().int().min(0).max(100000).default(0),
    limit: z.number().int().min(1).max(50).default(25),
    tag: z.string().trim().max(64).optional(),
    sort: z.enum(['source', 'title']).optional(),
  })
  .strict()
export const ordinaryMemorySchema = z
  .object({
    id: z.string().max(128),
    category: z.literal('ordinary'),
    key: z.string().nullable(),
    text: z.string(),
    kind: memoryKindSchema,
    source: z.string(),
    verified: z.boolean(),
    expiresAt: z.number().nullable(),
    tags: memoryTagsSchema.optional(),
    summary: z.string().max(160).optional(),
    sourceTaskId: z.string().max(128).nullable().optional(),
    updatedAt: z.union([z.string(), z.number()]).nullable().optional(),
  })
  .strict()
export const privateMemorySchema = z
  .object({
    id: z.string().max(128),
    category: z.literal('private'),
    recordId: z.uuid(),
    origin: z.string().max(500),
    locator: z.string().max(100),
    resolver: z.literal('coloop_private_login'),
    protected: z.literal(true),
  })
  .strict()
export const memoryEntrySchema = z.discriminatedUnion('category', [
  ordinaryMemorySchema,
  privateMemorySchema,
])
export const memoryBrowseResultSchema = z.object({
  mode: z.enum(['all', 'literal', 'semantic']),
  items: z.array(memoryEntrySchema).max(50),
  total: z.number().int().nonnegative(),
  offset: z.number().int(),
  limit: z.number().int(),
  private_memory: z.object({
    enabled: z.boolean(),
    available: z.boolean(),
    records: z.number().int(),
  }),
})
export const memorySaveSchema = z
  .object({
    key: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .refine((value) => !value.startsWith('private:credential:')),
    value: z.string().min(1).max(1000),
    kind: memoryKindSchema,
    tags: memoryTagsSchema.optional(),
    summary: z.string().max(160).optional(),
  })
  .strict()
export const memoryReviseSchema = z
  .object({
    id: z.uuid(),
    value: z.string().min(1).max(1000),
    tags: memoryTagsSchema.optional(),
    summary: z.string().max(160).optional(),
  })
  .strict()
export const memoryRemoveSchema = z.discriminatedUnion('category', [
  z.object({ category: z.literal('ordinary'), id: z.uuid() }).strict(),
  z.object({ category: z.literal('private'), recordId: z.uuid() }).strict(),
])
export type MemoryEntry = z.infer<typeof memoryEntrySchema>
export type MemoryBrowse = z.input<typeof memoryBrowseSchema>
export type MemoryBrowseResult = z.infer<typeof memoryBrowseResultSchema>
export type MemorySave = z.infer<typeof memorySaveSchema>
export type MemoryRevise = z.infer<typeof memoryReviseSchema>
export type MemoryRemove = z.infer<typeof memoryRemoveSchema>
