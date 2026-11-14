# Auto Agent Work 验收记录 · 2026-11-06 至 2026-11-07

## 当前交付结果（2026-11-07）

### 主页配置追加：已安装并验收

源码 `8091944` 保留 **Auto Agent Work** 名称，在主页加入「配置并开启」入口及「功能配置」页；只有明确提交会话、目标与完成条件才创建跟进任务，成功后进入后台进度。配置页提供决策模型、个人记忆和后台任务入口，已有任务不隐藏新任务表单。

- 13 组界面检查通过，页面错误为 0；`home-ui.log` 和 `.qa/auto-agent-work-ui/report.json`。
- `npm run build`、完整目录包及候选包 proactive smoke 通过；`.qa/auto-agent-work/home-build.log`、`home-package.log`、`home-candidate-smoke.log`，包验证报告 `.qa/proactive-package-1793989973399/report.json`。
- 包测试首次停在前一步设备页，未找到主页按钮；补充显式返回主页后通过，应用代码未改动。
- 用户正常退出旧应用后，已安装到 `%LOCALAPPDATA%\Programs\Coloop`，148,890 个文件逐项校验一致；`backup: null`，旧 `app.asar` 不存在，用户数据保留。安装记录：`.qa/auto-agent-work/install-home.json`；哈希：`installed-home-hashes.json`。
- 实际安装路径 proactive smoke 通过，包含主页进入功能配置再查看后台任务、原有 Hook 和 IPC 协议检查；报告 `.qa/proactive-package-1794019143541/report.json`。隔离 profile、Hook 测试目录及测试凭据均已清理。安装目录依赖校验通过，记录 `home-installed-dependencies.json`；已从 `start.cmd` 启动并确认进程来自固定安装目录。
- 本轮仅修改界面及测试，没有修改运行依赖或推进逻辑，未重复 runtime smoke 或真实云端续推测试，新增模型费用为 0。真实续推证据仍为下方上一轮样本；本轮包 smoke 不冒充真实桌面推进验收。
- 本轮目录包 `release/auto-agent-work-home` 已经 `-IncludeCurrent -OnlyCurrent` 清理并核对不存在，记录 `.qa/auto-agent-work/cleanup-home-candidate.json`。此前被策略拒绝的历史包、out 和临时目录未重试，仍不记为已清理。

以下为上一轮已经完成的安装验收：

**安装版核心闭环验收通过。** 该轮安装源码为 `91c6917`，完整安装到 `%LOCALAPPDATA%\Programs\Coloop`，校验 **148,890 个文件**，没有创建备份，旧 `app.asar` 不存在，并已从统一入口 `start.cmd` 启动。原生 Hook、DSH 云端判断、RK 向同一会话续推、原生回执和自动验收，在下面的真实安装版任务中串联通过。

用户追加的界面调整已安装：一级导航为 **主页、后台任务、设备连接、历史记录**；电脑操作和屏幕工具归入主页，Auto Agent Work、工作流和 Agent 协调归入后台任务，模型连接归入设备连接。记忆管理和使用指南位于辅助入口。历史记录提供 Agent 跟进记录，可进入对应任务查看验收、费用与可选评价。

真实聊天名从本机 Codex `session_index.jsonl` 按完整会话 ID 匹配，显示为 **会话名.codex**；原生 ID、工作目录及能力信息收进详情。不读取聊天正文来猜名，不调用模型；本地名称不可得时显示未命名与短标识。后台绑定和执行继续使用完整 ID，名称变化不修改任务授权。已在实际安装界面观察到 `Auto Agent Work 桌面原生验收.codex`。

## 最终真实推进样本

- 安装版本：`91c6917`；任务：`32bc09d4-dfa3-447c-bff4-2925b7644637`，绑定原生会话 `01a1b132-77a4-7791-a257-2003fa0209ec`。
- 操作者仅发送 READY 准备消息、设置目标、选择会话并将焦点留在空输入框；没有人工发送 DONE 指令，也没有手动标记完成。
- Coloop 判断 READY 不满足验收，生成一次针对缺口的续推。动作 `dba1609c-98ef-41f0-bb5a-2439bba6fa4e` 使用 `desktop` 通道和现有 RK 输入，最终为 **confirmed**。
- 原生回执正确归属 `origin: coloop`，包含同一动作编号；末尾 LF 不再误触发用户接管。原 Agent 在轮次 `01a1b208-7e66-7023-8234-72b9152f2866` 的 Stop 中只回复 `COLOOP_INSTALLED_FINAL_DONE_e1b29a0c`，实际界面回读一致。
- DSH 随后给出 `complete`，验收 **pass**、缺口为空；任务保持版本 1，自行进入 **completed**，没有重发、人工恢复或错误暂停。单个样本从创建到完成 **25.102 秒**，不作为通用延迟承诺。
- 本次记忆检索为 `empty`、引用 0 条；先前由通用词 `new` 误匹配的订单案例未再进入该任务。个人评价 **0 条**，未提交不视作正反馈。

