export interface ProactiveState {
  connected: boolean
  active: boolean
  phase: string
  taskId?: string
  suggestion?: Record<string, unknown>
  question?: Record<string, unknown>
  summary?: string
  error?: string
  memorySaved?: boolean
  observationPaused?: boolean
}

export const proactivePhaseLabels: Record<string, string> = {
  idle: '等待新任务',
  queued: '正在准备任务',
  planning: '正在规划下一步',
  observing: '正在读取当前窗口',
  executing: '正在执行单步操作',
  verifying: '正在回读实际结果',
  waiting_user: '等待你补充信息',
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
  TARS_TASK_FAILED: '电脑操作未完成，请检查目标窗口后重新发起任务。',
  TARS_RECOMMENDATION_FAILED: '页面建议暂不可用，请切回目标窗口后重试。',
  INPUT_OUTCOME_UNKNOWN: '输入结果未确认，请检查目标窗口后恢复控制。',
  RK_CONNECTION_CLOSED: 'RK 连接已断开，请在设备管理中重新连接。',
  TARS_EVENT_SAVE_FAILED: '运行记录保存失败，请检查本地磁盘空间。',
}
