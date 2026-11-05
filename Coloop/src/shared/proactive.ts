export interface ProactiveState {
  runtime?: 'harness' | 'tars'
  recoverable?: {
    taskId: string
    goal: string
    workspace?: string
    phase: string
    updatedAt: number
  }[]
  connected: boolean
  active: boolean
  phase: string
  taskId?: string
  suggestion?: Record<string, unknown>
  question?: Record<string, unknown>
  summary?: string
  error?: string
  recommendationError?: string
  progress?: { lastProgressAt: number; units: number; stalled: boolean; diagnostic?: string }
  memorySaved?: boolean
  observationPaused?: boolean
  model?: string
}

export const proactivePhaseLabels: Record<string, string> = {
  idle: '等待新任务',
  queued: '正在准备任务',
  planning: '正在规划下一步',
  observing: '正在读取当前窗口',
  executing: '正在执行单步操作',
  verifying: '正在回读实际结果',
  waiting_user: '等待你补充信息',
  waiting_source: '等待任务来源文件就绪',
  stopping: '正在等待 RK 停止确认',
  completed: '已通过实际结果核验',
  cancelled: '操作已停止',
  blocked: '任务未通过结果核验',
  failed: '任务执行未完成',
  input_unknown: '输入结果未确认，请检查目标窗口',
  offline: '等待连接 RK',
  suggestion: '当前窗口的下一步建议',
}

export const proactiveErrorLabels: Record<string, string> = {
  MODEL_PRICING_REQUIRED: '费用保护已开启，但缺少输入或输出单价；请配置后再调用云端。',
  MODEL_TOTAL_COST_LIMIT: '已达到此配置目录的累计费用上限，跨日和重启不会重置。',
  MODEL_PROVIDER_COOLDOWN: '模型服务限流或暂时故障，已暂停新请求；稍后再试。',
  TASK_CHECKPOINT_SAVE_FAILED: '任务检查点保存失败，请检查磁盘。已生效的动作不会自动重放。',
  HARNESS_TOOL_OUTCOME_UNKNOWN_REQUIRES_VERIFICATION:
    '上次有结果不明的操作，需要先独立核对实际效果；本次恢复没有重放该操作。',
  HARNESS_SESSION_NOT_FOUND: '未找到此任务的 Harness 会话记录，无法沿用原会话恢复。',
  HARNESS_SESSION_ROUTE_MISMATCH:
    '当前模型或接收端与原会话不同，已阻止恢复以保护历史内容。请恢复原配置，或另建任务。',
  HARNESS_SESSION_ROUTE_UNBOUND:
    '旧会话没有记录原模型接收端，无法安全恢复。原记录已保留，请另建任务。',
  HARNESS_SESSION_OWNER_INVALID: '会话身份记录损坏或不匹配，已停止恢复并保留原文件。',
  MODEL_TASK_COST_LIMIT: '本任务已达到按配置单价计算的费用上限，执行记录及已生效结果已保留。',
  MODEL_DAY_COST_LIMIT: '今日已达到按配置单价计算的费用上限，请检查用量或调整限额。',
  MODEL_TASK_REQUEST_LIMIT: '本任务已达到模型请求次数上限，实际结果及执行记录已保留。',
  MODEL_DAY_REQUEST_LIMIT: '今日云端请求次数已达到上限，请检查用量或调整模型调用限额。',
  MODEL_TASK_TOKEN_LIMIT: '本任务已达到用量上限，实际结果及执行记录已保留。',
  MODEL_DAY_TOKEN_LIMIT: '今日云端用量已达到上限，请检查用量或调整模型调用限额。',
  MODEL_INPUT_LIMIT: '模型上下文超过大小上限，请缩小任务或引用范围后继续。',
  MODEL_NO_PROGRESS_LIMIT: '连续多轮没有新进展，模型调用已停止。请检查现有结果后明确继续。',
  MODEL_USAGE_STORAGE_UNAVAILABLE: '模型用量台账不可用，云端请求已停止，请检查本地磁盘及用量文件。',
  MODEL_BALANCE_EXHAUSTED: '模型服务商返回余额不足，已保留执行记录，请核对已生效结果后恢复。',
  TARS_TASK_FAILED: '电脑操作未完成，请检查目标窗口后重新发起任务。',
  TARS_VERIFICATION_FAILED: '任务结束时未取得完整的实际结果核验，请检查任务产物。',
  TARS_ITERATION_LIMIT: '本次模型运行达到指定轮数上限，任务尚未完成。',
  TARS_RECOMMENDATION_FAILED: '页面建议暂不可用，请切回目标窗口后重试。',
  INPUT_OUTCOME_UNKNOWN: '输入结果未确认，请检查目标窗口后恢复控制。',
  RK_CONNECTION_CLOSED: 'RK 连接已断开，请在设备管理中重新连接。',
  RK_NOT_READY: 'RK 当前不可用，请在设备管理中检查连接状态。',
  INPUT_UNKNOWN: 'RK 尚有未确认释放的输入，请检查设备状态后恢复控制。',
  EXECUTOR_BUSY: 'RK 执行器正在处理其他任务，请等待停止确认。',
  RK_ADAPTER_BUSY: 'RK 执行会话尚未结束，请等待停止确认。',
  TARS_EVENT_SAVE_FAILED: '运行记录保存失败，请检查本地磁盘空间。',
}