完整脱敏证据：[installed-final-flow.json](../.qa/auto-agent-work/installed-final-flow.json)。该样本证明本机 ChatGPT Windows 本地 Work/Codex 会话的自动续推与收尾，不扩展为普通 Chat、Work Cloud、所有桌面版本或全部并发/断连场景通过。

## 验证与费用

| 验证 | 实际结果 |
| --- | --- |
| 完整软件回归 | 76 个文件，**1,424 项通过、3 项跳过**；[日志](../.qa/auto-agent-work/navigation-full-regression.log) |
| 界面与导航 | **12 组通过**，包含四个一级入口、原有工具可达、会话名、宽窄布局、历史跳转及反馈；[报告](../.qa/auto-agent-work-ui/report.json) |
| 构建与完整包 | `npm run build` 与完整目录打包通过；[构建日志](../.qa/auto-agent-work/navigation-build.log)、[打包日志](../.qa/auto-agent-work/navigation-package.log) |
| 安装校验 | **148,890 个文件**一致、`backup: null`；[安装记录](../.qa/auto-agent-work/install-navigation.json)、[文件哈希](../.qa/auto-agent-work/installed-navigation-hashes.json) |
| 实际安装路径 proactive smoke | `ok: true`；[报告](../.qa/proactive-package-1793987889930/report.json) |
| 实际安装路径 runtime smoke | 包内 Node/Python、DSH、局部压缩、Stagehand、中文 DOCX 和 ZIP 读回通过；[报告](../.qa/runtime-package-windows-no-credentials-1793987889658/report.json) |
| 真实云端和 RK | 当前默认 DeepSeek/deepseek-flash 经 DSH 推进，实际同会话回执、Stop 与自动完成均通过；见最终样本 |

最后样本 **9 次 Coloop 模型请求、48,638 tokenUnits、估算 ¥0.120388**。本轮包括前序失败的累计数为 **52 次请求、226,714 tokenUnits、估算 ¥0.560078**，全部结算，无重复累计；[费用记录](../.qa/auto-agent-work/final-usage.json)。费用按现有配置费率估算，不含目标 ChatGPT 订阅或其独立模型用量。

此前真实文本、合成 OCR 字串和截图测试证据保留在历史章节。截图测试是测试专用图像路径下的随机合成窗口，不能推广为任意端点支持视觉；本次最终桌面链路使用原生事件、控件/OCR 与 RK。未单独配置强模型服务商进行真实复测。旧未知草稿的 `resume_draft` 仅有软件和部分实机诊断证据，不由这次普通发送成功代替；长期习惯效果、全部多窗口/最小化/断连矩阵不在本轮通过范围内。

## 清理与保留

固定安装版、用户数据、密钥、记忆和累计费用账本保留。本轮所有完整候选包已删除，包括 `auto-agent-work-session-label` 与最终 `auto-agent-work-navigation`；最后清理使用 `prune-local-builds.ps1 -IncludeCurrent -OnlyCurrent`，见 [最终候选清理](../.qa/auto-agent-work/cleanup-navigation-candidate.json)。未创建安装备份。源码记录见 `91c6917`；此前功能与修复提交保留在 Git。

**清理存在明确阻塞，不能称全部临时产物清空。** 自动审批检查以 `blocked by policy` 拒绝历史 `release/current`、29 个已审计 runtime 临时子目录，以及 `D:\Coloop\out`、`D:\Coloop\.cache\vite-auto-agent-work-ui` 的删除；未提供更具体理由，未更换工具或路径绕过。这些路径未记作已删除。其余用途未确认的历史目录也未盲删。只保留必要报告与哈希不等于上述残留已清理。

下面是此前失败及阶段证据，按当时版本记录；其中“当前”“待安装”等词仅描述历史阶段，不覆盖以上最终结果。
## 历史阶段记录（以下为此前版本的结果）

恢复版本 `ec0278b` 已完成完整安装和安装路径验证，并取得**云端决定 → RK 粘贴与发送 → 原 ChatGPT 会话回复正确完成码**的真实证据。Auto Agent Work 仍未完成正确的自动收尾：原生 `UserPromptSubmit` 比已登记消息多一个末尾换行，自动消息被误判为用户输入，任务随即暂停，动作仍为 `accepted`。这一里程碑证明本次真实发送及回复已经发生，不能写作监督任务的完整验收通过。源码修复 `96e6123` 已通过完整回归，涵盖单个额外末尾 LF 的自动消息归属、无敏感内容的分项 RK 诊断，以及 `:focus` 未发送回执保留；新构建、安装和实机复验尚未完成。此前的失败记录与费用继续保留，不因 11 月 7 日追加记录而跨日清零。

