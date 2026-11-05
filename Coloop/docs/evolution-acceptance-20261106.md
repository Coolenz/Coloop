# Coloop 演进与验收报告（2026-11-06）

本轮依据实际 Harness 架构重写开发方向，补强费用与频率限制，复核 DSH 插件/记忆生态，并修复干净 Windows CI 暴露的路径、测试时钟与 ZIP 问题。**0.14.0 r4 已完整安装并从统一入口启动，RK 与本地 Qwen 就绪；本机 1210 项测试通过、3 项可选跳过。** 本轮付费测试共 19 次，最小请求间隔 5001 ms，保守费用估算 0.292452 元。旧包删除被自动审批阻止，尚未达到“磁盘只留最新版”；r4 GitHub CI 结果待远端复验，不提前记为通过。

新目标见 [开发方向](development-direction.md)，插件与记忆取舍见 [生态评估](dsh-ecosystem-20261106.md)。当前安装包证据在文末；前面各轮失败和安装记录保留用于追溯。未列为通过的项目不视为完成。

## 改进与合并范围

- 费用保护开启却缺输入/输出单价时，发网前报 MODEL_PRICING_REQUIRED，避免“估算 0 元”的误导。
- 新增 maxCostYuanTotal，按同一 profile 的历史费用累计，跨任务、跨日与重启不重置；设置页可配置。
- 服务商 429/5xx 后持久化冷却，至少 30 秒并尊重更长 Retry-After。冷却期间其他任务、浏览器、压缩和咨询共享出口均被阻止，无新网络请求。
- 保留原有间隔、任务次数、日额度、输入/输出预算、无进展停止、单飞和中断预留。新增 6 项回归覆盖缺价、累计预算、服务端冷却和账本审计。
- 本轮发布包含工作区此前尚未发布的 Harness、Docling、Stagehand、CUA、任务恢复、自动连接与灵动岛改进；这些不是全在本轮新写。测试覆盖该最终源码整体。
- 清理代码格式；历史 UI 证据目录排除格式化，保留原始字节。CI 固定 Node 24.14.0，负责源码测试/格式/build；完整包依赖本机准备的离线模型、Node、CUA 等资源，不在缺少资源的 GitHub runner 上伪造 portable 包。
- 修复 Windows 工作区绝对路径别名的恢复：先解析真实路径，再检查目录授权；相对越界、目录链接逃逸仍拒绝，覆盖已存在文件与尚不存在输出的祖先路径。
- 修复空闲灵动岛提示：依据真实 RK 设备状态显示“RK 已连接 · 等待任务”，不再把观察服务的连接状态当作设备断开。

## 软件与包内验证

| 检查                 | 结果                                                                                         |
| -------------------- | -------------------------------------------------------------------------------------------- |
| 初始 Vitest 基线     | 66 文件，1198 通过，1 可选跳过                                                               |
| 首次本机 Vitest      | 66 文件，1204 通过，1 可选跳过                                                               |
| CI 修复后 Vitest     | 66 文件，1203 通过，3 可选跳过；CI 并发模式，含新增路径别名/越界回归                         |
| 本机 Office 定向验收 | COLOOP_OFFICE_REAL=1；30 通过、1 Docling 可选跳过，包含真实 WPS 文档/表格/PDF 与 ZIP         |
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

## 首轮安装与模型复验记录

首轮发布前的目录包为 `release/evolution-0.14.0-20261106-final/win-unpacked`，已用安装脚本完整部署到 `%LOCALAPPDATA%\Programs\Coloop`，148867 文件逐项哈希校验通过。其 main bundle SHA-256：`10b7e165d9fb485a385db4177f2939684a3a6dd66268621115129f644930ef6d`。后续 CI 修复包另列于文末，不把前一包的模型实测冒充修复包实测。

该包的独立运行时与 UI 证据为 `.qa/runtime-package-windows-no-credentials-1793902409411/report.json`、`.qa/proactive-package-1793902436019/report.json`；实际安装路径 smoke 为 `.qa/proactive-package-1793902758893/report.json`。部署记录 `.qa/evolution-final-install.json`；脚本保留原安装备份 `Coloop-backup-20261106-021402`。

该包真实 DeepSeek → RK 两例均通过：

- 中文局部修改，37.70 秒，5 次模型请求；正文精确为三行“项目：Coloop / 状态：已完成 / 备注：保留这一行 😀”。证据 `.qa/harness-live-cloud-rk-partial_editor-1793902809982/report.json`。
- 空白原生编辑框中文输入，28.40 秒，4 次模型请求；完整读回指定中文文本。证据 `.qa/harness-live-cloud-rk-blank_editor-1793902849123/report.json`。

本轮全部付费测试合计 **19 请求、19 回执、138501 token units**，未定价 0、重复编号 0、未结算 0；实测最小请求间隔 **5001 ms**。按高峰价、忽略缓存优惠的保守估算共 **0.292452 元**。余额接口首查 9.89 元、末查 9.87 元（余额显示精度及结算延迟不能当逐请求精确账单）；未接近用户 10 元额度。最终账本审计 `.qa/evolution-final-cloud-audit.json` 为 within_limits，无警告或违规；汇总 `.qa/evolution-final-cost-summary.json`。

