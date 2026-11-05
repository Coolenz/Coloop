# Coloop 演进与验收报告（2026-11-06）

本轮依据实际 Harness 架构重写开发方向，补强费用与频率限制，复核 DSH 插件/记忆生态，并完整构建安装版。报告持续补入最终安装和 GitHub 结果；未列为通过的项目不视为完成。

## 改进与合并范围

- 费用保护开启却缺输入/输出单价时，发网前报 MODEL_PRICING_REQUIRED，避免“估算 0 元”的误导。
- 新增 maxCostYuanTotal，按同一 profile 的历史费用累计，跨任务、跨日与重启不重置；设置页可配置。
- 服务商 429/5xx 后持久化冷却，至少 30 秒并尊重更长 Retry-After。冷却期间其他任务、浏览器、压缩和咨询共享出口均被阻止，无新网络请求。
- 保留原有间隔、任务次数、日额度、输入/输出预算、无进展停止、单飞和中断预留。新增 6 项回归覆盖缺价、累计预算、服务端冷却和账本审计。
- 本轮发布包含工作区此前尚未发布的 Harness、Docling、Stagehand、CUA、任务恢复、自动连接与灵动岛改进；这些不是全在本轮新写。测试覆盖该最终源码整体。
- 清理代码格式；历史 UI 证据目录排除格式化，保留原始字节。CI 固定 Node 24.14.0，负责源码测试/格式/build；完整包依赖本机准备的离线模型、Node、CUA 等资源，不在缺少资源的 GitHub runner 上伪造 portable 包。

## 软件与包内验证

| 检查                 | 结果                                                                                         |
| -------------------- | -------------------------------------------------------------------------------------------- |
| 初始 Vitest 基线     | 66 文件，1198 通过，1 可选跳过                                                               |
| 最终 Vitest          | 66 文件，1204 通过，1 可选跳过                                                               |
| npm run build        | 两套 TypeScript 检查及 main/preload/renderer 构建通过                                        |
| npm run format:check | 通过；首次发现的格式问题已修复                                                               |
| Python               | 随包 Python 运行 187 项，成功，2 跳过；系统 Python 首次缺 numpy 失败，未将其算通过           |
| 开发目录外运行时     | 真实 Harness SDK 工具循环、Stagehand 中文网页填写/一次 POST、Docling 中文 DOCX/表格/缓存通过 |
| 首轮安装             | install-local.ps1 完整替换，148867 文件逐项哈希核对；实际安装路径 smoke 通过                 |

开发目录外运行时用真实 SDK、合成模型响应和独立浏览器，不消耗云模型，也不是自主业务验收。证据：`.qa/runtime-package-windows-no-credentials-1793901252996/report.json`、`.qa/proactive-package-1793901282522/report.json`、`.qa/evolution-install.json`、`.qa/proactive-package-1793901599174/report.json`。

## 真实模型与独立控件验收

所有案例使用实际安装路径、隔离测试窗口和生产 dispatchTask API；模型自行决定动作，driver 只核对结果。

| 路线/任务                   | 结果                                                  | 耗时      | 证据                                                                 |
| --------------------------- | ----------------------------------------------------- | --------- | -------------------------------------------------------------------- |
| 本地 Qwen → RK USB：勾选    | completed；checked=true，真实点击恰好一次；零云端调用 | 219.41 秒 | `.qa/harness-live-rk-rk-checkbox-1793901641860/report.json`          |
| DeepSeek → CUA 鼠标：勾选   | completed；独立状态与一次点击通过                     | 28.44 秒  | `.qa/harness-live-cloud-cua-checkbox-1793901886108/report.json`      |
| DeepSeek → RK：中文局部编辑 | completed；状态变为已完成，项目/备注/emoji 原样保留   | 38.35 秒  | `.qa/harness-live-cloud-rk-partial_editor-1793901969785/report.json` |

以上三例是首轮预算实现的实测；格式修复后的最终包另列复验，不把不同 main bundle 混称同一个包。

## 云端费用与停止策略

本轮共享 `.qa/evolution-live-profile`，从未重置账本。价格依据 DeepSeek 官方 Flash 高峰未命中输入 2 元/百万、输出 8 元/百万，不计缓存折扣。每任务 6 请求/1 元，每日 24 请求/3 元，累计 3 元；至少 5000 ms 间隔，无进展 4 次停止。真实测试开始余额 9.89 元，先查询可用余额再发模型请求。

首批 10 请求、74500 token units、按上述保守单价估算 0.156728 元。`evolution-cloud-audit.json` 显示账本和请求/回执一致，无重复/未知记录及违规。最终复验费用在后文更新。余额 API 查询不属于模型推理请求；实际扣费以服务商余额/账单为准。

## DSH 与记忆决策