## 源码与交付状态

| 项目                   | 记录                                                                                                 |
| ---------------------- | ---------------------------------------------------------------------------------------------------- |
| 功能实现提交           | `6c2e5cf` — `feat: implement DSH Auto Agent Work supervision`                                        |
| 补充界面文案与测试提交 | `f101d0c` — `test: verify desktop hooks and installed Auto Agent Work`                               |
| 当前安装版提交         | `ec0278b459129436d503d7517e249ccc7bee553a`；已完整替换固定安装目录                                   |
| 最新源码修复           | `96e6123c4c34dc67c81a19be88964f2bdc45ffd6`；完整回归通过，正在准备新构建，尚未安装                   |
| 固定安装路径           | `%LOCALAPPDATA%\Programs\Coloop`                                                                     |
| 第一候选包             | `release/auto-agent-work/win-unpacked`，已完成安装与实际安装路径验证，随后清理                       |
| 已清理审阅候选包       | `9f8a1cac` 的 `release/auto-agent-work-reviewed/win-unpacked` 已完成安装路径 smoke，暂存目录随后删除 |
| 已清理恢复候选包       | `ec0278b` 的 `release/auto-agent-work-recovery` 已删除；新修复候选待构建                             |
| 安装文件校验           | `ec0278b` 完整同步后校验 **148,890 个文件**，旧 `app.asar` 不存在；`backup: null`，未创建旧安装备份  |
| 已完成构建             | `ec0278b` 的 `npm run build` 及完整目录打包通过，包含稳定核验、RK 草稿恢复和 Hook 工作区状态修复     |
| 最新恢复实现           | 已完成安装 smoke 和本次真实 RK 发送/Agent 回复；自动消息归属错误导致任务暂停，监督收尾未通过         |

当前安装证据见 [install-recovery.json](../.qa/auto-agent-work/install-recovery.json)，文件摘要见 [installed-recovery-hashes.json](../.qa/auto-agent-work/installed-recovery-hashes.json)，涵盖 exe、主进程、Hook 与 RK 执行适配器。安装记录中的 `pending_installed_acceptance` 是同步结束时的状态，其后实际安装路径 proactive/runtime smoke 均通过，见下文独立报告；该脚本字段不代表 RK 业务闭环已通过。此前审阅版的 [install-reviewed.json](../.qa/auto-agent-work/install-reviewed.json)、[installed-reviewed-hashes.json](../.qa/auto-agent-work/installed-reviewed-hashes.json)，以及第一候选的 [install.json](../.qa/auto-agent-work/install.json)、[installed-hashes.json](../.qa/auto-agent-work/installed-hashes.json) 仅保留为历史证据，没有保留对应旧安装副本。

## 已完成的验证

