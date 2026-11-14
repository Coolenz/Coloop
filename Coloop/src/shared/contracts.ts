import { z } from 'zod'
import type { LocalModelCapacity } from './local-model'
import type { PreferencesPatch } from './preferences'
import {
  executionPolicySchema,
  conversationCreateSchema,
  conversationUpdateSchema,
  type ConversationSnapshot,
  type ConversationDetail,
} from './conversations'
import type { ModelDebugRequest, ModelDebugRun, ModelDiagnostic, RoutePreview } from './model-debug'
import { modelLimitsSchema, modelPricingSchema, type ModelUsageSnapshot } from './model-usage'
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
import type {
  AutoAgentCreate,
  AutoAgentFeedbackInput,
  AutoAgentHookStatus,
  AutoAgentWorkSnapshot,
} from './auto-agent-work'

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
  contextWindow: z.number().int().min(1024).max(10000000).optional(),
  maxOutputTokens: z.number().int().min(1).max(1048576).optional(),
  imageInput: z.enum(['unknown', 'supported', 'unsupported']).optional(),
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
  decisionProvider: providerSchema.optional(),
  decisionPricing: modelPricingSchema.optional(),
  board: boardSchema,
  ocrWorkspace: z.string().trim().min(1).max(1024).default('D:/RK'),
  taskWorkspace: z.string().trim().min(1).max(2048).optional(),
  modelLimits: modelLimitsSchema.optional(),
  localModel: z
    .object({ outputTokens: z.number().int().min(1).max(1048576).optional() })
    .optional(),
  agentEngine: z.enum(['harness', 'tars']).optional(),
  browserEngine: z.enum(['stagehand', 'playwright']).optional(),
  autoTaskRouting: z.enum(['cloud', 'local-auto']).optional(),
  executionMode: z.enum(['cloud', 'local', 'local-auto']).optional(),
  allowCloudFallback: z.boolean().optional(),
  islandEnabled: z.boolean().optional(),
  islandDetailedNotifications: z.boolean().optional(),
  islandAttention: z.boolean().optional(),
  closeToTray: z.boolean().optional(),
  startHidden: z.boolean().optional(),
  launchOnLogin: z.boolean().optional(),
})
export const cloudFieldSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(40)
      .regex(/^[\p{L}\p{N}_ -]+$/u),
    type: z.enum(['identifier', 'number']),
  })
  .strict()
export type CloudField = z.infer<typeof cloudFieldSchema>
export const taskRequestSchema = z.object({
  policy: executionPolicySchema.optional(),
  prompt: z.string().trim().min(1, '请先输入任务').max(24000),
  target: z.enum(['hybrid', 'cloud', 'rk']),
  context: z.string().max(50000).default(''),
  source: z.enum(['text', 'screen']).default('text'),
  intent: z.literal('execute').optional(),
  workspace: z.string().trim().min(1).max(2048).optional(),
  cloudFields: z
    .array(cloudFieldSchema)
    .max(16)
    .refine(
      (fields) => new Set(fields.map((field) => field.name)).size === fields.length,
      'Duplicate approved fields',
    )
    .optional(),
})
export type ProviderConfig = z.infer<typeof providerSchema>
export type BoardConfig = z.infer<typeof boardSchema>
export type SettingsInput = z.infer<typeof settingsSchema>
export type Settings = Omit<SettingsInput, 'provider' | 'decisionProvider'> & {
  provider: Omit<ProviderConfig, 'apiKey' | 'clearKey'> & { hasKey: boolean }
  decisionProvider?: Omit<ProviderConfig, 'apiKey' | 'clearKey'> & { hasKey: boolean }
}
export type TaskRequest = z.infer<typeof taskRequestSchema>
export const scheduleRequestSchema = z
  .object({
    runAt: z.string().datetime({ offset: true }),
    timezone: z.string().min(1).max(100),
    request: taskRequestSchema,
    sourceTaskId: z.string().uuid().optional(),
  })
  .strict()
export type ScheduleRequest = z.infer<typeof scheduleRequestSchema>
export interface ScheduledTask extends ScheduleRequest {
  id: string
  taskId: string
  createdAt: string
  startedAt?: string
  finishedAt?: string
  status:
    | 'pending'
    | 'waiting'
    | 'dispatching'
    | 'running'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'unconfirmed'
  error?: string
}
export const voiceAudioSchema = z
  .string()
  .min(1)
  .max(7_000_000)
  .regex(/^[A-Za-z0-9+/]+={0,2}$/)

