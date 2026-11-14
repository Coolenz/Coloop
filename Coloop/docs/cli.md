# Coloop 命令行操作手册

## 工作区与模型调试接口

### 首页交互与命令入口

任务列表搜索支持去除首尾空格及忽略大小写，同时匹配聊天标题、聊天消息和外部 Agent 任务目标。窄窗口中可在聊天页及外部任务页打开任务列表，选择任务后收起列表，也可按 Escape、点击关闭按钮或列表外区域收起。消息输入框随多行内容增高，达到上限后内部滚动。Enter 发送，Shift+Enter 换行，中文输入法选词时保留输入。

工作区初次读取失败时可点击“重新读取工作区”，成功的状态更新也会恢复显示。命令行可用 `status` 重新读取同一工作区状态，通过 `conversation list` 和 `status.value.autoAgentWork.tasks` 获取任务列表，通过 `conversation get --string CHAT_ID` 读取聊天，通过 `conversation send --stdin` 发送消息。返回结构和参数 Schema 可用以下命令核对。

```powershell
.\coloop.cmd status
.\coloop.cmd conversation list
.\coloop.cmd help conversation send
```

本节对应 2026-11-08 已更新的本机安装版。新首页、持久化任务聊天、模型调试、灵动岛提醒和启动重绘修复，以及不限额模式和 DeepSeek 原生 DSH 上下文策略，均已完成源码构建、候选包验证及实际安装路径验收。当前实例提供 92 个命令，具体 Schema 以 `commands` 和 `help` 返回为准。

### 任务聊天与队列

| 命令                    | 输入                                                                   | 返回及行为                                                                                              |
| ----------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `conversation list`     | 无                                                                     | 聊天列表、队列 ID、`paused`、`blockedReason`                                                            |
| `conversation create`   | `{ "title": "可选标题" }`                                              | 新聊天 ID                                                                                               |
| `conversation get`      | `--string CHAT_ID`                                                     | 消息、执行轮次、策略快照和各轮历史                                                                      |
| `conversation update`   | `{ "id": "CHAT_ID", ... }`                                             | 支持 `title`、`archived`、`draft`、`scrollTop`、`followingLatest`、`visibleMessages`、`expandedDetails` |
| `conversation send`     | `{ "conversationId": "CHAT_ID", "messageId": "UUID", "text": "内容" }` | `conversationId`、`runId`、`delivery`。可附 `context`、`workspace`                                      |
| `conversation resume`   | `{ "conversationId": "CHAT_ID", "runId": "RUN_ID" }`                   | 按原检查点恢复未完成执行                                                                                |
| `queue get`             | 无                                                                     | 持久化队列与会话状态                                                                                    |
| `queue pause`           | JSON `true` 或 `false`                                                 | 暂停或恢复后续队列调度                                                                                  |
| `queue cancel`          | `{ "runId": "RUN_ID" }`                                                | 取消排队或待恢复的执行轮次                                                                              |
| `history open-artifact` | `{ "taskId": "RUN_ID", "artifactId": "ARTIFACT_ID" }`                  | 核对检查点及授权目录后打开已登记文件                                                                    |

发送受理与执行完成分别表示。`delivery` 为 `queued`、`accepted` 或 `failed`。轮次状态为 `queued`、`running`、`interrupted`、`completed`、`failed`、`cancelled`。同一活动聊天的消息补充到当前任务，其他聊天按受理顺序排队。等待回答、待确认操作、设备连接、模型测试和暂停状态会阻止队列推进。`queue pause` 作用于后续调度，当前执行的停止仍使用 `task cancel` 或 `proactive stop`。

调用方生成 UUID 作为 `messageId`。网络响应丢失时，以相同 ID 和相同内容重试并核对 `conversation get`。报告受理结果待确认时，先查看历史及当前回执。问题回答使用 `proactive answer`，同时传入 `taskId`、`questionId` 和 `answer`。

旧任务迁入聊天后保留原任务 ID、检查点和产物关联。每个新轮次保存 `policy.mode` 和 `policy.cloudFallback`。重启后原运行轮次转为 `interrupted`，先恢复或取消再继续队列。聊天与草稿保存在应用数据目录的 `conversations.json`。长聊天使用受限的初始上下文，执行器可通过当前聊天限定的 `coloop_conversation_history` 原生工具读取全部历史消息、结果和产物，分页参数为字符单位的 `offset`、`limit`。

```powershell
$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
'{"title":"整理课程资料"}' | .\coloop.cmd conversation create --stdin
# 用返回的 ID 填入 conversationId，每条新消息生成独立 UUID。
$message = @{ conversationId = '<CHAT_ID>'; messageId = [guid]::NewGuid().ToString(); text = '整理这份课程资料' }
$message | ConvertTo-Json -Compress | .\coloop.cmd conversation send --stdin
.\coloop.cmd conversation get --string '<CHAT_ID>'
'true' | .\coloop.cmd queue pause --stdin
```

### 模型执行策略与测试

`settings preferences` 接受部分设置。`executionMode` 支持 `cloud`、`local`、`local-auto`，默认云端。`allowCloudFallback` 默认开启。既有 `autoTaskRouting` 在新字段未设置时继续生效，保存的新策略用于下一次受理的轮次。

显式 CLI `target:"rk"` 保留本地验证行为。需要允许接管时同时传入 `policy:{"mode":"local","cloudFallback":true}`。首页及灵动岛使用配置中的策略。自动路由使用与调试预览相同的分类器。接管覆盖上下文超限、本地模型连接异常及推理超时，沿用任务 ID、已执行动作与产物，重新读取当前状态后继续。设备离线或操作结果不明时按相应执行保护处理。

| 命令                      | 输入                                                        | 返回及行为                                                             |
| ------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------- |
| `model-debug start`       | `target`、`prompt`，可附 `system`、`maxTokens`、`timeoutMs` | 测试 ID。使用纯文本模型接口                                            |
| `model-debug get`         | `--string TEST_ID`                                          | `waiting/running/completed/failed/cancelled`、文本、时间、字节数与错误 |
| `model-debug current`     | 无                                                          | 当前应用进程中最近一次测试，便于返回调试页后继续查看或停止             |
| `model-debug cancel`      | `--string TEST_ID`                                          | 停止指定测试                                                           |
| `model-debug route`       | `--string '待分配任务'`                                     | `route:rk/cloud`、`source`、`elapsedMs`、有返回时的 `raw`              |
| `model-debug diagnostics` | `{}` 或 `taskId`、`model`、`since`、`path`                  | 筛选后的诊断数组，`path` 为新报告的绝对路径                            |

本地回复测试在资源占用时等待，可取消。路由预览在本地资源占用时返回占用提示。路由结果来源分别为 `model`、`timeout`、`invalid`、`oversize`、`unavailable`。预览使用正式分类逻辑，界面的“带入首页新任务”只创建草稿。