| 验证层                     | 结果与实际覆盖                                                                                                                                                | 边界                                                                                                |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 软件回归                   | `96e6123` 最新完整 `npm test`：75 个测试文件，1,419 项测试通过，3 项跳过                                                                                      | 包含消息归属、分项诊断与回执保留的软件回归；跳过项不计通过，不代替部署或实机验收                    |
| 恢复协议与执行守卫         | RK 相关 Python 32 项、TS bridge 17 项通过；service/adapter 定向 71 项、desktop 26 项及 foreground 稳定核验回归通过；五组联合回归 176 项通过                   | 这些集合存在重叠，不累加为独立测试总数；软件测试无真实输入，不替代已安装恢复版本的实机结果          |
| Hook 子进程传输回归        | adapter 测试 22 项通过；真实子进程验证 2 MiB stdin 完全排空、无 EPIPE、零 HTTP 转发、严格单行 JSON，以及合法 Stop 输出和权限字段隔离                          | 复用 OMX MIT 传输实现；该项不证明桌面业务续推或原 Agent 权限审批已通过                              |
| 编辑器真实只读 probe       | 空态与占位提示同名的真实草稿，两种情况下新草稿读取路径在 recognize、CUA、FlaUI 后三阶段均成功                                                                 | 无粘贴或发送；旧 selection 读取路径仍报告 `EDITOR_BINDING_CHANGED`；多行 probe 因用户切页失焦未通过 |
| 记忆与反馈定向验证         | 检查偏好来源、私密与凭据排除、反馈修正关系、原 ID/原文幂等重试、真实用户选择案例；Python worker 5 项通过                                                      | 不把自动选择或模型推断写成用户明确偏好；未据此声称长期习惯自动归纳已完成                            |
| 真实云端 DSH 判断          | 实际配置的 `deepseek-flash`、默认模型角色；文本验收通过时 `complete`，安装验收遗漏时 `continue`，OCR 字串选择题时 `reply`；真实随机图像能力探测为 `supported` | 任务、文件及 OCR 字串是合成验收材料；本轮未实测所有服务商及独立强模型配置                           |
| 真实截图进入云端           | 对隐藏合成窗口实际执行 `capturePage`，模型读出只在图像中的随机工单码，并正确选择继续安装核验                                                                  | 证明真实图像输入与判断，未把合成窗口当作生产 agent 窗口的完整视觉回写验收                           |
| 真实桌面原生 Hook P0       | 在同一桌面会话与同一轮次内取得首次 `Stop`、领取续推动作、原生继续后的第二次 `Stop`，确认第二个随机标识；动作回执 `confirmed`                                  | 该 P0 不自行调用云端模型，也不证明云端判断与 RK 回写已经贯通；工具发送路径不作为通过证据            |
| 真实安装版 RK 发送与回复   | `ec0278b`：真实云端 `reply` 决定后，paste 为 `effect_verified`，send 为 `input_sent`，同一原生会话的 Stop 正文为目标完成码                                    | 独立新任务的一次发送样本；任务因自动消息误归属而暂停，不代表完整自动收尾或旧草稿恢复已经通过        |
| 界面审阅                   | 最新 11 组检查通过、无页面错误；增加绑定/切换任务工作区、旧根状态隔离、卸载目标、路径规范化，以及失焦刷新期间单击安装不丢失                                   | 实际 React 页面在隔离的 headless Chrome 中使用 API fixtures；无真实桌面、外部 agent、云模型或 RK    |
| 实际安装版 proactive smoke | `ec0278b` 的快照、preload、页面、包内 Node/Hook、认证、任务操作、缺模型不写入/不请求云端及卸载保留既有配置均通过                                              | 隔离 profile；`desktopVerified: false`，属于 `protocol_smoke`；不代替真实 RK 业务闭环               |
| 实际安装版 runtime smoke   | `ec0278b` 的包内 Node/Python/依赖、官方 DSH、局部压缩、Stagehand 实际读回、Docling、ZIP 读回通过；依赖均来自实际安装目录                                      | 使用本地页面和合成模型端点；无付费模型、用户账号、RK 或 HID                                         |

对应可复查证据：