日常生产配置也已启用费用/用量保护：间隔 5000 ms、单任务最多 16 请求/1 元，每日最多 64 请求/3 元，累计 3 元。累计限制属于本机 profile，不代表其他应用使用同一密钥也受限制。沿用当前 Flash 高峰价，未来更换模型必须重新配置单价。旧设置已在本机忽略目录备份，不上传。

生产配置保存核对：Harness runtime、无活动任务、原模型密钥保留，见 `.qa/evolution-production-verification.json`；设备就绪状态见文末独立启动核验。桌面快捷方式和全部 6 个 start*.cmd 均指向固定安装目录；已从 start.cmd 启动日常配置。未把测试 profile 混入用户数据。

GitHub 仅发布本轮最终源码快照到既有私有仓库 `Coolenz/Coloop`，沿用 `Coloop/` + `RK/` 布局；RK 源码未被本轮覆盖。包括此前未发布的 Coloop 源码与本轮改进，排除模型、发布包、测试 profile、密钥和运行日志。详细改动在本报告，提交说明同时列验证和限制。远端 CI 结果另行核对，不将本机通过冒充远端 CI 通过。

清理仍受阻：批量删除和一个明确路径旧包的删除均被自动审批以 `blocked by policy` 拒绝，未给更具体原因。没有绕过审批或删除其他数据，旧包仍在磁盘上。

启动状态补充：保存设置会短暂重连，`evolution-production-verification.json` 捕获到的是重连过渡态（deviceConnected=false），不能用该字段声称设备就绪。随后从统一 start.cmd 正常启动，使用当前新进程窗口的 Windows 可访问性树独立读取到“已连接”“qwen35-4b-rkllm”“已就绪”“工作区已就绪”。证据为 `.qa/evolution-unified-startup-verification.json`；最终安装路径进程已核对。生产配置核对前后均为 104 条任务，密钥密文完全一致。

## GitHub CI 发现与修复