`maxTokens` Schema 范围为 1–1048576，实际输出遵循目标模型声明的容量，超出已知本地最大输出时返回 `LOCAL_MODEL_OUTPUT_LIMIT`。本地省略参数时依次采用 `settings.localModel.outputTokens`、运行模型默认输出；自定义限额模式同时应用额外输出上限。云端省略参数时使用对应模型配置。`timeoutMs` 范围为 1000–300000，默认 120000，作用于本次调试测试。测试返回 `inputBytes`、`outputBytes`、`requestedOutputTokens`、`budgetSource`、`finishReason` 及可获得的 token 用量和 `firstTextMs`。`length` 表示输出达到上限，测试记录为 failed 并保留实际返回的文本。未报告的指标显示“未提供”。诊断通过字段白名单隐藏提示正文、密钥和认证字段。测试正文仅保留于当前进程，重启后可查询元数据日志。导出最多 1000 条记录，目标文件已存在时拒绝覆盖。

`status.value.device.localModelCapacity` 返回 `contextWindow`、`defaultOutputTokens`、`maximumOutputTokens`、`source` 和可获得的 `fingerprint`。来源为 `health`、`verified-profile` 或 `legacy`。健康接口缺少默认输出时，通过现有 SSH 连接读取板端模型配置，并核对服务身份与配置指纹。旧协议采用标记为 legacy 的集中兼容配置。当前验证的 RK 配置默认为 256、最大为 2048 token，实际值以运行实例为准。配置页“本地模型默认输出”留空时遵循模型声明。

```powershell
$settings = (.\coloop.cmd settings get | ConvertFrom-Json).value
$settings | Add-Member -NotePropertyName localModel -NotePropertyValue @{ outputTokens = 1024 } -Force
$settings | ConvertTo-Json -Depth 20 -Compress | .\coloop.cmd settings save --stdin
# 恢复模型默认时，将 localModel 改为 @{} 后再次保存。
'{"target":"local","prompt":"请简短回复连接正常"}' | .\coloop.cmd model-debug start --stdin
.\coloop.cmd model-debug get --string '<测试 ID>'
.\coloop.cmd status | ConvertFrom-Json | ForEach-Object { $_.value.device.localModelCapacity }
```

RK 摘要使用 DSH 解析的输出预算，结合板端最大输出核验。摘要保留简短中文条目和结束标记检查，字数及行数随必要信息量变化。默认压缩触发、历史保留和预留配置继续生效。输出完成原因贯穿 Board、RK 适配器和 Harness，截断摘要保留原始历史。

### 不限额模式与 DSH 上下文管理

`settings preferences` 支持 `modelLimitMode`，取值为 `unlimited` 或 `custom`。保存后用于后续执行及中断任务的继续执行，返回完整公开设置，可用 `settings get` 读回 `modelLimits.mode`。界面入口为配置中的模型运行与调试及云端模型页。

```powershell
'{"modelLimitMode":"unlimited"}' | .\coloop.cmd settings preferences --stdin
.\coloop.cmd settings get
```

不限额模式持续计量调用、Token 和费用，模型请求按照实际容量运行。Coloop 的累计次数、累计用量、费用上限、额外输入字节上限、额外输出上限和人为请求间隔仅在 `custom` 模式生效。服务商的实际错误与冷却状态继续反馈。旧配置中调用和费用限制均关闭时自动按不限额解释，已有明确开启的限制按自定义模式解释。累计账本持续保留。

完整 `settings save` 中的 `modelLimits` 可设置 `mode`、`inputLimitEnabled`、`usageBudgetEnabled`、`costLimitEnabled` 及各上限。`inputLimitEnabled` 独立控制 `maxInputBytes`，旧自定义配置默认启用。`MODEL_INPUT_LIMIT` 明确表示此额外字节限制。`maxOutputTokens` 为自定义输出上限，范围 512–1048576。配置单价用于费用计量，两种模式均可使用。

官方 DeepSeek Flash 配置上下文 1048576 tokens、默认输出 65536 tokens、服务商最大输出 393216 tokens。DSH 使用对应模型元数据，原生 `dsh-token-meter`、`dsh-compaction-basic` 和 `dsh-session-checkpoint-policy` 负责计量、自动压缩、上下文溢出恢复及检查点续跑。全部云端路由使用原生压缩策略及工具结果裁剪、图片卸载插件。小上下文模型仅按容量配置原生 `headroomTokens`，使输出预留与压缩预留能够装入上下文；触发比例和保留比例沿用 DSH 默认值。原始工具回执保存在 DSH 会话日志中。云端运行使用 DSH 请求生命周期和取消信号。RK 的模型容量与 16384 字节请求预算独立配置，沿用适配小容量的 DSH 压缩参数。

其他云端服务可通过 `provider.contextWindow` 与 `provider.maxOutputTokens` 配置 token 容量，独立决策模型对应 `decisionProvider`。未指定时使用兼容默认值 65536 与 8192。容量元数据与 Coloop 自定义限额分别保存。

```powershell
'{"executionMode":"cloud","allowCloudFallback":true}' | .\coloop.cmd settings preferences --stdin
'{"target":"cloud","prompt":"请只回复连接正常","timeoutMs":30000}' | .\coloop.cmd model-debug start --stdin
.\coloop.cmd model-debug get --string '<TEST_ID>'
.\coloop.cmd model-debug route --string '打开 QQ 邮箱'
'{"taskId":"<RUN_ID>","path":"D:\\Coloop\\.qa\\model-diagnostic.json"}' | .\coloop.cmd model-debug diagnostics --stdin
```

### 灵动岛、窗口与记忆偏好

`settings preferences` 还接受 `islandEnabled`、`islandDetailedNotifications`、`islandAttention`、`closeToTray`、`startHidden`、`launchOnLogin`。灵动岛默认开启，问题内容预览和待处理提醒默认开启。关闭预览后紧凑条显示通用待处理提示，主动展开后仍可回答。开启突出提醒时，等待问题或选项的把手与紧凑条显示强调状态。减少动态效果设置会取消强调动画。

```powershell
'{"islandEnabled":true,"islandDetailedNotifications":false,"islandAttention":true}' | .\coloop.cmd settings preferences --stdin
'{"operation":"dock","edge":"right"}' | .\coloop.cmd sessions indicator-placement --stdin
'{"operation":"inspect"}' | .\coloop.cmd sessions indicator-placement --stdin
'{"category":"ordinary","tag":"偏好","sort":"title","offset":0,"limit":25}' | .\coloop.cmd memory browse --stdin
```

灵动岛与首页使用同一份任务和聊天标题，任务事件及 `conversation update` 改名立即触发浮窗同步。模型准备、执行、等待回答和结果状态保留对应聊天标题，未关联聊天的任务使用任务正文前 48 字。灵动岛位置保存在 `island-placement.json`，支持顶部、左侧和右侧。点击贴边把手、标志或任务标题展开详情，离开约 350 毫秒后收起。浮窗标题区域和贴边把手均可拖动，拖动中冻结尺寸，拖动结束不会误触详情。悬停保持尺寸、间距和圆角稳定。拖至顶部或左右边缘 48 DIP 范围内时，显示方向图标和“松开即可收至…”提示，松开后吸附。紧凑浮窗不显示“收边”按钮，拖至边缘或使用 `sessions indicator-placement` 的 `dock` 操作收起。`memory browse` 的 `tag` 按标签筛选，`sort` 支持 `source` 和 `title`，过滤在分页前完成。RK 未提供更新时间的旧记忆会显示“RK 未提供”。