- 最新源码 `96e6123` 完整回归：[receipt-normalization-regression.log](../.qa/auto-agent-work/receipt-normalization-regression.log)，75 个文件通过、1,419 项通过、3 项跳过。此日志是软件测试证据，不代表该提交已构建或安装。
- 此前恢复版本完整回归：[recovery-full-regression.log](../.qa/auto-agent-work/recovery-full-regression.log)，记录 75 个文件通过、1,386 项通过、3 项跳过；对应类型检查：[recovery-final-typecheck.log](../.qa/auto-agent-work/recovery-final-typecheck.log)。联合回归：[recovery-integrated-tests.log](../.qa/auto-agent-work/recovery-integrated-tests.log)，176 项通过；desktop 定向：[recovery-desktop-tests.log](../.qa/auto-agent-work/recovery-desktop-tests.log)，26 项通过。此前 1,347 项通过的 [final-regression.log](../.qa/auto-agent-work/final-regression.log) 保留，不与新结果累加。
- `9f8a1cac` 构建：[final-reviewed-build.log](../.qa/auto-agent-work/final-reviewed-build.log)；完整打包：[final-package.log](../.qa/auto-agent-work/final-package.log)；候选 proactive：[report.json](../.qa/proactive-package-1793979296606/report.json)。这些记录不包含后续草稿恢复实现。
- 最新 `ec0278b` 构建：[recovery-build.log](../.qa/auto-agent-work/recovery-build.log)；完整打包：[recovery-package.log](../.qa/auto-agent-work/recovery-package.log)；恢复候选 proactive：[report.json](../.qa/proactive-package-1793982145591/report.json)。
- 编辑器空态：[editor-fixed-empty-final.log](../.qa/auto-agent-work/editor-fixed-empty-final.log)；同名草稿：[editor-fixed-same-text.log](../.qa/auto-agent-work/editor-fixed-same-text.log)。两份日志均为真实原生窗口只读采集，不包含输入动作；三阶段的 `draftResult.ok` 均为 `true`，空态返回 `textLength: 0`，同名草稿返回 `textLength: 12` 且 `matchesExpected: true`。
- 真实云端文本、遗漏再续推、OCR 字串及图像能力：[e58da83a-6392-4f02-977a-dc185ea218b2.json](../.qa/auto-agent-cloud-smoke/e58da83a-6392-4f02-977a-dc185ea218b2.json)。文字与工具调用验证通过，三项判断均符合预期，生产设置未修改。
- 合成窗口真实截图：[17c38e7d-824a-4f66-ba45-7d91451e2039.json](../.qa/auto-agent-cloud-smoke/17c38e7d-824a-4f66-ba45-7d91451e2039.json)，以及[对应截图](../.qa/auto-agent-cloud-smoke/17c38e7d-824a-4f66-ba45-7d91451e2039-screenshot.png)。报告确认 `observedModes: ["image"]`、文本通道不含界面正文、随机挑战读取正确、选择正确。
- 真实桌面 P0：[3022fd5c-b3fd-4681-8227-a2813003de4c.json](../.qa/auto-agent-work-desktop-p0/3022fd5c-b3fd-4681-8227-a2813003de4c.json)。同一 `nativeSessionId` 与 `turnId`，首次 `Stop` revision 7，第二次 `Stop` revision 9，`stopHookActive: true`，关联同一已领取动作并含第二个随机标识；已有 Hook 保留、临时 Hook 清理完成，未绕过来源信任。
- 界面审阅：[report.json](../.qa/auto-agent-work-ui/report.json)，截图在同目录。
- `9f8a1cac` 实际安装版 proactive：[report.json](../.qa/proactive-package-1793979604753/report.json)，`ok: true`，profile、Hook 项目与凭据清理标记均为 true。第一候选的 [proactive 报告](../.qa/proactive-package-1793974802884/report.json) 保留。
- `9f8a1cac` 实际安装版 runtime：[report.json](../.qa/runtime-package-windows-no-credentials-1793979604501/report.json)，`ok: true`。Node v24.14.0、DSH、Stagehand、Playwright 与其他依赖均来自 `%LOCALAPPDATA%\Programs\Coloop\resources`，没有借用开发目录依赖。第一候选的 [runtime 报告](../.qa/runtime-package-windows-no-credentials-1793974810970/report.json) 保留。
- 最新 `ec0278b` 实际安装版 proactive：[report.json](../.qa/proactive-package-1793982464309/report.json)，`ok: true`，profile、Hook 项目及凭据清理标记均为 true，Auto Agent Work 检查仍明确为 `protocol_smoke`。
- 最新 `ec0278b` 实际安装版 runtime：[report.json](../.qa/runtime-package-windows-no-credentials-1793982464057/report.json)，`ok: true`；Node v24.14.0，全部依赖解析路径位于实际安装目录，DSH、局部压缩、Stagehand、Docling 和 ZIP 检查均通过。
- `ec0278b` 真实 RK 里程碑：[installed-rk-progress-before-normalization.json](../.qa/auto-agent-work/installed-rk-progress-before-normalization.json)，记录于 2026-11-07 00:51:53（Asia/Shanghai）；包含真实粘贴、发送回执及原会话 Stop 回复，也明确保留暂停状态和前置失败。

## 云端用量与失败记录

截至 **2026-11-07 本次账本取数**，计入上述真实 RK 里程碑后，本轮 Coloop 云端验收累计 **43 次请求、178,076 tokenUnits、估算费用 ¥0.439690**。其中 11 月 6 日为 35 次、126,580 tokenUnits、¥0.321884，11 月 7 日新增 8 次、51,496 tokenUnits、¥0.117806。费用采用账本记录的费率，包含报告未完整落盘的一次截图运行和未完成收尾的尝试，不因缺少通过证据而漏算，也不因跨日而清零。

| 运行                               | 请求数 |  tokenUnits |      估算费用 | 证据状态                                       |
| ---------------------------------- | -----: | ----------: | ------------: | ---------------------------------------------- |
| 文本、遗漏续推、OCR 字串与能力探测 |     13 |      24,813 |     ¥0.069444 | 完整报告，通过                                 |
| 有完整报告的真实截图运行           |      4 |      11,936 |     ¥0.031228 | 完整报告，通过                                 |
| 报告未完整落盘的另一截图运行       |      4 |      11,148 |     ¥0.027750 | 费用计入；不计作验收通过                       |
| 首次实际安装版贯通尝试             |      2 |       7,305 |     ¥0.018516 | 判断正确，发送前失败；不计贯通通过             |
| 安装版追加尝试（版本 3–5）         |     12 |      71,378 |     ¥0.174946 | 包含前台阻断、ask_user 及未发送草稿；未通过    |
| 新任务的真实 RK 发送与完成码回复   |      8 |      51,496 |     ¥0.117806 | 前置焦点失败后发送成功；任务误暂停，收尾未通过 |
| **合计**                           | **43** | **178,076** | **¥0.439690** | 包含本次 11 月 7 日新任务，不重复累加旧费用    |

