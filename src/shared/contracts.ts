import { z } from 'zod'

export const providerSchema = z.object({
  protocol: z.enum(['openai', 'anthropic', 'gemini']),
  name: z.string().trim().min(1).max(80),
  baseUrl: z
    .string()
    .url()
    .max(500)
    .refine((value) => {
      const u = new URL(value)
      return (
        !u.username &&
        !u.password &&
        !u.search &&
        !u.hash &&
        (u.protocol === 'https:' ||
          (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)))
      )
    }, '云端地址须使用 HTTPS；本地服务允许 HTTP'),
  model: z.string().trim().min(1).max(120),
  apiKey: z.string().max(2048).optional(),
  clearKey: z.boolean().optional(),
})
export const boardSchema = z.object({
  host: z
    .string()
    .trim()
    .min(1)
    .max(253)
    .regex(/^[a-zA-Z0-9.:%_-]+$/, '设备地址格式不正确'),
  port: z.number().int().min(1).max(65535),
  username: z
    .string()
    .trim()
    .regex(/^[a-z_][a-z0-9_-]{0,31}$/i),
  fingerprint: z
    .string()
    .trim()
    .regex(/^(SHA256:)?[A-Za-z0-9+/]{43}=?$/, '请输入 SHA256 设备指纹'),
})
export const settingsSchema = z.object({
  provider: providerSchema,
  board: boardSchema,
  ocrWorkspace: z.string().trim().min(1).max(1024).default('D:/RK'),
})
export const taskRequestSchema = z.object({
  prompt: z.string().trim().min(1, '请先输入任务').max(24000),
  target: z.enum(['cloud', 'rk']),
  context: z.string().max(50000).default(''),
  source: z.enum(['text', 'screen']).default('text'),
})
export type ProviderConfig = z.infer<typeof providerSchema>
export type BoardConfig = z.infer<typeof boardSchema>
export type SettingsInput = z.infer<typeof settingsSchema>
export type Settings = Omit<SettingsInput, 'provider'> & {
  provider: Omit<ProviderConfig, 'apiKey' | 'clearKey'> & { hasKey: boolean }
}
export type TaskRequest = z.infer<typeof taskRequestSchema>
export type TaskStatus = 'running' | 'completed' | 'failed' | 'cancelled'
export interface Task {
  id: string
  prompt: string
  target: 'cloud' | 'rk'
  source: 'text' | 'screen'
  status: TaskStatus
  createdAt: string
  finishedAt?: string
  answer: string
  error?: string
  stage: string
  model: string
}
export interface DeviceState {
  status: 'disconnected' | 'connecting' | 'connected' | 'error'
  error?: string
  hostname?: string
  chip?: string
  memoryTotalMb?: number
  memoryAvailableMb?: number
  temperatureC?: number
  uptimeSeconds?: number
  qwenReady?: boolean
  updatedAt?: string
  latencyMs?: number
}
export interface OcrItem {
  text: string
  confidence: number
  box: number[][]
  rect: number[]
  center: number[]
}
export interface OcrResult {
  text: string
  confidence: number
  durationMs: number
  language: string
  items: OcrItem[]
  coordinateSpace: 'image_pixels'
  engine: 'RapidOCR'
}
export interface Capture {
  id: string
  name: string
  dataUrl: string
  width: number
  height: number
}
export interface AppSnapshot {
  settings: Settings
  device: DeviceState
  tasks: Task[]
  version: string
  ocrBusy: boolean
  ocrProgress: number
}
export type Result<T> = { ok: true; value: T } | { ok: false; error: string }
export interface DesktopApi {
  snapshot(): Promise<Result<AppSnapshot>>
  saveSettings(input: SettingsInput): Promise<Result<Settings>>
  importRk(): Promise<Result<Settings>>
  connect(password: string): Promise<Result<DeviceState>>
  disconnect(): Promise<Result<void>>
  refreshDevice(): Promise<Result<DeviceState>>
  captureScreen(displayId?: string): Promise<Result<Capture | null>>
  listDisplays(): Promise<Result<{ id: string; name: string }[]>>
  openImage(): Promise<Result<Capture | null>>
  recognize(id: string): Promise<Result<OcrResult>>
  runTask(request: TaskRequest): Promise<Result<string>>
  cancelTask(id: string): Promise<Result<void>>
  testProvider(): Promise<Result<string>>
  exportHistory(): Promise<Result<boolean>>
  clearHistory(): Promise<Result<void>>
  copyText(text: string): Promise<Result<void>>
  onSnapshot(callback: (snapshot: AppSnapshot) => void): () => void
}
