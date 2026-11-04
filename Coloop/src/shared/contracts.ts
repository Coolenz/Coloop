import { z } from 'zod'
import type { VioloopSnapshot } from './violoop'
import type { AutoConnectionSnapshot } from './connection'
import type { CoordinatorSnapshot } from './coordinator'
import type { HookSnapshot } from './hooks'
import type { SessionControlSnapshot, SessionCommandInput, CommandSnapshot } from './sessions'
import type { CredentialCreate, CredentialRecord, CredentialProtection } from './credentials'
import type {
  MemoryBrowse,
  MemoryBrowseResult,
  MemorySave,
  MemoryRevise,
  MemoryRemove,
} from './memory'
import type { MobileConnectionSnapshot, MobilePairingView } from './mobile'
import type { DesktopRequest, DesktopSnapshot } from './desktop'
import type { ProactiveState } from './proactive'

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
  serviceDirectory: z
    .string()
    .trim()
    .min(1)
    .max(1024)
    .refine(
      (value) => /^(\/|~\/)/.test(value) && !/[\x00-\x1f]/.test(value),
      '请输入板端绝对路径或 ~/ 开头的路径',
    )
    .optional(),
  servicePort: z.number().int().min(1).max(65535).optional(),
})
export const settingsSchema = z.object({
  provider: providerSchema,
  board: boardSchema,
  ocrWorkspace: z.string().trim().min(1).max(1024).default('D:/RK'),
})
export const taskRequestSchema = z.object({
  prompt: z.string().trim().min(1, '请先输入任务').max(24000),
  target: z.enum(['hybrid', 'cloud', 'rk']),
  context: z.string().max(50000).default(''),
  source: z.enum(['text', 'screen']).default('text'),
  intent: z.literal('execute').optional(),
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
  target: 'hybrid' | 'cloud' | 'rk'
  source: 'text' | 'screen'
  status: TaskStatus
  createdAt: string
  finishedAt?: string
  answer: string
  error?: string
  stage: string
  model: string
  execution?: 'desktop'
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
  model?: string
  modelContext?: number
  modelRuntime?: string
  modelPrivacyReady?: boolean
  hookRelayReady?: boolean
  hookLauncher?: string
  modelServiceStatus?: 'ready' | 'stopped' | 'error'
  modelServiceError?: string
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
  coordinator?: CoordinatorSnapshot & { connectionPath?: string; error?: string }
  hooks?: HookSnapshot
  sessionControl?: SessionControlSnapshot
  credentials?: CredentialProtection
  mobile?: MobileConnectionSnapshot
  desktop?: DesktopSnapshot
  violoop?: VioloopSnapshot
  autoConnection?: AutoConnectionSnapshot
  proactive?: ProactiveState
}
export type Result<T> = { ok: true; value: T } | { ok: false; error: string }
export interface DesktopApi {
  startProactiveTask(goal: string): Promise<Result<string>>
  stopProactiveTask(): Promise<Result<void>>
  pauseProactiveObservation(paused: boolean): Promise<Result<void>>
  acceptProactiveSuggestion(id: string): Promise<Result<void>>
  dismissProactiveSuggestion(id: string): Promise<Result<void>>
  answerProactiveQuestion(input: {
    taskId: string
    questionId: string
    answer: string
  }): Promise<Result<void>>
  browseMemories(input: MemoryBrowse): Promise<Result<MemoryBrowseResult>>
  saveMemory(input: MemorySave): Promise<Result<void>>
  reviseMemory(input: MemoryRevise): Promise<Result<void>>
  removeMemory(input: MemoryRemove): Promise<Result<void>>
  openPrivateMemory(id: string): Promise<Result<void>>
  openPrivateMemoryEditor(): Promise<Result<void>>
  closePrivateMemoryEditor(): Promise<Result<void>>
  onMemorySaved(callback: (indexed: boolean) => void): () => void
  listDesktopWindows(): Promise<Result<string[]>>
  startDesktopTask(request: DesktopRequest): Promise<Result<string>>
  stopDesktopTask(): Promise<Result<void>>
  protectCredentials(active: boolean): Promise<Result<void>>
  listCredentials(): Promise<Result<CredentialRecord[]>>
  createCredential(input: CredentialCreate): Promise<Result<CredentialRecord>>
  deleteCredential(id: string): Promise<Result<void>>
  openCredentialLogin(id: string): Promise<Result<void>>
  snapshot(): Promise<Result<AppSnapshot>>
  saveSettings(input: SettingsInput): Promise<Result<Settings>>
  importRk(): Promise<Result<Settings>>
  connect(password: string): Promise<Result<DeviceState>>
  retryRkConnection(): Promise<Result<void>>
  disconnect(): Promise<Result<void>>
  refreshDevice(): Promise<Result<DeviceState>>
  startRkService(): Promise<Result<DeviceState>>
  captureScreen(displayId?: string): Promise<Result<Capture | null>>
  listDisplays(): Promise<Result<{ id: string; name: string }[]>>
  openImage(): Promise<Result<Capture | null>>
  recognize(id: string): Promise<Result<OcrResult>>
  dispatchTask(request: TaskRequest): Promise<Result<{ id: string }>>
  runTask(request: TaskRequest): Promise<Result<string>>
  cancelTask(id: string): Promise<Result<void>>
  controlSession(input: SessionCommandInput): Promise<Result<CommandSnapshot>>
  stopSessionControl(): Promise<Result<void>>
  resumeSessionControl(): Promise<Result<void>>
  previewControlIndicator(): Promise<Result<void>>
  enableMobile(): Promise<Result<MobileConnectionSnapshot>>
  importMobileServer(): Promise<Result<boolean>>
  disableMobile(): Promise<Result<void>>
  createMobilePairing(): Promise<Result<MobilePairingView>>
  revokeMobileDevice(id: string): Promise<Result<void>>
  testProvider(): Promise<Result<string>>
  exportHistory(): Promise<Result<boolean>>
  clearHistory(): Promise<Result<void>>
  copyText(text: string): Promise<Result<void>>
  onSnapshot(callback: (snapshot: AppSnapshot) => void): () => void
}