旧生产任务 `569ae626-695c-4940-af5e-0e9891417bc1` 的累计账本仍为 14 次请求、78,683 tokenUnits、¥0.193462，已含首次失败的 2 次请求；新任务 `b61be7e2-1dff-46b5-b7fd-c843d54ccfb5` 为 8 次请求、51,496 tokenUnits、¥0.117806。基线运行的 13 次包含主任务 `e58da83a-6392-4f02-977a-dc185ea218b2` 的 9 次及能力探测任务 `b86c89c6-133e-4115-8273-35361ce96290` 的 4 次（2,916 tokenUnits、¥0.008946），能力探测只计入一次。聚合按顶层 `taskId` 过滤、`type + id` 去重，次数取 request，tokens/费用仅取 response 的 `chargedTokenUnits` / `estimatedCostYuan`，不重复累加预留值；此次取数无未结算请求。报告未复制凭据或无关记忆正文。

早期云端探针存在启动失败及 `MODEL_KEY_DECRYPT_FAILED`，失败报告保留在 `.qa/auto-agent-cloud-smoke`，不能从后续通过结果中抹去。修正 Electron 初始化并保留对应用户的 `sessionData` 解密环境后，成功报告确认读取实际配置并完成真实调用，且生产设置保持不变。没有把密钥或生产完整状态写入本报告。

另有一次严格裁剪 Windows 环境变量的 runtime 验证在 Stagehand 阶段超时。正常 Windows 环境、隔离凭据和测试 profile 的实际安装版运行通过，证据为上文 `runtime-package-windows-no-credentials-1793974810970`。因此本轮证明的是该正常环境下的包内运行能力；严格环境裁剪组合仍未通过，不能表述为全部环境均通过。

## 实际安装版回写进展、失败与追加修复

真实安装版任务 `569ae626-695c-4940-af5e-0e9891417bc1` 的目标是让绑定的原会话回复唯一完成码。实际云模型正确识别已有 READY 回复不满足验收，生成了要求原会话只回复目标码的 `reply` 决定。随后桌面回写遇到 `EDITOR_BINDING_CHANGED`，动作被记录为明确未发送的 `failed`；没有取得目标码的实际 Agent 回复，因此这轮**未通过贯通验收**。不能把正确的云端决定或发送尝试当作回写成功。

首次失败的脱敏记录见 [installed-first-flow.json](../.qa/auto-agent-work/installed-first-flow.json)。安装 `9f8a1cac` 后，对同一任务的追加尝试如下，均不计作闭环通过：

| 任务版本 | 决定与执行结果                                                                                                                  | 发送边界                                                      |
| -------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| 3        | `reply`；动作 `12cf3153-4a52-4011-a4a9-c54a1afafcc4` 因 `Foreground changed during OCR` 失败                                    | 输入前被阻止，未发送                                          |
| 4        | `ask_user`，要求恢复绑定窗口的前台条件                                                                                          | 没有新执行动作                                                |
| 5        | `reply`；动作 `2b846ca4-0da6-4abe-a904-1d4ad109f4f9` 已由 RK 粘贴 132 字符，随后 `clipboard.verify` 返回 `INPUT_EFFECT_UNKNOWN` | 未按 Enter；动作 `unknown`，任务 `needs_user`，保留草稿待核对 |

[editor-real-paste.log](../.qa/auto-agent-work/editor-real-paste.log) 中三次只读 `draftResult` 均为 `ok: true`、`textLength: 132`、`matchesExpected: true`。这证明稍后的草稿与原消息一致，不能倒推当时即时核验已通过，也不能当作原 Agent 已收到或执行了消息。

随后使用 `ec0278b` 创建独立任务 `b61be7e2-1dff-46b5-b7fd-c843d54ccfb5`，绑定原生会话 `01a1b132-77a4-7791-a257-2003fa0209ec`，目标为只回复 `COLOOP_INSTALLED_FRESH_DONE_07a30b2d`。首次动作 `03962f59-d58c-4391-b328-2f94c1ab9248` 在前置焦点/目标检查处因 `INPUT_TARGET_CHANGED` 失败，不能计为成功发送。

下一动作 `abaef325-9a4d-4382-8c1c-b5cdf25443a3` 完成了真实 RK 输入：`:paste` 回执为 `effect_verified`，UIA 核验 2 次、耗时 129 ms，全部检查为 true；`:send` 回执为 `input_sent`，两份回执均确认释放输入。原会话随后在轮次 `01a1b1c4-55ca-7062-913f-93cc41841b16` 的 Stop 事件（revision 13）中只回复目标码。证据见上述 [真实 RK 里程碑报告](../.qa/auto-agent-work/installed-rk-progress-before-normalization.json)。这属于新消息发送路径，不是对旧未知草稿调用 `resume_draft` 的实机证明。