[首次源码发布](https://github.com/Coolenz/Coloop/commit/622f3c6bd91f52c860c9a2362a017872155c402b) 的 [干净 Windows runner 验证](https://github.com/Coolenz/Coloop/actions/runs/42084847961) 失败：7 项失败、1197 项通过、1 跳过。原因包括 runner 临时目录的 RUNNER~1 短路径与 canonical 长路径不一致、全并发下 PowerShell ZIP 启动超时，以及 runner 没有 WPS。没有把这些失败改记为通过。

修复后，工作区绝对路径别名会在真实路径解析后核对授权，新增恢复/创建/越界回归；测试期望使用 canonical fixture 路径。CI 并发限制为 2，ZIP 超时上限为 60 秒。WPS 集成测试改为显式 `COLOOP_OFFICE_REAL=1`，在有 WPS 的本机实际执行通过；干净 runner 不假装具有 Office。

对应证据：`.qa/evolution-r2-tests.log` 与最终源码 `.qa/evolution-r3-tests.log`（均为 1203 通过、3 可选跳过）、`.qa/evolution-path-office-tests.log`（30 通过、1 可选跳过）、`.qa/evolution-r3-build.log`。只交付同一 0.14.0 版本；针对远端发现的问题追加修复提交，保留真实历史。修复提交的远端结果以 [GitHub Actions](https://github.com/Coolenz/Coloop/actions/workflows/ci.yml) 对应提交为准。

## 上一轮安装与模型复验（r3）

上一轮部署的来源为 `release/evolution-0.14.0-20261106-r3/win-unpacked`，现已由文末 r4 替换。安装前核对 104 条任务、无运行任务，从 File → Exit 正常退出；`install-local.ps1` 完整部署并逐项校验 **148867** 个文件，备份为 `Coloop-backup-20261106-025734`。该轮实际安装的 main SHA-256 为 `aaad28077b0e8fa3fa3f4e3d4bb96d7b9afbfadfd2f73c9ec708e9e924e6ea3e`，与暂存包一致；不存在旧 `resources/app.asar`。

- 开发目录之外的独立运行时通过：`.qa/runtime-package-windows-no-credentials-1793904994590/report.json`。官方 Harness 工具循环、Stagehand 实际页面读写、Docling 中文解析均在包内依赖运行。
- 开发目录外界面/恢复 smoke 通过：`.qa/proactive-package-1793905026376/report.json`。
- 实际安装路径 smoke 通过：`.qa/proactive-package-1793905372785/report.json`。
- 安装记录：`.qa/evolution-r3-install.json`。最终源码全套测试与 build 通过；单独 Office 验收未跳过本机 WPS。
- 生产配置连续三次快照核对设备 connected、Qwen ready、Harness 空闲、灵动岛“RK 已连接 · 等待任务”。104 条历史任务、原密钥密文和完整费用配置保持不变；`.qa/evolution-r3-production-verification.json`。此检查只读，不派发任务或请求付费模型。
- 最终安装包追加真实本地 Qwen → RK 复选框验收：**212.96 秒，completed，checked=true，click_count=1**；`.qa/harness-live-rk-rk-checkbox-1793905431704/report.json`。沿用同一测试 profile，云端密钥为空，不开放付费调用；重新审计账本仍 within_limits，无新云模型请求。此耗时说明本地推理仍有明显性能限制，不能按云端路线的响应速度承诺。
- 最后从 `D:\Coloop\start.cmd` 启动日常配置，以新进程的 Windows 可访问性树再次核对主窗口已连接/Qwen 已就绪、灵动岛“RK 已连接 · 等待任务”和 104 条历史任务。证据 `.qa/evolution-r3-unified-startup-verification.json`；安装版保留运行，测试实例已退出。

清理限制仍有效：此前清单只统计当时的 12 个旧包；继续构建产生的暂存目录也保留。r4 安装后 `release` 中有 17 个桌面目录包（含当前 r4），另有 android 目录，没有达到“磁盘只保留最新版本”。不能把安装脚本保留备份视为已清理。

远端复验补充：[第二轮 CI](https://github.com/Coolenz/Coloop/actions/runs/42091137858) 为 1201 通过、2 失败、3 跳过；路径与 WPS 问题已消失，ZIP 超时仍在，另暴露协调器测试把磁盘读取也压入 15 ms 实时时限的问题。协调器单测改用受控时钟，保留超时、未结束请求占位和迟到回复拒绝判据；ZIP 测试追加不含请求内容的进程/管道阶段日志继续定位。未把第二轮远端 CI 记作通过。这些测试/报告改动不改变已部署 r3 应用包。

## ZIP 运行时修复

[第三轮 CI](https://github.com/Coolenz/Coloop/actions/runs/42093950210) 为 1202 通过、1 失败、3 跳过。协调器时钟测试通过；ZIP 的阶段日志显示源目录与源文件已准备好，PowerShell 工作进程已创建，但未收到输出或退出事件。只定位到这个进程边界，未声称已证明 Windows 内部卡住的具体原因。

ZIP 已改为宿主 Node 流式生成与独立读回，固定 [yazl 3.3.1](https://github.com/thejoshwolfe/yazl) 和 [yauzl 3.4.0](https://github.com/thejoshwolfe/yauzl)，不再启动 PowerShell。保留工作区授权、路径/链接限制、源哈希核对、原子发布、500 项限制、100 MB 产物上限和取消处理；按文件顺序读流，避免把整个归档放进内存。Office 与 PDF 工具不因 ZIP 改动而取消其原有运行时。

新增 7 项 ZIP 回归覆盖 Unicode/emoji、空文件与空目录、源文件等长替换/增长、读回哈希与项数不符、路径穿越/重名、目标已存在以及取消后的句柄释放。新源码全套 **67 文件、1210 通过、3 可选跳过**，typecheck、build、format 通过；证据 `.qa/evolution-r4-tests.log`、`.qa/evolution-r4-build.log`。包内验证新增真实 ZIP 归档与读回，同时断言 yazl/yauzl 从包内加载。

## 当前最终安装包（r4）

最终来源为 `release/evolution-0.14.0-20261106-r4/win-unpacked`。旧应用通过 File → Exit 正常退出，无活动任务；`install-local.ps1` 部署完整目录到 `%LOCALAPPDATA%\Programs\Coloop`，逐项校验 **148880 个文件**。安装记录 `.qa/evolution-r4-install.json`，回退备份 `Coloop-backup-20261106-035611`，用户数据未删除。

实际安装 main SHA-256 为 `690d8e16f87cc2728f78846028337f7c87da36d3ebe51df1a4ab6ed37e4d2fee`，与已验证暂存包一致；不存在旧 `resources/app.asar`。afterPack 补齐并校验生产依赖与必要 peerDependencies，完整包含离线运行资源。

| 验证                  | 结果与本机证据                                                                                                                                           |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 开发目录外运行时      | 通过；`.qa/runtime-package-windows-no-credentials-1793908515409/report.json`                                                                             |
| 开发目录外界面/恢复   | 通过；`.qa/proactive-package-1793908547264/report.json`                                                                                                  |
| 实际安装路径界面/恢复 | 通过；`.qa/proactive-package-1793908930955/report.json`                                                                                                  |
| 实际安装路径运行时    | 通过；`.qa/runtime-package-windows-no-credentials-1793908930661/report.json`；Harness、Stagehand、Docling、ZIP 均从包内加载                              |
| 生产配置              | 连续三次快照通过；104 条任务、原密钥与费用配置保留，RK connected / Qwen ready / Harness idle；`.qa/evolution-r4-production-verification.json`            |
| 统一入口启动          | 从 `D:\Coloop\start.cmd` 启动，Windows 可访问性独立核对设备/模型就绪及灵动岛“RK 已连接 · 等待任务”；`.qa/evolution-r4-unified-startup-verification.json` |

r4 增加 ZIP 运行时依赖与实现，Harness 推理路线和费用保护未变。上文真实模型任务属于其各自标注的安装包；r4 的包内测试使用合成模型响应，不把它冒充新增自主模型任务。为控制费用，没有重复付费验收，累计仍为 19 次。正式安装版保持运行，隔离测试实例已退出。
