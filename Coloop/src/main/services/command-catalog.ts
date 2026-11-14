import { z } from 'zod'
import { preferencesSchema } from '../../shared/preferences'
import { modelDebugRequestSchema, diagnosticQuerySchema } from '../../shared/model-debug'
import {
  conversationCreateSchema,
  conversationSendSchema,
  conversationUpdateSchema,
  conversationResumeSchema,
  queueCancelSchema,
} from '../../shared/conversations'
import { browserConfigSchema } from './browser-preferences'
import {
  settingsSchema,
  taskRequestSchema,
  scheduleRequestSchema,
  voiceAudioSchema,
} from '../../shared/contracts'
import { autoAgentCreateSchema, autoAgentFeedbackSchema } from '../../shared/auto-agent-work'
import { desktopRequestSchema } from '../../shared/desktop'
import { credentialCreateSchema, credentialFieldSchema } from '../../shared/credentials'
import {
  memoryBrowseSchema,
  memorySaveSchema,
  memoryReviseSchema,
  memoryRemoveSchema,
} from '../../shared/memory'
import { sessionCommandSchema } from '../../shared/sessions'
import { islandAnswerSchema, indicatorPlacementSchema } from '../../shared/control-indicator'

const id = z.string().uuid()
const path = z.string().min(1).max(4096)
const workspacePath = z.string().min(1).max(2048)
const workspace = z.object({ workspace: workspacePath }).strict()
type CommandSpec = { description: string; input?: z.ZodType; sensitive?: boolean }
const spec = (description: string, input?: z.ZodType, sensitive = false): CommandSpec => ({
  description,
  input,
  sensitive,
})