但本次 `UserPromptSubmit` 的正文恰好等于登记的 Coloop 消息再加一个末尾 `\n`，导致消息未被归为 Coloop 自动推进，而以 `origin: user` 进入事件流。服务因此按用户接管处理，将任务置为 `paused`、版本升至 3；动作仍为 `accepted`，没有自动变成完成验收。`96e6123` 已修复单个额外末尾 LF 的归属并通过回归，尚需构建、部署和真实复验，不能因为已取得完成码就把这次暂停改记为完整成功。

同一源码修复还补充了编辑器绑定/输入目标失败的分项诊断：只传递固定类别、阶段与布尔检查，不包含正文、窗口标题、原始控件或坐标；`:focus` 的明确未发送回执会保留，方便区分输入前拒绝与结果未知。该诊断不放宽执行或绑定检查，当前安装版尚不包含这组补充。

本轮追加审查确认以下问题及修复状态：

| 发现                           | 原行为与影响                                                                           | 源码处理及验证                                                                                                                                                                                                                                  | 安装验收状态                                           |
| ------------------------------ | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| 未发送失败后任务仍显示等待回执 | 动作已经 `failed`，任务仍停留 `waiting_receipt`，无法及时向用户解释阻塞                | `failed` / `unknown` 立即转为 `needs_user` 并展示原因；确认回执转回 `watching`；晚到结果不得覆盖用户暂停或新版本。补充测试覆盖原生确认分支及晚到 `accepted` 不得覆盖 `failed` / `unknown`                                                       | `9f8a1cac` 的版本 5 已实际显示 `needs_user` 与核对原因 |
| 无关历史案例进入决策上下文     | 该目标仅需要续推完成码，却带入 5 条邮件订单、草稿、网页表单及视频操作案例              | RK catalog 按向量检索取前 5 条，没有返回 score 或最低相关性阈值；原 host 未加案例相关性门槛。已加入保守主题过滤，排除通用测试/验收/回复词、随机标识和禁止操作句；明确通用偏好仍可保留。真实已存内容只读回放由 5 条降为 0 条，记忆测试 10 项通过 | `9f8a1cac` 任务当前 memory 为 `empty`，引用 0 条       |
| 排队判断覆盖用户停止（P1）     | 判断已排入微任务队列但尚未建立取消控制器时，用户同步暂停、解绑或退出可能被后续判断覆盖 | 判断入口重新核对任务活动状态、应用退出、会话运行状态及版本证据进度；同步 pause、unbind、dispose 和新 running 事件先到的回归均通过，未调用模型或发送消息                                                                                         | 已随 `9f8a1cac` 安装；此分支仅有软件回归证据           |
| 审批被后续进度隐藏（P1）       | 原先只检查最后一条事件，审批后的 progress 可能遮住审批类型                             | 审批到来即取消既有推进并转为 `needs_user`，要求在原会话处理后显式恢复；晚到 progress 不自动恢复，提前恢复或绑定已有待审批会话均在模型前阻断；普通业务问题仍可推进。Planner 传入 `questionKind` 事实字段；对应回归通过                           | 已随 `9f8a1cac` 安装；此分支仅有软件回归证据           |
| 编辑器绑定变化                 | 真实回写在发送前被 `EDITOR_BINDING_CHANGED` 拦截                                       | 新草稿读取路径已在真实空态与同名草稿的三阶段只读 probe 中通过；保留旧 selection 读取失败记录，没有绕过目标核验或向其他聊天补发                                                                                                                  | `9f8a1cac` 已实测到 RK 粘贴；即时核验仍失败，未发送    |
| 粘贴后即时读数未稳定           | 实际草稿已粘贴，但即时核验为 unknown，后续三次只读检查均匹配                           | 增加有界只读稳定核验，限制原窗口/进程/焦点/编辑器身份与精确正文；失败回执仅保存 verified/source/checks/attempts/elapsed_ms/failure 白名单诊断，不复制正文                                                                                       | `ec0278b` 新任务核验 2 次/129 ms 通过，发送成功        |
| 未知粘贴结果无法安全续发       | 不能重粘贴，也不能假定已经发送                                                         | 显式恢复时核对原草稿、同 identity 的已释放 paste 回执及 `:send` 不存在；RK 持久限制仅执行该动作的一次 Enter，普通 begin 不解除限制；重复请求、重启和停止竞态均有回归                                                                            | 旧草稿恢复仍待实机；新消息发送样本不替代该项           |
| Hook 状态对应错误工作区        | 启动只查询默认工作区，真实事件来自另一已安装根，出现“尚未安装/已收到事件”矛盾          | 当前任务触发指定工作区刷新；根不匹配时隐藏状态和路径、禁用卸载；安装/卸载使旧刷新失效。失焦刷新不占用操作 busy，避免吞掉首次安装点击                                                                                                            | 隔离 UI 11 组通过；`ec0278b` 实际 UI 正在验收          |