已评估 Engram、Dream、Soul 及官方 checkpoint，见 [生态评估](dsh-ecosystem-20261106.md)。Engram 本地检索值得后续适配，但直接挂载的画像注入、23 个新工具和辅助模型会扩大隐私与成本边界。本轮不安装这些插件，不迁移/删除真实记忆，继续使用 RK worker 与宿主本地路由检查。未验证的第三方能力不算已经接入。

## 清理与边界

核对了 12 个旧 Coloop 桌面目录包，逻辑大小 19,936,842,254 字节，没有运行进程引用，清单在 `.qa/evolution-cleanup-candidates.json`。自动审批拒绝批量删除，返回 `blocked by policy`，未说明更具体原因；删除未执行。旧包、旧 APK 与安装回退备份仍保留，不声称磁盘只剩一个版本。RK 镜像含不同板型/系统形态，未擅自视为可互换而删除。

历史 26 业务场景仍为 5 完整通过、13 类似场景通过、7 部分完成、1 未执行；本轮不宣称全部解决。手机协议、真实 QQ 邮箱、真实会议两小时延迟、地图链接恢复和另一台干净 Windows 均未在本轮完整重验。有限控件任务通过不等于任意电脑任务可靠。

## 最终安装与复验结论

最终目录包为 `release/evolution-0.14.0-20261106-final/win-unpacked`，已用安装脚本完整部署到 `%LOCALAPPDATA%\Programs\Coloop`，148867 文件逐项哈希校验通过。main bundle SHA-256：`10b7e165d9fb485a385db4177f2939684a3a6dd66268621115129f644930ef6d`。旧 app.asar 不存在。

最终包的独立运行时与 UI 证据为 `.qa/runtime-package-windows-no-credentials-1793902409411/report.json`、`.qa/proactive-package-1793902436019/report.json`；实际安装路径 smoke 为 `.qa/proactive-package-1793902758893/report.json`。部署记录 `.qa/evolution-final-install.json`；脚本保留原安装备份 `Coloop-backup-20261106-021402`。

最终包真实 DeepSeek → RK 两例均通过：

- 中文局部修改，37.70 秒，5 次模型请求；正文精确为三行“项目：Coloop / 状态：已完成 / 备注：保留这一行 😀”。证据 `.qa/harness-live-cloud-rk-partial_editor-1793902809982/report.json`。
- 空白原生编辑框中文输入，28.40 秒，4 次模型请求；完整读回指定中文文本。证据 `.qa/harness-live-cloud-rk-blank_editor-1793902849123/report.json`。

本轮全部付费测试合计 **19 请求、19 回执、138501 token units**，未定价 0、重复编号 0、未结算 0；实测最小请求间隔 **5001 ms**。按高峰价、忽略缓存优惠的保守估算共 **0.292452 元**。余额接口首查 9.89 元、末查 9.87 元（余额显示精度及结算延迟不能当逐请求精确账单）；未接近用户 10 元额度。最终账本审计 `.qa/evolution-final-cloud-audit.json` 为 within_limits，无警告或违规；汇总 `.qa/evolution-final-cost-summary.json`。

日常生产配置也已启用费用/用量保护：间隔 5000 ms、单任务最多 16 请求/1 元，每日最多 64 请求/3 元，累计 3 元。累计限制属于本机 profile，不代表其他应用使用同一密钥也受限制。沿用当前 Flash 高峰价，未来更换模型必须重新配置单价。旧设置已在本机忽略目录备份，不上传。

生产配置保存核对：Harness runtime、无活动任务、原模型密钥保留，见 `.qa/evolution-production-verification.json`；设备就绪状态见文末独立启动核验。桌面快捷方式和全部 6 个 start*.cmd 均指向固定安装目录；已从 start.cmd 启动日常配置。未把测试 profile 混入用户数据。

GitHub 仅发布本轮最终源码快照到既有私有仓库 `Coolenz/Coloop`，沿用 `Coloop/` + `RK/` 布局；RK 源码未被本轮覆盖。包括此前未发布的 Coloop 源码与本轮改进，排除模型、发布包、测试 profile、密钥和运行日志。详细改动在本报告，提交说明同时列验证和限制。远端 CI 结果另行核对，不将本机通过冒充远端 CI 通过。

清理仍受阻：批量删除和一个明确路径旧包的删除均被自动审批以 `blocked by policy` 拒绝，未给更具体原因。没有绕过审批或删除其他数据，旧包仍在磁盘上。

启动状态补充：保存设置会短暂重连，`evolution-production-verification.json` 捕获到的是重连过渡态（deviceConnected=false），不能用该字段声称设备就绪。随后从统一 start.cmd 正常启动，使用当前新进程窗口的 Windows 可访问性树独立读取到“已连接”“qwen35-4b-rkllm”“已就绪”“工作区已就绪”。证据为 `.qa/evolution-unified-startup-verification.json`；最终安装路径进程已核对。生产配置核对前后均为 104 条任务，密钥密文完全一致。
