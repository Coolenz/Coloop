# RK 与 Coloop 可靠性修复记录

本轮覆盖时钟、Mem0 维护、服务自启动、网络等待与新版 Harness 实机验证。保留 TARS / OpenCode 兼容入口、原有模型和全部历史执行证据。

## 已部署到 RK

| 问题                            | 修复                                                                                | 真实证据                                                     |
| ------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 时钟落后约 21 小时              | 初次校准并写 RTC；Coloop 连接后及每 5 分钟空闲检查，经固定 root helper 有界同步     | 重启后时差约 -0.707 秒；后续约 -0.6 秒                       |
| Mem0 自动维护 JSON 反复失败     | 摘要改纯文本生成、程序序列化；事实提取仍严格 JSON；失败持久退避；原批次未变化则跳过 | 真实 Qwen 摘要成功，1329→1162 字节；后续同批次检查只需数毫秒 |
| 模型与记忆依赖手动启动          | model / memory systemd 服务；记忆停止前排空；重启频率限制                           | 实际重启约 42.78 秒恢复；两服务 active                       |
| USB HID 开机未恢复              | 新 HID oneshot 使用已确认、root 所有的脚本与描述符，在厂家 USB 服务后恢复           | 重启后 RNDIS + 键盘 + 鼠标保留，两个 HID 节点可用            |
| NetworkManager-wait-online 失败 | 等待 3→30 秒；USB 地址固定为当前 169.254.207.141/16，不添加默认路由                 | 重启后网络等待成功，failed units 为零                        |

离线 USB 环境尚无可用公网 NTP；当前时间保证来自主机与 RTC，不能称为 NTP 已同步。

原有 84 条记忆逐字段一致，新增一条来源完整的摘要，共 85 条；通过真实服务读回普通事实并验证值相同，服务报告两条 capsules。摘要不属于 get_many 的 facts 层，原先用该接口读取摘要返回 missing 的探针已更正。没有将历史未核验记录改为 verified。

## 桌面与协议修复

- 仅为零参数 `coloop_observe` 和严格校验的扁平 `coloop_enable_tools` / `coloop_ask_user` 封装提供兼容；不补造 click、paste 或文件写入参数。SDK 继续检查工具和业务参数。
- 首轮明确当前窗口任务应启用 native 后观察，避免本地模型因看不到观察工具而先追问窗口标题。提示字节预算保持原约束，未通过扩大上下文上限掩盖问题。
- 同批 CUA 接入与云请求取消/单飞/咨询去重见 [CUA 集成](cua-integration.md) 和 [云请求检查](cloud-token-preflight.md)。
- Windows Forms 自绘复选框实际使用 BS_OWNERDRAW，普通 BM_GETCHECK 不能提供其真实状态。r7 只在该原生按钮分支读取同 HWND 的 MSAA role/state，校验进程、顶层窗口、可见/启用和 CheckButton 角色后返回 checked；不确定态省略 checked，保留原始控件身份。真实隔离控件 9 项通过，覆盖系统/自绘三态、普通按钮、禁用与错误 PID；没有放宽结果核验。
- 后续 r13 补齐精确编辑读取、版本前置条件、RichEdit 换行和真实 Ctrl+A 终段标记、有限协议重生成、按工具组缩减提示及控件状态进展计数。完整实现与分版实机证据见 [本地 Agent 验收](local-agent-reliability-20261105.md)。

## 验证记录与边界