export interface VoiceTranscript {
  text: string
  confidence: number
  language: 'zh-CN'
  engine: 'windows_offline_speech'
  rejected_segments: number
  segments: { text: string; confidence: number }[]
}
export type TaskStatus = 'running' | 'completed' | 'failed' | 'cancelled'
export interface TaskHistoryEntry {
  kind: 'user' | 'assistant' | 'tool_call' | 'tool_result'
  text: string
  name?: string
  callId?: string
  at?: number
  error?: boolean
}
export interface TaskHistoryDetail {
  entries: TaskHistoryEntry[]
  notice?: string
  usage?: {
    requests: number
    tokenUnits: number
    estimatedCostYuan: number
    unpricedRequests: number
  }
  artifacts?: { id: string; path: string; sha256: string }[]
}
export interface Task {
  policy?: z.infer<typeof executionPolicySchema>
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
  localModelCapacity?: LocalModelCapacity
  modelRuntime?: string
  modelPrivacyReady?: boolean
  hookRelayReady?: boolean
  hookLauncher?: string
  modelServiceStatus?: 'ready' | 'stopped' | 'error'
  modelServiceError?: string
  updatedAt?: string
  latencyMs?: number
  clockOffsetMs?: number
  clockSyncedAt?: string
  clockSyncError?: string
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
  conversations?: ConversationSnapshot
  autoAgentWork?: AutoAgentWorkSnapshot
  modelUsage?: ModelUsageSnapshot
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
  schedules?: {
    entries: ScheduledTask[]
    error?: string
    runtime?: {
      state: 'starting' | 'ready' | 'recovering' | 'error' | 'stopped'
      retryCount: number
      nextRetryAt?: number
    }
  }
}
export type Result<T> = { ok: true; value: T } | { ok: false; error: string }
export interface DesktopApi {
  /** Main-window lifecycle acknowledgment, scoped to its trusted renderer. */
  rendererReady?(): void
  openTaskArtifact(input: { taskId: string; artifactId: string }): Promise<Result<void>>
  onOpenTask(callback: (taskId: string) => void): () => void
  updatePreferences(input: PreferencesPatch): Promise<Result<Settings>>
  browserConfig(input: unknown): Promise<Result<unknown>>
  startModelDebug(input: ModelDebugRequest): Promise<Result<string>>
  getModelDebug(id: string): Promise<Result<ModelDebugRun>>
  currentModelDebug(): Promise<Result<ModelDebugRun | undefined>>
  cancelModelDebug(id: string): Promise<Result<void>>
  previewTaskRoute(prompt: string): Promise<Result<RoutePreview>>
  modelDiagnostics(input: {
    taskId?: string
    model?: string
    since?: number
    path?: string
  }): Promise<Result<ModelDiagnostic[]>>
  createConversation(input: z.infer<typeof conversationCreateSchema>): Promise<Result<string>>
  updateConversation(input: z.input<typeof conversationUpdateSchema>): Promise<Result<void>>
  conversationDetail(id: string): Promise<Result<ConversationDetail>>
  sendConversation(input: {
    conversationId: string
    messageId: string
    text: string
    context?: string
    workspace?: string
  }): Promise<Result<{ conversationId: string; runId?: string; delivery: string }>>
  pauseQueue(paused: boolean): Promise<Result<void>>
  cancelQueuedTask(runId: string): Promise<Result<void>>
  resumeConversation(input: { conversationId: string; runId: string }): Promise<Result<void>>
  createAutoAgentWork(input: AutoAgentCreate): Promise<Result<string>>
  updateAutoAgentWork(input: {
    taskId: string
    action: 'pause' | 'resume' | 'unbind' | 'stop_agent' | 'supplement'
    text?: string
  }): Promise<Result<void>>
  submitAutoAgentFeedback(input: AutoAgentFeedbackInput): Promise<Result<void>>
  installAutoAgentHooks(input: { workspace: string }): Promise<Result<AutoAgentHookStatus>>
  uninstallAutoAgentHooks(input: { workspace: string }): Promise<Result<AutoAgentHookStatus>>
  refreshAutoAgentWork(input?: { workspace: string }): Promise<Result<void>>
  setAutoAgentEnabled(input: boolean): Promise<Result<{ enabled: boolean }>>
  testDecisionProvider(): Promise<Result<string>>
  startProactiveTask(goal: string): Promise<Result<string>>
  resumeProactiveTask(taskId: string): Promise<Result<string>>
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
  chooseTaskWorkspace(): Promise<Result<string | undefined>>
  transcribeVoice(audio: string): Promise<Result<VoiceTranscript>>
  cancelVoiceTranscription(): Promise<Result<void>>
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
  scheduleTask(request: ScheduleRequest): Promise<Result<ScheduledTask>>
  cancelScheduledTask(id: string): Promise<Result<void>>
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
  taskHistory(id: string): Promise<Result<TaskHistoryDetail>>
  clearHistory(): Promise<Result<void>>
  copyText(text: string): Promise<Result<void>>
  onSnapshot(callback: (snapshot: AppSnapshot) => void): () => void
}
