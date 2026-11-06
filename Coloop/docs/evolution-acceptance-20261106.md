# Coloop 演进与验收报告（2026-11-06）

更新状态：当前实际安装为 r7，实际安装路径验证及对应 GitHub CI 通过；r8 目录上下文修复已完成本机回归，等待安装与真实模型复验。原文件归档任务仍未通过，失败记录保留。用户已取消全部构建备份策略，代码历史使用 Git，缓存优先 D:\Coloop。C 盘清理净释放 25.31 GiB，D 盘已清理 20 个旧构建目标、净释放 6.80 GiB；旧段落的“备份保留/删除受阻”仅描述当时状态，最新证据见文末。

本轮依据实际 Harness 架构重写开发方向，补强费用与频率限制，复核 DSH 插件/记忆生态，并修复 Windows 路径、测试时钟与 ZIP 问题。下文保留 r3/r4/r5 等各轮交付记录；当前进展以上方状态和文末为准。本轮付费测试仍共 19 次，最小请求间隔 5001 ms，保守费用估算 0.292452 元；后续恢复验收只用本地模型。最新业务与 CI 尚未全部通过，整项目标不标记完成。

新目标见 [开发方向](development-direction.md)，插件与记忆取舍见 [生态评估](dsh-ecosystem-20261106.md)。当前安装包证据在文末；前面各轮失败和安装记录保留用于追溯。未列为通过的项目不视为完成。

| 目标              | 本轮状态                                                                |
| ----------------- | ----------------------------------------------------------------------- |
| G1 费用与频率保护 | 通过回归与共享账本实测；正式配置已启用限制                              |
| G2 安装版真实任务 | 已标注安装包的复选框、中文输入/局部编辑通过；不代表历史 26 场景全部通过 |
| G3 DSH 生态评估   | 完成；暂不挂载第三方插件或迁移真实记忆，理由与适配路线已记录            |
| G4 本机交付       | r7 完整安装及实际路径检查通过；r8 候选包待安装验收                      |
| G5 可复查交付     | r7 源码和 CI 通过；C 盘与旧 D 盘副本已清理，当前候选包待验收后删除      |

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

## 历史安装包（r4）

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

## r4 GitHub 与费用复核（历史记录）