/** The same domain schemas used by the services also describe commands to agents. */
export const commandCatalog: Record<string, CommandSpec> = {
  'settings:preferences': spec('更新任务路由、模型不限额模式、灵动岛及窗口偏好', preferencesSchema),
  'model-debug:start': spec(
    '启动纯文本模型测试；省略 maxTokens 使用模型默认，结果包含实际预算及结束原因',
    modelDebugRequestSchema,
  ),
  'model-debug:get': spec('读取模型测试状态与结果', id),
  'model-debug:current': spec('读取本次应用运行中最近的模型测试'),
  'model-debug:cancel': spec('停止模型测试', id),
  'model-debug:route': spec('预览本地模型的任务分配结果', z.string().trim().min(1).max(24000)),
  'model-debug:diagnostics': spec('查询模型运行诊断，可用绝对路径导出报告', diagnosticQuerySchema),
  'conversation:list': spec('读取任务聊天与队列'),
  'conversation:create': spec('创建长期任务聊天', conversationCreateSchema),
  'conversation:get': spec('读取任务聊天及各轮执行过程', id),
  'conversation:update': spec(
    '修改任务权限、标题、归档或保存草稿与阅读位置',
    conversationUpdateSchema,
  ),
  'conversation:send': spec('向指定聊天发送消息，忙碌时排队', conversationSendSchema),
  'conversation:resume': spec('恢复指定聊天中的中断执行', conversationResumeSchema),
  'queue:get': spec('读取执行队列'),
  'queue:pause': spec('暂停或继续任务队列', z.boolean()),
  'queue:cancel': spec('取消排队或中断的任务', queueCancelSchema),
  'app:get': spec('读取完整应用状态'),
  'app:show': spec('显示主窗口'),
  'app:hide': spec('隐藏主窗口并保持后台运行'),
  'app:quit': spec('空闲时正常退出，执行中返回错误'),
  'settings:get': spec('读取设置，密钥只返回是否已配置'),
  'browser:config': spec(
    '读取或更新浏览器连接偏好，长期保存须明确要求并读回确认',
    browserConfigSchema,
  ),
  'browser:connection': spec(
    '返回官方 Playwright 扩展接入方式和可选 CDP 端点状态，实际连接由网页任务核验',
    z.enum(['edge', 'chrome']),
  ),
  'settings:save': spec('保存完整设置', settingsSchema, true),
  'settings:task-workspace': spec('设置任务文件目录', workspacePath),
  'settings:import-rk': spec('从 OCR 工作区导入 RK 配置'),
  'device:connect': spec('连接 RK 并保存自动连接凭据', z.string().max(1024), true),
  'device:auto-reconnect': spec('重试自动连接'),
  'device:disconnect': spec('断开 RK'),
  'device:refresh': spec('刷新设备状态'),
  'device:start-service': spec('启动 RK 模型服务'),
  'provider:test': spec('测试任务模型连接'),
  'task:dispatch': spec('发起任务，运行中可补充消息', taskRequestSchema),
  'task:run': spec('发起独立任务，执行中拒绝', taskRequestSchema),
  'task:cancel': spec('停止指定任务', id),
  'task:schedule': spec(
    '通过 DSH 原生调度登记未来任务，返回计划 ID 和业务任务 ID',
    scheduleRequestSchema,
  ),
  'task:schedule-cancel': spec('取消尚未派发的 DSH 计划任务', id),
  'history:list': spec('列出任务历史'),
  'history:task': spec('读取对话和工具调用明细', id),
  'history:open-artifact': spec(
    '打开指定任务已登记的产物',
    z.object({ taskId: id, artifactId: z.string().min(1).max(200) }).strict(),
  ),
  'history:export': spec('将历史导出到指定文件', path),
  'history:clear': spec('清空任务历史'),
  'screen:displays': spec('列出显示器'),
  'screen:capture': spec('截屏，返回图像 ID 和 data URL', z.string().max(50).optional()),
  'screen:open': spec('从路径导入图片', path),
  'ocr:recognize': spec('识别截屏或导入的图像', id),
  'voice:transcribe': spec('转写 16 kHz 单声道 PCM16 WAV 的纯 Base64 字符串', voiceAudioSchema),
  'voice:cancel': spec('停止语音转写'),
  'clipboard:write': spec('写入剪贴板', z.string().max(200_000)),
  'proactive:start': spec('启动电脑任务', z.string().trim().min(1).max(4000)),
  'proactive:stop': spec('停止电脑任务并等待释放确认'),
  'proactive:resume': spec('恢复电脑任务', id),
  'proactive:pause': spec('暂停或恢复自动观察', z.boolean()),
  'proactive:accept': spec('执行当前建议', z.string().min(1).max(128)),
  'proactive:dismiss': spec('忽略当前建议', z.string().min(1).max(128)),
  'proactive:answer': spec('回答执行中的问题', islandAnswerSchema),
  'desktop:windows': spec('列出桌面窗口'),
  'desktop:start': spec('启动桌面操作', desktopRequestSchema),
  'desktop:stop': spec('停止桌面操作'),
  'auto-agent:create': spec('创建后台任务', autoAgentCreateSchema),
  'auto-agent:enabled': spec('开启或关闭新任务自动发现与推进', z.boolean()),
  'auto-agent:update': spec(
    '控制或补充后台任务',
    z
      .object({
        taskId: id,
        action: z.enum(['pause', 'resume', 'unbind', 'stop_agent', 'supplement']),
        text: z.string().trim().min(1).max(24000).optional(),
      })
      .strict(),
  ),
  'auto-agent:feedback': spec('提交后台任务反馈', autoAgentFeedbackSchema),
  'auto-agent:refresh': spec('刷新后台任务及 Hook 状态', workspace.optional()),
  'auto-agent:install-hooks': spec('安装工作区 Hook', workspace),
  'auto-agent:uninstall-hooks': spec('卸载工作区 Hook', workspace),
  'auto-agent:test-provider': spec('测试后台决策模型'),
  'sessions:command': spec('向已连接 AI 会话发送命令', sessionCommandSchema),
  'sessions:stop-all': spec('停止全部会话控制'),
  'sessions:resume': spec('恢复会话控制'),
  'sessions:preview-indicator': spec('显示灵动岛'),
  'sessions:indicator-placement': spec(
    '查看浮窗位置，吸附顶部或左右边缘，或移回桌面',
    indicatorPlacementSchema,
  ),
  'mobile:enable': spec('开启手机连接'),
  'mobile:disable': spec('关闭手机连接'),
  'mobile:import-server': spec('从路径导入手机服务器配置', path),
  'mobile:pair': spec('生成手机配对链接和二维码'),
  'mobile:revoke': spec('撤销手机配对', id),
  'credentials:protect': spec('进入或退出私密管理模式', z.boolean()),
  'credentials:list': spec('列出凭据元数据'),
  'credentials:create': spec('在私密管理模式保存凭据', credentialCreateSchema, true),
  'credentials:delete': spec('删除凭据', id),
  'credentials:open': spec('打开隔离登录窗口', id),
  'credentials:fill': spec(
    '聚焦指定序号的输入框并填入凭据',
    z.object({ field: credentialFieldSchema, index: z.number().int().min(0).default(0) }).strict(),
  ),
  'credentials:close': spec('关闭私密登录窗口'),
  'memory:browse': spec('在私密管理模式查询记忆', memoryBrowseSchema),
  'memory:save': spec('保存普通记忆', memorySaveSchema),
  'memory:revise': spec('修改普通记忆', memoryReviseSchema),
  'memory:remove': spec('删除记忆', memoryRemoveSchema),
  'memory:create-private': spec('保存私密凭据并同步记忆索引', credentialCreateSchema, true),
  'memory:open-private': spec('打开私密记忆的登录窗口', id),
  'memory:open-private-editor': spec('显示私密录入窗口，命令行录入使用 memory:create-private'),
  'memory:close-private-editor': spec('关闭私密录入窗口'),
}