## 入口与当前交付状态

2026-11-07 当前安装版包含四页工作区、模型运行调试、灵动岛三态及提醒设置。安装同步后已校验 151,612 个文件。自动接入和工具输出使用隔离 Hook 协议案例验收，模型回复使用本地合成服务验收，真实 RK／云端业务接管仍需对应实机任务验证。

主窗口在工作区或错误页完成首次绘制确认后显示。启动期间的 `app show`、第二次启动及托盘显示请求会保留到界面就绪，后台启动由应用的 `--background` 参数管理隐藏，CLI 启动器保留正常的 Windows 首次显示标记；最小化恢复沿用同一显示入口。灵动岛保留半透明渐变和背景模糊，仅使用内侧高光，没有框外阴影。原生窗口行为对应 Electron 的后台绘制及重绘接口。[BrowserWindow](https://www.electronjs.org/docs/latest/api/browser-window/)、[webContents](https://www.electronjs.org/docs/latest/api/web-contents/)

在 `D:\Coloop` 中运行 `coloop.cmd`。它使用 `%LOCALAPPDATA%\Programs\Coloop` 中的 Node、CLI 和应用。完整安装包也包含 `coloop.cmd`，可以通过绝对路径调用。

开发时可用 `node scripts/with-workspace-cache.mjs scripts/coloop-cli.mjs` 或 `npm run --silent cli --` 替代 `coloop.cmd`。开发 CLI 连接当前运行实例，因此服务端也须包含本次修改。`--executable` 和 `COLOOP_EXECUTABLE` 可以指定本轮验证目录包的 `Coloop.exe`。

```powershell
Set-Location D:\Coloop
# 保证 Windows PowerShell 管道中的中文使用 UTF-8。
$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

.\coloop.cmd start
.\coloop.cmd status
.\coloop.cmd commands
.\coloop.cmd help task dispatch
```

`start` 启动后台实例并等待控制接口就绪。主窗口通过 `app show` 和 `app hide` 控制。应用运行时保留现有灵动岛及系统托盘行为。

任务栏图标修复可运行 `powershell -NoProfile -ExecutionPolicy Bypass -File D:\Coloop\scripts\repair-shortcut-icons.ps1 -RestoreWindow`。脚本将指向当前安装版的现有桌面、开始菜单及已固定任务栏快捷方式更新为 `resources\icon.ico`，通知 Windows 刷新图标，并将隐藏的主窗口恢复为不抢焦点的最小化窗口。返回 `updated` 快捷方式列表和 `windows` 的可见、最小化状态。当前安装版通过最小化主窗口为自动任务让位，并保留任务栏入口。

## AI 调用顺序

主动任务默认使用云端执行。`settings preferences` 的 `executionMode` 管理三种模式。新字段未设置时继续兼容 `settings save` 的 `autoTaskRouting`，省略或设为 `"cloud"` 时使用云端，设为 `"local-auto"` 时使用本地分类。`task dispatch` 显式传入 `target:"rk"` 时继续遵循本地执行要求。

允许云端接管的本地任务遇到 `RK_CONTEXT_BUDGET_EXCEEDED` 或模型连接、推理超时异常时，会在同一任务 ID 下建立新的 DSH 云端会话，交接目标、补充指令、动作结果和产物索引。云端先重新读取当前状态，再接续未完成操作并核验。检查点记录 `cloudSessionId`，`history task` 合并显示两段执行记录，恢复时继续云端会话。每次执行至多交接一次。当前安装版已包含灵动岛默认云端路由。

2026-11-13 源码修订补齐运行时直接抛出已识别本地模型异常时的同一接续路径，沿用任务创建时保存的 `policy.cloudFallback` 和调用预算。取消、输入结果待确认、预算耗尽和未识别异常仍由原执行保护处理。恢复聊天时，`coloop_conversation_history` 的中断读取归入可重新请求的只读工具，原生 DSH 会话可继续发起新读取。CLI 参数沿用 `conversation resume`、`proactive resume`，执行结果通过 `task wait` 与 `history task` 核对。本轮按用户要求交付源码与测试，验证新增行为需使用包含该修订的源码实例。

```powershell
'{"prompt":"用 Edge 打开 QQ 邮箱并核验页面","target":"cloud","source":"text","intent":"execute"}' | .\coloop.cmd task dispatch --stdin
```

### 复用现有 Edge 登录

日常配置通过微软官方 Playwright Extension 连接已运行的 Edge，沿用该配置中的 Cookie。DSH 原生 `dsh-mcp-client` 注册和执行 `mcp__playwright__browser_*` 工具。浏览器程序明确传入 `msedge`，用户指定 Chrome 时传入 `chrome`。首次接入须安装 Playwright Extension，并在扩展连接页允许本次连接。扩展通道可直接使用，无需开启远程调试。

用户已配置当前用户环境变量 `PLAYWRIGHT_MCP_EXTENSION_TOKEN` 时，Coloop 在每次任务连接时读取，使正在运行的应用也能使用更新后的令牌。令牌仅通过鉴权的本机桥接交给官方 MCP 子进程，生成的 DSH 配置、模型提示和日志均不写入该值。`browser connection` 的 `tokenConfigured` 只返回是否已配置。令牌由扩展授权页提供，设置时应使用本机受保护输入，避免写入聊天、命令历史或项目文件。

`browser connection --string edge` 返回 `transport:"playwright-extension"` 和 `connected:false`，实际连接由网页任务核验。兼容字段 `endpointAvailable` 仅描述可选 CDP 通道。`browser config` 使用浏览器配置 Schema，`operation` 可为 `inspect` 或 `configure`。配置中的 `connection` 支持 `existing` 和 `managed`，`profileDirectory` 可指定 `Default` 或 `Profile 1` 等配置目录名，省略时由官方扩展选择最近使用且已安装扩展的配置。`cdpUrl` 可显式选择旧版 CDP 接入路径。长期保存须有用户明确指令及记忆读回。

```powershell
.\coloop.cmd browser connection --string edge
'{"operation":"inspect"}' | .\coloop.cmd browser config --stdin
'{"prompt":"用 Edge 打开 https://mail.qq.com 并保留页面","target":"cloud","source":"text","intent":"execute"}' | .\coloop.cmd task dispatch --stdin
```

扩展连接失败时，任务应报告连接错误并等待必要操作。网页任务完成前须通过官方 `browser_verify_*` 工具核验最终页面，后续操作会使先前完成证据失效。QQ 邮箱登录须以实际收件箱可见为证据。连接配置在任务初始化时确定，需要改配置时先结束当前任务。RK 路线通过 `coloop_enable_tools` 的 `web` 组显示浏览器工具。

已部署的 RK 扩展浏览器工具按组展开，`web` 提供导航、快照、点击、输入和基本核验，`web_more` 提供表单、上传及其他浏览器操作，`browser_settings` 提供配置与修复。网页任务可直接启用 `web`。`proactive start` 和灵动岛新任务入口会最小化主窗口并尝试恢复目标应用。观察无法恢复目标窗口时返回 `OBSERVATION_TARGET_UNAVAILABLE`，并提示选择网页工具或切换到目标应用。任务状态中的 `RK_CONTEXT_BUDGET_EXCEEDED` 表示本地上下文超出预算，`MODEL_SERVICE_UNAVAILABLE` 表示模型服务返回 503，两者均保留已有执行记录和已生效结果，通过 `status`、`task wait` 与 `history task` 核对。本轮本地模型的真实业务效果待对应任务复测。

浏览器任务也通过 `task dispatch` 发起，参数遵循 `task:dispatch` 的现有 Schema。例如在新版服务端执行以下命令。

```powershell
'{"prompt":"在 Edge 打开 https://mail.qq.com 并保留页面。以后浏览器操作也用 Edge。","target":"cloud","source":"text","intent":"execute"}' | .\coloop.cmd task dispatch --stdin
```

返回任务 ID 后使用 `task wait ID` 跟进，并用 `history task --string ID` 读取工具回执。扩展任务的工具名使用 `mcp__playwright__browser_*`。托管模式和显式 CDP 模式继续使用 `coloop_web`，其回执中的 `browser.settings` 为选定配置，`browser.actual` 为读取的浏览器身份。

托管模式的配置目录为 `D:\Coloop\runtime-data\browser-profiles\edge`，承载登录用户数据。隔离验收默认使用 `COLOOP_DATA_DIR` 下的独立目录，显式设置 `COLOOP_BROWSER_EXTENSION=1` 才接入个人浏览器。托管模式使用 Stagehand 原生 `executablePath`、`userDataDir`、`preserveUserDataDir` 配置。同一目录的活动任务互斥。扩展接入使用现有浏览器配置，输出及临时缓存位于 `D:\Coloop\.cache\playwright-mcp`。

AI 可在网页任务启动前调用 `coloop_browser_config` 调整浏览器、窗口尺寸和语言，并将用户明确要求的长期偏好保存至记忆、读回确认。明确要求修复浏览器适配代码且已授权 Coloop 源码目录的任务，可调用 `coloop_browser_repair` 执行读取、精确修改、测试构建和 Git 提交。其 `installed:false` 回执表示仍需后续打包、安装及安装路径验收。2026-11-07 已将官方 Playwright 扩展接入部署到本机安装版，并通过实际安装目录的连接和浏览器身份验收。

1. 运行 `start`，再读取 `status`，确认设备、模型、运行任务和保护状态。
2. 运行 `commands` 获取完整命令目录，或用 `help GROUP ACTION` 获取目标命令的 JSON Schema。
3. 按 Schema 构造一个 JSON 参数，通过 `--stdin` 或 `--file` 传入。
4. 检查返回对象的 `ok` 和进程退出码。启动任务后保存返回的任务 ID。
5. 使用 `task wait ID` 或 `auto-agent wait ID` 跟进执行。普通历史中的任务通过 `history task` 获取对话与工具记录，后台任务的事件与动作回执通过 `status.value.autoAgentWork` 获取。
6. 遇到 `OUTCOME_UNKNOWN`，先查询状态和记录，确认副作用后再决定后续操作。

## 参数与返回约定

每个业务命令接收零个或一个参数。对象、字符串、布尔值均按命令 Schema 传入。

| 形式                | 用法                                                        |
| ------------------- | ----------------------------------------------------------- |
| `GROUP ACTION`      | 等价于 `call GROUP:ACTION`                                  |
| `--stdin`           | 从标准输入读取一个 JSON 值                                  |
| `--file PATH`       | 从 UTF-8 JSON 文件读取一个参数，兼容 UTF-8 BOM              |
| `--json JSON`       | 直接传入一个 JSON 值，需遵守当前 shell 的引号规则           |
| `--string TEXT`     | 将文本作为一个字符串参数                                    |
| `--args JSON_ARRAY` | 通用调用的参数数组，`[]` 或 `[参数]`                        |
| `--data-dir PATH`   | 连接指定用户数据目录，等价于设置 `COLOOP_DATA_DIR`          |
| `--connection PATH` | 指定已有实例的 `local-control/connection.json`              |
| `--executable PATH` | `start` 使用的 `Coloop.exe`                                 |
| `--timeout MS`      | 请求或任务等待时限，默认 120000 毫秒，0 表示持续等待        |
| `--interval MS`     | `watch` 和任务等待的查询间隔，默认 1000 毫秒，最小 100 毫秒 |

输入方式一次选一种。标准输入和输入文件上限均为 32 MiB，编码后的完整请求也须在该上限以内。密码和 API Key 可通过标准输入或受保护的 JSON 文件传入。服务端会省略敏感操作错误中的原始参数。

`start`、`commands`、`help`、`watch` 和等待命令使用各自的参数形式，不接受业务 JSON 输入。`--executable` 仅适用于 `start`。以 `--` 开头的文本可通过 `--stdin` 传入 JSON 字符串。

`--connection` 可定位已经运行的实例。该连接未就绪而需要启动应用时，发现文件须对应所选 `--data-dir` 的 `local-control/connection.json`，否则返回 `PROFILE_MISMATCH`。`watch` 持续运行，`--timeout` 控制每次状态请求；等待命令使用整体等待时限。

监听或等待设置 `--timeout 0` 后取消整体等待时限，单次状态查询仍有 120 秒时限。底层业务服务也可能返回自己的超时错误。`start` 会复用当前就绪实例，`--executable` 仅在需要启动新进程时使用；发现文件损坏或鉴权失败时直接报告错误。

业务命令的标准输出为单个 JSON 对象，成功包含 `ok: true` 和 `value`。失败包含 `ok: false`、`code` 和 `error`。命令执行响应还带有请求 `id`。无返回值的操作返回 `value: null`。

`watch`、`task wait` 和 `auto-agent wait` 输出 JSON Lines。等待命令在任务变化时输出记录，结束记录带 `done: true`。暂停或等待用户输入时仍继续等待，可从输出中取得问题并在另一个终端调用回答命令。`help` 和 `--help` 的总体用法说明为普通文本，具体命令帮助为 JSON。

| 退出码 | 含义                                            |
| ------ | ----------------------------------------------- |
| 0      | 命令成功，或等待的任务完成                      |
| 1      | 操作失败、任务失败或任务取消                    |
| 2      | 命令或参数错误                                  |
| 3      | 启动/等待超时，或请求连接中断导致执行结果待确认 |

Ctrl+C 结束 CLI 的监听或等待。任务停止通过对应的停止命令控制。请求 ID 用于关联响应，每次调用都会产生新 ID。CLI 对业务命令只发送一次，请求超时后的副作用需通过状态确认。

`app quit` 返回 `value.requested: true` 表示退出请求已受理。应用在执行退出前会复查运行中的工作，安装或清理前仍需确认进程已退出。

### 错误处理

| code                                      | 处理方式                                                   |
| ----------------------------------------- | ---------------------------------------------------------- |
| `APP_UNAVAILABLE`                         | 尚无发现文件，检查目标数据目录并运行 `start`               |
| `CONNECTION_UNREADABLE`                   | 检查发现文件路径和当前用户访问权限                         |
| `INVALID_CONNECTION`                      | 发现文件格式无效，核对文件是否属于当前应用实例             |
| `CONTROL_UNAVAILABLE` / `REQUEST_TIMEOUT` | 状态读取失败，检查进程、版本和数据目录，随后可重新查询     |
| `PROFILE_MISMATCH`                        | 将 `--data-dir` 对齐到发现文件所属的应用数据目录           |
| `FORBIDDEN`                               | 鉴权失败，核对当前实例的发现文件和令牌                     |
| `INVALID_ARGUMENTS` / `INVALID_OPTION`    | 重新读取具体命令帮助并检查参数类型、数量和选项             |
| `COMMAND_NOT_FOUND`                       | 查询当前安装实例的 `commands`，检查命令名及版本            |
| `APP_BUSY`                                | 有正在执行的工作，完成或明确停止后再请求退出               |
| `TASK_NOT_FOUND`                          | 核对任务 ID 和 profile，后台任务使用 `auto-agent wait`     |
| `WAIT_TIMEOUT` / `START_TIMEOUT`          | 等待时限到达，查询实际状态后再决定是否继续等待             |
| `OUTCOME_UNKNOWN`                         | 业务命令已尝试发送，查询状态与回执确认结果，再决定后续操作 |
| `COMMAND_FAILED`                          | 业务服务拒绝或操作失败，结合 `error` 和 `status` 处理      |

常见排查顺序为确认运行进程和 profile、读取命令目录、核对输入 Schema、读取执行状态。请求 `id` 用于关联一次调用，服务端不会用它对重复业务调用去重。`sessions command` 的业务 `commandId` 另有持久化冲突检查。

## 完整命令目录

参数的字段、枚举、长度及必填项以 `help GROUP ACTION` 返回的 `inputSchema` 为准，业务服务还会执行运行状态和权限校验。`inputSchema: null` 表示没有参数。状态查询覆盖设备、任务、后台任务、会话、记忆保护、手机连接、模型用量、计划任务和审批审计。

### 应用、设置与设备

| 命令                      | 参数与作用                                               |
| ------------------------- | -------------------------------------------------------- |
| `start`                   | 启动并等待本地控制服务                                   |
| `commands`                | 返回所有注册命令及 Schema                                |
| `status` / `app get`      | 完整状态快照                                             |
| `watch`                   | 持续输出变化的状态快照                                   |
| `app show` / `app hide`   | 显示或隐藏主窗口                                         |
| `app quit`                | 空闲时请求正常退出，有执行任务时返回 `APP_BUSY`          |
| `settings get`            | 读取设置，密钥返回 `hasKey` 状态                         |
| `settings save`           | 完整设置对象，含模型、设备、工作区、引擎、定价及预算配置 |
| `settings task-workspace` | 文件夹路径，直接设置任务工作区                           |
| `settings import-rk`      | 从已配置 OCR 工作区的 `config/board.json` 导入设备配置   |
| `device connect`          | RK 登录密码字符串                                        |
| `device auto-reconnect`   | 使用已保存连接配置重试                                   |
| `device disconnect`       | 断开设备                                                 |
| `device refresh`          | 刷新设备状态                                             |
| `device start-service`    | 启动已有 RK 模型服务                                     |
| `provider test`           | 测试任务模型连接                                         |

### 任务、历史与屏幕

| 命令                   | 参数与作用                                                            |
| ---------------------- | --------------------------------------------------------------------- |
| `task dispatch`        | 任务对象，至少包含 `prompt`、`target`。执行中的电脑任务可接收补充消息 |
| `task run`             | 任务对象，创建独立任务，已有执行任务时拒绝                            |
| `task cancel`          | 任务 ID                                                               |
| `task wait ID`         | 持续查询指定普通任务、电脑执行任务或旧版手机任务                      |
| `task schedule`        | 包含 `runAt`、`timezone`、`request` 的计划对象                        |
| `task schedule-cancel` | 计划 ID，从 `status.value.schedules` 获取                             |
| `history list`         | 任务列表，含提问、回答、状态和时间                                    |
| `history task`         | 任务 ID，返回已保存的对话及工具调用                                   |
| `history export`       | 输出 JSON 文件路径                                                    |
| `history clear`        | 清空普通任务历史                                                      |
| `screen displays`      | 显示器列表                                                            |
| `screen capture`       | 可选显示器 ID，返回图片 ID、尺寸和 data URL                           |
| `screen open`          | 图片文件路径，返回导入后的图片 ID                                     |
| `ocr recognize`        | 图片 ID                                                               |
| `voice transcribe`     | 16 kHz 单声道 PCM16 WAV 的纯 Base64 字符串，最长 120 秒               |
| `voice cancel`         | 停止语音转写                                                          |
| `clipboard write`      | 写入剪贴板的文本                                                      |

文件导入、任务目录设置和历史导出使用显式路径。相对路径按 CLI 当前工作目录解析。旧任务若只保留调用元数据，`history task` 会通过 `notice` 说明缺少的内容。

`task schedule` 通过原生 `dsh-schedule` 持久化时间规则并投递到专用 DSH 会话，返回既有计划 `id` 和业务 `taskId`。Coloop 接收到期投递后等待设备及任务资源可用，沿用 `pending/waiting/dispatching/running/completed/failed/cancelled/unconfirmed` 状态。`status.value.schedules.entries` 中的 `nativeId` 标识原生记录，`nativeDue` 表示已收到原生投递。业务完成结果通过 `task wait <taskId>` 核对。旧待执行计划按原计划及业务 ID 关联迁移，过期计划进入到期投递，结果待确认的任务继续保留核验状态。原生状态位于应用数据目录的 `native-schedules`，业务记录位于 `task-schedules.json`。

```powershell
$schedule = @{ runAt = (Get-Date).AddMinutes(10).ToString('o'); timezone = 'Asia/Shanghai'; request = @{ prompt = '检查指定工作目录中的文件'; target = 'cloud'; source = 'text'; intent = 'execute'; context = '' } }
$schedule | ConvertTo-Json -Depth 5 -Compress | .\coloop.cmd task schedule --stdin
.\coloop.cmd task schedule-cancel --string '<计划 ID>'
```

普通提问通过 `dsh-user-questions` 验证问题、回答和取消信号，保留 `coloop_ask_user` 的兼容工具名。桌面、手机与 `proactive answer` 提供回答界面，参数仍为 `taskId`、`questionId`、`answer`。系统提示使用 DSH 提示段注册机制，Coloop 动态指令在自己的提示段中更新，其他插件的提示段参与原生组装。

`task wait` 输出中的 `task` 来自普通任务历史，`execution` 来自当前电脑执行状态，`mobileTask` 来自旧版手机任务列表。只返回匹配当前 ID 的记录。普通或电脑任务以 completed 判定成功，旧版手机任务的 completed、answered 均表示成功。failed、cancelled、blocked、input_unknown、unconfirmed 或 interrupted 按对应来源以未成功结果结束等待，执行器是否仍被占用应读取对应的 active 字段。暂停及等待用户输入会继续等待。`auto-agent wait` 在 completed 时成功结束，在 unbound 时以失败退出码结束，其余状态继续等待。

调度器健康状态位于 `status.value.schedules.runtime`，包含 `state`、`retryCount`、`nextRetryAt`。状态支持 `starting/ready/recovering/error/stopped`。意外退出按 1、2、4、8、16、30 秒退避重连，并核对原生登记、取消意图和到期回执。`OUTCOME_UNKNOWN` 返回的错误中包含计划及业务任务 ID，调用方应先通过 `status` 查找对应记录。程序文件缺失、版本不匹配和持久存储损坏进入 error，修复后重新启动应用。开发启动与安装启动分别解析资源及标准 Node 路径。

### 电脑操作与后台任务

| 命令                                                      | 参数与作用                                                                           |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `proactive start`                                         | 任务目标字符串                                                                       |
| `proactive stop`                                          | 停止电脑任务并等待输入释放                                                           |
| `proactive resume`                                        | 要恢复的任务 ID                                                                      |
| `proactive pause`                                         | 布尔值，暂停或恢复自动观察                                                           |
| `proactive accept` / `proactive dismiss`                  | 当前建议 ID，从状态中的 `proactive.suggestion` 获取                                  |
| `proactive answer`                                        | `{taskId, questionId, answer}`                                                       |
| `desktop windows`                                         | 可用窗口列表                                                                         |
| `desktop start`                                           | 桌面任务对象，结构由命令帮助提供                                                     |
| `desktop stop`                                            | 停止桌面操作                                                                         |
| `auto-agent create`                                       | `{sessionId, goal, acceptance, authorization?}`                                      |
| `auto-agent update`                                       | `{taskId, action, text?}`，action 支持 pause、resume、unbind、stop_agent、supplement |
| `auto-agent feedback`                                     | `{taskId, rating, reason?, scope?, decisionId?}`                                     |
| `auto-agent refresh`                                      | 可选 `{workspace}`，刷新会话及 Hook 状态                                             |
| `auto-agent install-hooks` / `auto-agent uninstall-hooks` | `{workspace}`                                                                        |
| `auto-agent test-provider`                                | 测试后台决策模型                                                                     |
| `auto-agent wait ID`                                      | 等待后台任务结束，期间输出状态变化                                                   |

后台任务绑定对象及会话 ID 从 `status.value.autoAgentWork` 获取。电脑操作中的等待问题从 `status.value.proactive.question` 获取。

### 经验保存与失败重试

本节对应 2026-11-13 源码修订，验证新增状态需使用包含该修订的源码实例。

`auto-agent feedback` 的 `scope:"future"` 将用户原句保存为后续类似任务的参考。`scope:"task"` 仅保存在当前任务日志。未来反馈的 `feedback[].attribution` 为 `pending`、`failed` 或 `stored`，分别表示等待写入、写入失败等待重试和存储已确认。

真实用户选择保存在对应 `events[].choiceMemory` 中。`attribution` 同样包含 `pending`、`failed`、`stored`，以及 `ignored`，表示原句被自动消息或敏感内容过滤规则排除。`workspace` 保存事件发生时的工作区。应用会持久保存待写事件，在断线恢复或重启后按原事件身份重试，退避从 1 秒增加到最多 60 秒。旧日志中没有此字段的事件保持原处理状态。

`stored` 要求每个记忆分片获得有效存储回执。存储返回延后、错误或缺少有效 ID 时继续等待重试。保存状态与任务执行结果分别记录。历史中已确认完成的来源回执继续用于去重，用户随后删除的记忆保持删除状态。

```powershell
$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
@{ taskId = '<后台任务UUID>'; rating = 'negative'; reason = '以后请读回输出文件并核验内容，再报告完成。'; scope = 'future' } |
  ConvertTo-Json -Compress | .\coloop.cmd auto-agent feedback --stdin
$state = .\coloop.cmd status | ConvertFrom-Json
$task = $state.value.autoAgentWork.tasks | Where-Object id -eq '<后台任务UUID>'
$task.feedback | Select-Object id, scope, attribution
$task.events | Where-Object choiceMemory | Select-Object id, choiceMemory
```

反馈仍要求对应后台任务已结束。`stored` 表示存储回执已确认，后续召回和执行效果需从任务记录核对。

### 会话控制与手机连接

| 命令                               | 参数与作用                                                                                                                   |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `sessions command`                 | `{commandId, sessionHandle, action, text?}`，action 支持 send_message、abort_turn                                            |
| `sessions stop-all`                | 停止会话控制                                                                                                                 |
| `sessions resume`                  | 恢复会话控制                                                                                                                 |
| `sessions preview-indicator`       | 显示灵动岛                                                                                                                   |
| `sessions indicator-placement`     | `{operation:"inspect"}` 查看位置；`{operation:"dock",edge:"top"\|"left"\|"right"}` 吸附边缘；`{operation:"undock"}` 移回桌面 |
| `mobile import-server`             | 服务器连接 JSON 文件路径                                                                                                     |
| `mobile enable` / `mobile disable` | 开启或关闭手机连接                                                                                                           |
| `mobile pair`                      | 返回配对信息、链接和二维码 data URL                                                                                          |
| `mobile revoke`                    | 手机设备 ID                                                                                                                  |

受控会话句柄从 `status.value.sessionControl` 获取。会话命令的 `commandId` 由调用者生成 UUID，重复提交同一会话命令时保留原 ID，并遵循会话服务的冲突检查。

浮窗拖动到工作区顶部或左右边缘 24 DIP 内松手后吸附，鼠标离开约 350 毫秒后收成边缘把手，悬停展开，输入期间保持展开。六点手柄只移动窗口，拖动期间固定尺寸。吸附位置在本次应用运行期间保留。命令返回 `edge`（未吸附为 `null`）、`collapsed`、当前 `bounds` 和 `visible`；动画中的即时位置可再次用 `inspect` 读取。

```powershell
'{"operation":"dock","edge":"left"}' | .\coloop.cmd sessions indicator-placement --stdin
'{"operation":"inspect"}' | .\coloop.cmd sessions indicator-placement --stdin
'{"operation":"undock"}' | .\coloop.cmd sessions indicator-placement --stdin
```

### 记忆与凭据

本地 RK 任务通过 `task run` 使用已有记忆工具，不增加新的 CLI 参数。每轮原生系统上下文保留用户原始要求和后续补充，历史压缩不替代原始要求；文件工具组切换后仍可搜索、读取和保存偏好。只有当前用户明确要求的偏好可以写入，保存成功回执包含 `result.readback_verified:true` 和读回记录；读回不符报告 `PREFERENCE_READBACK_MISMATCH`，不能视为保存完成。部分更新先读取原记录，再用同一 key 和 `replace_text` 替换指定片段，保留其他偏好。私密记忆仍仅供本地模型使用。

记忆保存工具的 `scope` 填用户指定的身份原文，通用偏好填空串。宿主校验身份出自当前用户要求，并将它绑定到存储 key；身份不符的部分更新返回 `PREFERENCE_SCOPE_MISMATCH`。这避免模型使用通用 key 时覆盖其他身份的偏好，CLI 任务参数不变。

部分更新支持“只把署名改成林悦，其他保持”等用户原句，须先检索或读取该身份的旧记录。`replace_text` 必须在旧值中唯一出现，替换内容按原文字面保存。写入或读回失败后，本轮对应的已保存提示和旧值缓存会失效，再次部分更新需要重新读取记录，核对存储中的实际结果。

隔离测试环境按实际读回记录的命名空间标签核验归属，较早记录也可读取。记录删除或过期时返回 `missing`，维护期间返回 `deferred`。偏好写入延期、写入回执拒绝和读回延期分别报告 `PREFERENCE_WRITE_DEFERRED`、`PREFERENCE_WRITE_UNACKNOWLEDGED`、`PREFERENCE_READBACK_DEFERRED`，可通过 `history task` 检查；这些状态均需后续核验才能确认保存完成。

授权工作目录中的基础目录查询、文本读取和写入在记忆工具组中也可调用。文件不存在时，工具提示通过 `coloop_list` 查询实际文件名，执行器可按目录返回的原样路径继续处理。CLI 仍通过 `task run` 发起并通过 `history task` 核对这些调用。

以下测试应使用独立身份和测试目录。第二轮不重复提供署名，用于检查跨任务检索；通过 `history task` 检查实际记忆工具调用，并独立读回草稿，不能只依据任务完成状态。

```powershell
$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
@{ prompt = '仅针对测试身份MemoryQA，请记住邮件偏好“中文先写结论，署名小林”。读取邮件1.txt，写回复草稿到草稿1.txt并回读核验。'; target = 'rk'; intent = 'execute'; workspace = 'D:\Coloop\.qa\memory-demo'; policy = @{ mode = 'local'; cloudFallback = $false } } | ConvertTo-Json -Depth 4 -Compress | .\coloop.cmd task run --stdin
.\coloop.cmd task wait --string '<TASK_ID>'
.\coloop.cmd history task --string '<TASK_ID>'
@{ prompt = '请使用测试身份MemoryQA已保存的邮件偏好，读取邮件2.txt，写回复草稿到草稿2.txt并回读核验。'; target = 'rk'; intent = 'execute'; workspace = 'D:\Coloop\.qa\memory-demo'; policy = @{ mode = 'local'; cloudFallback = $false } } | ConvertTo-Json -Depth 4 -Compress | .\coloop.cmd task run --stdin
```

完整实机回归入口为 `node scripts/with-workspace-cache.mjs tests/rk-memory-preferences-live.mjs --run-real-rk`，须先正常退出占用 RK 的实例。默认测试已构建源码，可通过 `COLOOP_EXECUTABLE` 指定候选包或安装版。测试使用项目内独立 profile、合成邮件和独立记忆命名空间，执行保存、盲读、署名更新、再次盲读四轮，并生成小型报告。隔离命名空间的显式偏好保留 24 小时以覆盖长任务，推断任务证据仍为 5 分钟；生产偏好不新增过期限制。测试不会向后续任务补充署名答案，遇到缺少前置记录会报告失败。

直接调用以下记忆管理与凭据写入命令前，用 `credentials protect` 传入 `true` 进入私密管理模式。完成后传入 `false` 退出。模式切换会复用现有执行互斥和观察保护。任务中的偏好工具按用户原句授权，无需在运行任务期间开启私密管理模式。

| 命令                                                         | 参数与作用                                                                                                 |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `credentials protect`                                        | `true` 或 `false`                                                                                          |
| `credentials list`                                           | 凭据元数据列表                                                                                             |
| `credentials create`                                         | `{origin, username, password}`，保存凭据                                                                   |
| `credentials delete`                                         | 凭据 ID                                                                                                    |
| `credentials open`                                           | 凭据 ID，打开同源隔离登录窗口                                                                              |
| `credentials fill`                                           | `{field, index?}`，field 为 username 或 password，index 默认 0，按可见可编辑同类输入框的文档顺序选择并聚焦 |
| `credentials close`                                          | 关闭登录窗口                                                                                               |
| `memory browse`                                              | `{query?, category?, offset?, limit?}`                                                                     |
| `memory save`                                                | `{key, value, kind, tags?, summary?}`                                                                      |
| `memory revise`                                              | `{id, value, tags?, summary?}`                                                                             |
| `memory remove`                                              | 普通记录 `{category:"ordinary", id}`，私密引用 `{category:"private", recordId}`                            |
| `memory create-private`                                      | `{origin, username, password}`，保存凭据并同步记忆索引，返回 `indexed`                                     |
| `memory open-private`                                        | 凭据记录 ID，打开对应登录窗口                                                                              |
| `memory open-private-editor` / `memory close-private-editor` | 显示或关闭专用录入窗口，命令行录入使用 `memory create-private`                                             |

`credentials fill` 复用网站源、焦点和 RK 输入核验。返回的 `outcome` 为 `not_sent`、`input_sent` 或 `unknown`，`message` 提供进度说明。`input_sent` 表示键盘输入已发送，页面效果仍需核对。网站的登录提交遵循现有登录流程。

## 可复制的 PowerShell 示例

### 发起任务、等待、读取详情

```powershell
$request = @{ prompt = '请总结当前屏幕的主要内容'; target = 'cloud'; source = 'screen' }
$started = $request | ConvertTo-Json -Compress | .\coloop.cmd task dispatch --stdin | ConvertFrom-Json
if (-not $started.ok) { throw $started.error }
$taskId = $started.value.id
.\coloop.cmd task wait $taskId --timeout 0
.\coloop.cmd history task --string $taskId
```

### 导入图片并 OCR

```powershell
$image = .\coloop.cmd screen open --string 'D:\Coloop\example.png' | ConvertFrom-Json
if (-not $image.ok) { throw $image.error }
.\coloop.cmd ocr recognize --string $image.value.id
.\coloop.cmd history export --string 'D:\Coloop\history.json'
```

### 修改模型设置

```powershell
$settings = .\coloop.cmd settings get | ConvertFrom-Json
if (-not $settings.ok) { throw $settings.error }
$settings.value.provider.model = '你的模型名称'
$settings.value | ConvertTo-Json -Depth 20 -Compress | .\coloop.cmd settings save --stdin
.\coloop.cmd provider test
```

设置对象可以带 `provider.apiKey` 或 `decisionProvider.apiKey` 更新密钥，带 `clearKey: true` 清除对应密钥。未传新密钥时沿用已有配置。

### 转写本地语音

音频须为 16 kHz、单声道、PCM16 的 WAV 文件，音频最长 120 秒，文件最大 5 MiB。参数为 WAV 字节的纯 Base64 字符串。

```powershell
$wave = [System.IO.File]::ReadAllBytes('D:\Coloop\sample.wav')
[Convert]::ToBase64String($wave) | ConvertTo-Json -Compress |
  .\coloop.cmd voice transcribe --stdin --timeout 200000
```

### 回答任务问题

```powershell
$state = .\coloop.cmd status | ConvertFrom-Json
$answer = @{
  taskId = $state.value.proactive.taskId
  questionId = $state.value.proactive.question.question_id
  answer = '保存到任务工作区'
}
$answer | ConvertTo-Json -Compress | .\coloop.cmd proactive answer --stdin
```

### 查询记忆

```powershell
'true' | .\coloop.cmd credentials protect --stdin
try {
  @{ query = '偏好'; category = 'ordinary'; limit = 25 } |
    ConvertTo-Json -Compress | .\coloop.cmd memory browse --stdin
} finally {
  'false' | .\coloop.cmd credentials protect --stdin
}
```

### 隔离数据目录

```powershell
$env:COLOOP_DATA_DIR = 'D:\Coloop\.cache\cli-profile'
.\coloop.cmd start
.\coloop.cmd status
.\coloop.cmd app quit
```

开发和验收 profile 放在项目内。`COLOOP_DATA_DIR` 指定的目录包含该实例的真实状态，其清理需按具体用途处理。

## 本地接口与维护

本地控制服务监听随机的 `127.0.0.1` 端口。当前用户专属目录 `<用户数据目录>/local-control/connection.json` 保存地址和令牌，每次应用启动生成新令牌，正常退出移除发现文件。

通用客户端可带 `Authorization: Bearer <token>` 请求 `GET /v1/commands`，或向 `POST /v1/call` 发送 `{"id":"请求UUID","command":"task:dispatch","args":[任务对象]}`。请求上限为 32 MiB。服务检查 Host、来源和令牌。

业务入口通过 `src/main/index.ts` 的 `handle` 同时注册到 IPC 和命令注册表。命令参数说明维护在 `src/main/services/command-catalog.ts`，优先复用共享 Zod Schema。带文件选择器的入口接受显式路径，私密内容录入通过本地鉴权命令直接调用已有服务。

新增功能时同步注册命令、参数 Schema 和本手册中的操作方式，使 AI 能通过 `commands` 发现入口，并完成参数传入、状态查询、停止或结果读取。

项目级调用和维护约定集中在 [AGENTS.md](../AGENTS.md)。统一验收覆盖源码构建、目录包启动、CLI 鉴权和历史读取、历史详情页、运行中消息队列、退出入口，以及包内依赖。真实用户 Edge 接入、真实设备业务操作和安装路径验收仍待执行。

## 主页实时任务与自动推进

主页显示运行任务的名称、阶段、最近 30 条对话与工具输入/输出。普通任务过程每 2 秒读取 `history task`，后台任务的事件、推进判断、发送内容与回执随 `status.value.autoAgentWork` 实时更新。完整记录入口可查看全部已保留记录。

| 命令                 | 输入        | 返回                   |
| -------------------- | ----------- | ---------------------- |
| `auto-agent enabled` | JSON 布尔值 | `{ enabled: boolean }` |

```powershell
'true' | .\coloop.cmd auto-agent enabled --stdin
.\coloop.cmd watch
'false' | .\coloop.cmd auto-agent enabled --stdin
```

开启时自动安装当前任务工作目录的 Codex Hook，监听已接入的 Codex 和 OpenCode 会话。新用户任务到达后自动绑定并按原会话要求推进，状态字段 `autoAgentWork.enabled` 表示开关状态。首次 Hook 信任若由原应用要求，需在那里完成。其他工作目录可通过 `auto-agent install-hooks` 接入。关闭会暂停现有跟进并停止自动绑定新任务，恢复已有任务使用 `auto-agent update` 的 `resume`。开关持久保存，应用重启后已有任务仍保持暂停，待核对后恢复。

## 任务输入栏权限

任务输入栏可选择 `ask`（请求批准）、`auto`（帮我批准）、`full`（完全访问权限）。新聊天默认 `auto`，历史聊天和缺少该字段的旧执行记录沿用 `full`。每个聊天独立保存 `permissionMode`，新轮次受理时写入 `run.policy.permissionMode`，排队、运行及恢复中的轮次使用已保存的设置。

`ask` 在文件、网络及电脑工具操作前逐次请求批准。`auto` 自动允许已识别的只读工具，对写入、通用执行和未知工具请求批准。`full` 自动执行当前任务已开放的工具，访问范围仍由工作目录、连接和凭据服务控制。内部历史读取、工具目录与业务提问可直接执行。

| 命令 | 参数补充 | 返回及行为 |
| --- | --- | --- |
| `conversation create` | `{title?, permissionMode?:"ask"\|"auto"\|"full"}` | 返回聊天 ID |
| `conversation update` | `{id, permissionMode:"ask"\|"auto"\|"full"}` | 保存下一轮权限 |
| `conversation list` / `conversation detail` | 沿用原参数 | 返回聊天权限及每轮 `policy.permissionMode` |
| `task dispatch` | `policy` 可包含 `permissionMode` | 本次任务执行权限 |
| `proactive answer` | `{taskId, questionId, answer:"允许本次"\|"拒绝本次"}` | 回答当前授权请求，批准后继续工具操作 |

等待授权时状态为 `waiting_user`，问题沿用 `status.value.proactive.question`。只有精确回答“允许本次”才放行该次操作。拒绝或停止会阻止该次工具调用，后续执行结果通过任务历史核对。

```powershell
'{"permissionMode":"auto"}' | .\coloop.cmd conversation create --stdin
'{"id":"聊天UUID","permissionMode":"ask"}' | .\coloop.cmd conversation update --stdin
.\coloop.cmd help conversation update
```

### DSH 原生审批与三端处理

执行层使用 DSH `tools/pre-execute` 返回 `allow`、`deny` 或 `ask`。`ask` 由原生 `dsh-user-approval` 记录 `approval/asked`、`approval/decided`，只有 `allowed-once` 放行该次调用。`rejected`、`cancelled`、`unavailable` 都阻止调用。DSH `approval.policy=never` 的语义是自动拒绝审批请求。工具可见性及原生拒绝决定继续生效。

需要用户审批时，任务会话和灵动岛显示“允许本次”“拒绝本次”。已配对手机 App 在连接并同步状态后显示同一请求，任一入口处理后，其他入口随状态更新清除请求。审批字段 `kind:"approval"`、`toolName`、`callId` 和脱敏 `details` 位于 `status.value.proactive.question`。无需审批的调用按权限策略自动执行。

CLI 沿用 `proactive answer --stdin`，参数为 `{taskId, questionId, answer:"允许本次"}` 或 `answer:"拒绝本次"`。手机加密 RPC 的 `snapshot` 新增可选 `approval`，包含 `taskId`、`questionId`、`title`、`question`、`toolName`、`callId`、`details?`。`approval_answer` 接受 `{taskId, questionId, decision:"allowed-once"|"rejected"}`，返回 `{accepted:true, questionId, decision}`。过期或已处理请求返回 `APPROVAL_STALE`，客户端刷新状态核对结果。请求 ID、配对身份、过期时间和防重放规则沿用现有远程协议。

手机审批通过 App 前台连接轮询同步，离线时禁用按钮。后台系统推送尚未接入。