- RK Python：191 项，10 项按环境条件跳过，其余通过。托管启动器另保留原有 cache / context / 资产路径覆盖与按需构建行为，已部署并实际启动核验。
- 当前 r13 的 Coloop 完整回归：66 个测试文件，1195 项通过、1 项可选 Docling 跳过；TypeScript、发布构建和隔离安装包 UI smoke 通过。
- r13 安装包 29,229 个构建/资源文件与源构建哈希一致；官方 Harness 0.2.1-rc.5、Stagehand 4.4.0 与 CUA 运行时完整打包。主 bundle SHA256：`14B504E23C9154F65C93C38A44B41F96AD3E2AD73FCBB04EED5A43F7819DCF3C`。
- 实机脚本 `tests/harness-reliability-live.mjs` 使用实际发布包的生产 API、真实模型和独立 WinForms 窗口；窗口状态只做旁路验收，不注入模型。所有云案例共用一个持久账本，每任务 6 次、每天 12 次请求上限，保守 tokenUnits 分别 150000/300000。
- 最早本地模型曾出现不规范工具封装及多余追问，均在输入前停止并保留失败报告。r5 的本地 checkbox 已真实执行一次 RK USB 点击，按下/释放各一次且窗口已勾选；模型随后重复观察，被 noProgress=4 限制阻断，整项任务不算成功。
- r5 的真实云端 Harness → CUA checkbox 已完成：4 次请求、约 17.106 秒，独立窗口 checked=true / click_count=1；回执 channel=cua_driver、input_sent、release_confirmed=true，coloop_verify 返回 verified=true，任务 completed。证据 `.qa/harness-live-cloud-cua-checkbox-1793873446022`。
- 修正固定 CUA 0.38 的 DWM 边界与截图裁边坐标后，真实组件 click / double_click / scroll 三项全部通过；同进程、执行器重建后的 journal 去重与停止后拒绝也通过。这是生产执行器组件的脚本验收，无模型调用且 RK fallback 为生命周期桩，不冒充模型自主或 RK 输入验收。证据 `.qa/cua-native-live-1793874320657-9961e49d/verification.json`。
- 首次云端 fixture 未取得前台，模型只看到任务栏，4 次请求后停止，零输入。现测试先隐藏 Coloop 主窗，再通过真实前台元数据验证 HWND/PID 与 fixture 相等，否则不派任务。这个失败不被计作 CUA 业务成功。
- r5 云端替换原文案例没有完成：paste 被正文保护拒绝，模型随后给出的 OCR 大小写错误导致 literal patch 不匹配；真实 BACKSPACE 已清空受控测试选区，之后被无进展保护停止。该案例已保留，没有放宽正文保护或重放输入。
- 本轮云端共 12 次请求，100178 tokenUnits（包含一次中断的保守预留，不等于精确账单 token）。12 个唯一请求与 12 个回执对应，无重复编号、无未结算、账实一致，达到日上限后停止云测试；没有清账本或切 profile 绕过额度。证据 `.qa/reliability-cloud-usage-audit.json`。
- r6 本地空白编辑器中文任务在首轮返回不合法 JSON 后拒绝执行，零输入。此样本仍未通过：单项业务通过也不能推断 Qwen 4B 在所有文字任务上都能稳定生成工具调用。该限制不会通过修补未知写入参数、放宽正文保护或隐藏失败结果来规避。
- r6 本地复选框已真实单击并直接核验，但原生观察把自绘复选框记为 Button、缺少 checked，核验正确返回 VERIFICATION_CONTROL_TRANSITION_UNPROVEN。该样本不计成功；r7 修复由上述真实控件状态读取覆盖。
- r7 真实本地完整闭环通过：官方 Harness → RK Qwen 4B → RK USB 单击 → 原生状态核验 → completed。共约 339.71 秒，独立窗口 checked=true，按下/释放/单击各一次，CUA 已关闭以单独证明 RK 输入路径；云台账仍为 12 次、100178 tokenUnits。证据 `.qa/harness-live-rk-rk-checkbox-1793875947589/report.json`。这是基础复选框任务通过，不能外推所有中文编辑与复杂任务都稳定。

## 当前使用版本

三个日常启动脚本已切换至 `release/harness-cua-0.14.0-20261105-r13/win-unpacked/Coloop.exe`。r13 的真实 RK 勾选（210.20 秒）与空白中文输入（256.09 秒）完整通过；同一编辑实现的局部中文修改在 r12 完整通过（329.54 秒）。r12→r13 只改控件进展计数，包内 diff 保留；各版本与历史失败不混记。最终验收汇总见 `.qa/reliability-r13-release.json`。

RK 20:22 复查：5 个相关服务 active/enabled，零失败/重启，Mem0 维护失败数 0，HID 可写，时差约 -0.3 秒。证据 `.qa/reliability-r12-board-health.json`。最终云审计仍为 12 次、100178 tokenUnits，无新增请求，见 `.qa/reliability-r13-cloud-usage-audit.json`。

r7、r1/r5/r6 与 TARS r60 回退包、TARS / OpenCode 兼容功能保留。此前已删除 r2/r3/r4 共 9,701,839,858 字节，清单见 `.qa/intermediate-build-cleanup-20261105.json`。本次 r8–r12 的逻辑大小共 16,169,918,778 字节，完成归档与无进程/启动引用预检后，删除被自动审批以 `blocked by policy` 拒绝，未给出更具体原因，原文件仍保留。随后完成可逆 NTFS 压缩，按 Windows 压缩大小统计，存储量降至 11,065,347,151 字节，减少约 5.10 GB；文件数量、逻辑大小及主 bundle/归档哈希均通过复核。r13 默认版和 r7 回退版未压缩。实际结果见 `.qa/reliability-r13-cleanup-result.json`，压缩证据见 `.qa/retired-build-compression-20261105.json`。全部测试证据保留。

板端实现、备份、部署路径详见 `D:/RK/docs/coloop-reliability-20261105.md`。主要证据在 `.qa/rk-reboot-validation-20261105.json`、`.qa/rk-maintenance-text-live-20261105.json`、`.qa/rk-memory-persistence-final-20261105.json` 与 `.qa/reliability-package-integrity.json`。