[最终应用源码 1c0cdee](https://github.com/Coolenz/Coloop/commit/1c0cdeef2f75a46f5d98bb19e0d29b2ddcb45611) 的 [Windows CI](https://github.com/Coolenz/Coloop/actions/runs/42100050395) 已完成且为 success：67 个测试文件全部通过，1210 项通过、3 项可选跳过；format 和 build 通过。日志 `.qa/evolution-r4-github-ci.log` 与状态 `.qa/evolution-r4-github-ci.json` 已保存。本节属于随后补充的文档记录，不改变已测试的应用源码、依赖或安装包。

GitHub 发布保持既有 `Coloop/` + `RK/` 布局，逐项校验上传树与本机提交一致，非强制更新 main；RK 子树相对本轮开始未变。只交付 0.14.0 一个应用版本，保留 CI 修复提交历史，未上传发布包、模型、测试 profile、密钥或运行日志。原开发目录已有改动未被重置，发布工作在独立的 `D:\Coloop-GitHub` 完成。

正式启动后的最后一次只读账本审计 `.qa/evolution-r4-cloud-audit.json` 仍为 within_limits：19 请求、138501 token units，无警告或违规；与之前 19 回执、最小间隔 5001 ms、保守估算 0.292452 元的汇总一致。未通过更换 profile 或重启绕过本轮限制。

截至首轮交付，阻塞的已授权收尾动作是旧包删除：自动审批两次拒绝，理由均为 `blocked by policy`，没有更具体说明。当时旧包、APK 和安装备份仍在；没有绕过该拒绝，也没有将整项目标标记完成。恢复任务后的处理见下一节。

## 恢复任务后的清理（2026-11-06 上午）

恢复后重新核对：固定安装目录 main 哈希仍与 r4 一致，16 个旧桌面目录包仍在。对先前拒绝的 `release/aliyun-companion-0.12.0` 再次执行带路径与进程检查的删除，仍被自动审批以 `blocked by policy` 拒绝，命令未执行。没有改用其他工具删除这些被拒绝的目录。

Android 安装包属于独立清理项。核对 `release/android/latest.json` 及 0.6.0 验收记录，最新 APK 的 SHA-256 为 `6d31be70d92994a5d41d4452f3e13e91e0a1840b81de5a79f7d3412c885d4531`，与实际文件一致。已使用普通文件删除清除 0.1.0、0.2.0、0.3.0、0.4.0、0.5.0、0.5.1 六个旧 APK，共 **112696653 字节**；该发布目录只剩 **Coloop-Android-0.6.0-debug.apk**。删除后再次核对最新 APK 哈希通过，保留原验证记录。证据：`.qa/evolution-android-cleanup-preflight.json`、`.qa/evolution-android-cleanup-result.json`。

RK 烧录记录 `D:\RK\flash\flash-plan.json` 指定实际成功启动的镜像是 2026-07-02 LubanCat-4 Server，使用 loader 1.17.113。下载目录另有 4io/5/5-v2/5io、RK3576，以及 2026-10-17 generic 镜像和 loader 1.18.113；这些不能仅凭日期或版本号被认定为同一适用范围的替代品。本次未重新烧录、删除已验证镜像或清理这些尚未确认过时的固件。

恢复阶段未修改应用源码、未重新打包、未调用付费模型。安装版哈希核对通过；恢复检查时没有 Coloop 进程，前文“保持运行”描述的是首轮交付时的状态，不代表用户随后未退出应用。当前未完成项仍包括被拒绝的旧桌面目录包清理，不能宣称磁盘只剩最新版。

## 后续业务验收准备：隔离任务记忆

准备在 Harness 安装版执行“分类、停止、同一任务恢复、ZIP 交付”时，发现 `COLOOP_DATA_DIR` 原先只隔离宿主状态，主入口没有把隔离范围传给 RK 任务记忆桥。因此之前成功的测试任务可能进入 production 记忆队列；不能继续声称测试 profile 已自动隔离所有任务记忆。

新增修复为：正常启动保持 production；使用独立数据目录时，自动任务的记忆桥使用该目录规范路径摘要生成的稳定 `qa:profile:` 命名空间，执行器检索和记忆服务入队使用同一范围。不同 profile 分离，重启保持同一范围，不迁移、删除或重写原库。本次范围是自动任务的记忆通道，不是手动记忆管理界面的全库隔离。

新增两项回归核对范围稳定性、不同 profile 分离，以及检索执行器和写入服务的真实启动源码配置。源码全套 **1212 通过、3 可选跳过**，format、typecheck 和 build 通过；证据 `.qa/evolution-r5-tests.log`、`.qa/evolution-r5-memory-tests.log`、`.qa/evolution-r5-build.log`。r5 完整包已构建，正在开发目录外验证；尚未在本节声明安装或真实业务案例通过。

[隔离修复首轮 CI](https://github.com/Coolenz/Coloop/actions/runs/42156373622) 为 1211 通过、1 失败、3 跳过。失败位于既有 Stagehand 延迟 POST 测试：固定等待 1800 ms 后页面还未出现结果，独立核验拒绝通过。测试改为服务器等待明确释放信号，在确认动作 outcome=unknown 且 POST 计数为 1 后放行响应，再有界等待实际页面文字；不重试点击，不降低最终验证、POST=1 和模型调用=0 的判据。5 项 Stagehand 定向测试通过，证据 `.qa/evolution-r5-stagehand-tests.log`。此修复只修改测试，不改变 r5 应用包。

## 历史安装包（r5）

r5 已完整安装到固定路径，`install-local.ps1` 核对 148880 文件，保留备份 `Coloop-backup-20261106-112618`。安装前无 Coloop 进程，生产配置 104 条任务中无运行任务。实际安装 main SHA-256：`745e4c51b4e763b1d57da374d1863a62bb780667f80ce11c34a93438ce0f7588`，与暂存包一致；不存在旧 app.asar。此包替代前文 r4。

- 包外运行时通过：`.qa/runtime-package-windows-no-credentials-1793935490622/report.json`。
- 包外界面/恢复通过：`.qa/proactive-package-1793935533515/report.json`。
- 实际安装路径界面/恢复通过：`.qa/proactive-package-1793935922153/report.json`。
- 完整安装记录：`.qa/evolution-r5-install.json`。

新业务复验使用四份输入（同名不同内容、中文路径、PNG、空文件）与空目录，目标是在两份复制后正常停止，再用同一任务编号恢复并交付 ZIP。它是明确的小规模业务案例，不等同于历史 F08 的完整 12 文件验收。运行真实本地 RK 模型，云密钥为空，继续使用原测试 profile 与付费账本；本地任务最多 16 轮，付费账本与云端日/累计费用限制保持不变，测试结束恢复原 profile 配置。结果、独立 Python ZIP 读回和记忆队列审计待运行完成后补入。

r5 对应测试修复后的 [Windows CI](https://github.com/Coolenz/Coloop/actions/runs/42157292896) 已为 success，源码提交 `737f486e11257c93187521e088e8b5fb95795ace`。这证明软件回归通过，不代替下面的真实业务结果。

## 真实业务发现：新目录读取被误判为无进展

r5 首轮四文件案例失败，证据 `.qa/harness-workspace-resume-1793935949953/report.json`。模型依次观察桌面、启用文件工具、读取根目录和输入目录，随后被无进展保护阻止，尚未复制文件，也未到达计划的中断点。总耗时 209.61 秒；四轮真实本地模型响应耗时合计 192.44 秒（约 92%），不是文件复制或 ZIP 处理耗时。付费账本和付费日志逐字节未变；配置恢复，未增加云端调用。

根因是目录 `list` 未纳入任务的新证据统计。修复为：目录结果携带授权解析后的真实目录路径，按路径与有序条目内容记录进展；新目录或源文件摘要变化可以推进，重复相同目录（含路径别名）不会重置无进展计数。无进展、单任务、每日与累计预算上限未提高。另明确纯文件任务应直接启用文件工具处理目标路径，避免读取无关桌面。

新增三项回归验证首次产物前的新目录读取、路径别名重复读取仍停止、同目录源哈希变化被识别。全套 **1215 通过、3 可选跳过**，format、typecheck、build 通过；证据 `.qa/evolution-r6-tests.log`、`.qa/evolution-r6-progress-tests.log`、`.qa/evolution-r6-build.log`。r6 包正在准备。后续将沿原任务 `5c4c2dd3-652d-4c2d-9807-36a5f4372c99` 和原输入恢复，保留失败记录；不能提前宣称业务已通过。

## r6 安装及同任务恢复失败

r6 已通过完整安装脚本逐项核对 148880 文件；main SHA-256 为 `ad60607281c67852a476a11ee7c2d2f47a5e29d4951e7b06796cf09be7556c48`。实际安装路径 smoke 通过：`.qa/proactive-package-1793938555847/report.json`。安装记录 `.qa/evolution-r6-install.json`；该记录中的旧备份现已删除。

原任务在 r6 上恢复，四次本地模型请求共 265.58 秒，其中模型响应合计 255.26 秒。恢复后的文件工具组选择丢失，历史中的 `coloop_list` 被宿主拒绝为 HARNESS_TOOL_DENIED；模型因此请求用户确认已经明确的路径，案例按独立判据失败，尚未复制文件。证据 `.qa/harness-workspace-resume-1793951287038/report.json`，付费账本与日志逐字节未变。

最新已发布提交 `27934c54fbee1b7072f21c0290d168264372d26b` 的 [CI](https://github.com/Coolenz/Coloop/actions/runs/42159323066) 为 1214 通过、1 失败、3 跳过。Stagehand 延迟 POST 测试已通过；新失败在停止边界：宿主已取消，SDK 同时返回结构化错误时，终态被误报为 error。确定性回归在修复前复现该错误，见 `.qa/evolution-r7-abort-before.log`。

## r7 修复准备与缓存约定落地

宿主现在会在 SDK 返回后再次检查取消信号，取消时仍等待进程和工具工作结束。恢复任务时，在身份与未决效果检查通过后，只从已成功完成的宿主记录恢复工具组选择；不重放工具调用，不恢复旧观察、编辑读回或完成证明。新回归覆盖结构化错误与取消竞态、成功工具组顺序、失败切换排除、陈旧观察拒绝及非法组状态。

本机完整回归 **68 文件、1223 通过、3 可选跳过**，typecheck、build、format 通过；证据 `.qa/evolution-r7-tests.log`、`.qa/evolution-r7-build.log`、`.qa/evolution-r7-format.log`。191 项定向回归通过，5 项存储流程回归通过。受限沙箱曾明确返回回环网络 EACCES、PowerShell AuthorizationManager 和包内目录 EPERM；对应失败日志保留，使用系统审批后的同一验证通过，不把环境拒绝改记为源码通过。r7 完整包与真实业务复验尚待完成。

缓存和安装流程已调整：构建、测试、npm/pip/Electron 等可配置缓存放在项目内，默认暂存 `release/current`。安装仅同步当前安装目录并逐文件核对，不创建旧安装备份或 C 盘暂存副本；实际安装验收后清理本轮及历史构建包，源码版本由 Git 管理。完整规则见根目录 AGENTS.md，保护用户数据、密钥、记忆及累计费用账本。

系统审批通过后的 C 盘清理已完成：8 份旧安装备份、998 个测试临时目录、4 个下载缓存目录，共 1010 个目录，失败/跳过均为 0；净释放 25.31 GiB，完成时可用 44.09 GiB。当前安装主程序和用户状态文件哈希未变，Programs 下只剩当前 Coloop。证据 `.qa/c-drive-cleanup-result.json`。D 盘完整构建副本尚未在本节记作已清理。

## r7 安装、CI 与真实恢复结果

r7 已安装至固定目录，148880 个文件完整校验通过，不创建安装备份；main SHA-256 为 `0cfca01807aeda5860f7e0d5bcf6c31a28a969b2f9182acc922e60c39b831ff2`。实际安装路径启动检查 `.qa/proactive-package-1793954414941/report.json`、运行依赖检查 `.qa/runtime-package-windows-no-credentials-1793954414180/report.json` 均通过，Harness/Stagehand/Docling/ZIP 的依赖路径均在实际安装包内。后者是本地合成模型端点验收，不是模型自主业务通过。

[源码 da6b950](https://github.com/Coolenz/Coloop/commit/da6b95025038bda0944e8927f67e732d086eff77) 的 [Windows CI](https://github.com/Coolenz/Coloop/actions/runs/42188895738) 成功，68 个测试文件通过，format/build 通过；日志 `.qa/evolution-r7-github-ci.log`。

原任务在 r7 恢复，工具组恢复已生效，但本地模型误将授权路径末尾的 `workspace` 去掉，访问父目录被拒绝后又询问已明确的路径；按原判据失败，未复制文件。耗时 191.58 秒，两次本地请求，模型耗时 180.28 秒；付费账本及日志逐字节未变。证据 `.qa/harness-workspace-resume-1793954540941/report.json`。不将拒绝越权本身记为业务通过。

## r8 授权目录上下文改进

恢复输入现在明确携带已保存的授权根目录、相对路径基准和父目录禁止标记；本地模型指令明确 `.` 指向授权根目录。越界错误仍拒绝原调用，同时返回正确根目录，帮助模型纠正位置。未扩大目录权限，也未替模型执行复制或压缩。

新增回归使用不同的运行状态目录与任务子目录，验证恢复输入绑定任务目录、绝对父目录和 `..` 均被拒绝、`.` 只读到授权文件，并且列目录不会取得完成证据。全套 68 文件、1224 项通过、3 可选跳过，build/typecheck/format 通过。新包及真实模型复验仍在进行；证据 `.qa/evolution-r8-tests.log`、`.qa/evolution-r8-build.log`、`.qa/evolution-r8-format.log`。

D 盘已清除 19 个旧 release 目录或手动删除后的残留，以及项目外的 r6 验证副本，共 20 个目标；逻辑文件大小 6808644170 字节，净释放 7299698688 字节。当前安装主程序和真实用户状态哈希不变。证据 `.qa/evolution-r7-d-cleanup-result.json`。本轮正在验证的 `release/current` 尚保留，必须在最终实际安装验收后删除，不能作为最新备份留存。