记忆过滤没有修改或删除用户记忆库，也没有增加本地或云端模型推理调用。该过滤是保守的词项相关性门槛，可能漏掉只靠同义表达或跨语言语义才能关联的案例；它不代表已完成语义相关性评分校准。仅凭当前结果不能认定 RK 的具体向量分数异常，因为 catalog 未提供分数。

Hook 传输复用了 `Yeachan-Heo/oh-my-codex`（OMX）提交 `509a299d586b48f145c2c7a7baac8ce08d01a015` 的有界 stdin 排空和单行 JSON stdout 方式，落在 [auto-agent-work-hook.mjs](../resources/auto-agent-work-hook.mjs)，保留完整 MIT 许可与来源。Coloop 使用 64 KiB 输入上限，超限后继续排空、不转发；只输出经验证的 Stop `block/reason`，不透传权限批准或工具输入修改。22 项 adapter 回归包含真实子进程边界测试；这不表示整体续推、判断或执行服务均来自 OMX。

较早的编辑器多行 probe 因切页、输入框失焦未获得有效通过结果，**不计入成功样本**。空态、同名草稿和旧任务真实粘贴后的只读检查各自保留边界，均不能替代完整发送及结果回读。旧任务的 unknown 没有改写为成功；新任务的已发送及完成码回复由独立 RK 回执和原生 Stop 证明，但其任务暂停问题仍保留为未通过项。

## 尚未完成或不在本轮证据范围内

- **`pending`：自动消息归属与正确任务收尾。** 新任务已取得真实 RK 发送及原 Agent 完成码回复，但旧安装版仍因末尾换行差异误暂停。`96e6123` 规范化修复已通过软件回归，尚待重新部署和复验，不能把执行层里程碑等同于完整 Auto Agent Work 验收通过。
- **`pending`：`96e6123` 完整构建、打包、安装、安装路径验证及本轮候选清理。** 旧恢复候选已删除；当前安装仍为 `ec0278b`，未把源码修复及测试通过记为新版本交付完成。
- **`pending`：旧未知草稿仅恢复一次 Enter 的真实运行证据。** 新任务已实测有界稳定核验及普通消息发送，尚不能替代旧任务 `resume_draft` 路径的实机验收；旧任务的未发送草稿状态仍独立记录。
- 图像能力的真实通过结果只对应本轮实际测试的模型端点与模型标识；不能推广为其他配置均支持图像。单模型无视觉、明确不支持或能力未知时的降级契约有软件测试，未实测全部服务商组合。
- 记忆系统已有明确偏好、推断信息、反馈和选择案例的来源区分及重试/修正机制；本轮没有完成用户长期使用周期的习惯归纳效果评估，也没有把自动动作记录提升为用户偏好或新授权。
- 本轮只证明列出的样本及故障处理，不覆盖所有任务长度、多实例并发、全部桌面版本、所有审批界面和长时间断联后的真实设备恢复。
- 云端 OCR 场景验证的是读取合成 OCR 字串后的真实模型判断；不能单凭该项报告声称真实桌面 OCR 引擎、读取与回写全过程已验收。

## 缓存、安装副本与清理

本轮开发、构建、探针与测试的可配置临时目录使用 `D:\Coloop` 下的缓存或隔离测试目录。既有 `%APPDATA%\coloop` 用户数据、密钥、记忆库与累计费用账本不是构建缓存，未因清理约定删除或重置。

第一候选 `D:\Coloop\release\auto-agent-work` 已清理，见 [cleanup-first-candidate.json](../.qa/auto-agent-work/cleanup-first-candidate.json)。较早审阅候选的清理见 [cleanup-review-candidate.json](../.qa/auto-agent-work/cleanup-review-candidate.json)；随后重新构建并安装的 `9f8a1cac` 审阅候选也已删除，见 [cleanup-reviewed-before-recovery.json](../.qa/auto-agent-work/cleanup-reviewed-before-recovery.json)。`ec0278b` 恢复候选 `D:\Coloop\release\auto-agent-work-recovery` 已删除，见 [cleanup-recovery-before-receipt-fix.json](../.qa/auto-agent-work/cleanup-recovery-before-receipt-fix.json)。固定安装目录仍保留 `ec0278b`，未创建旧安装备份；下一源码修复 `96e6123` 正在进入新构建流程。这些清理仅涉及本轮已确认暂存目录，未触及历史受阻路径。

旧 `release/current` 的清理被自动审批策略拒绝，未更换工具或路径重试绕过，**该目录未记作已清理**。其他旧目录尚未逐项确认用途与活动占用，未盲目删除。最终候选清理和历史残留核对尚未完成，因此本报告不声称临时构建副本已全部清空；仅保留必要的小型验收报告与摘要不能替代这项清理收尾。
