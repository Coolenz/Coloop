# Coloop

2026-11-06 **统一安装版**：桌面快捷方式和所有 `start*.cmd` 统一启动 `%LOCALAPPDATA%\Programs\Coloop\Coloop.exe`。本轮包含灵动岛关闭、内容/按钮/窗口过渡与减少动态效果支持。以后应用修改验证通过后直接更新该安装目录，保留用户数据和旧安装备份；完整部署流程与长期约定见 [AGENTS.md](AGENTS.md)，替换工具为 `scripts/install-local.ps1`。下面版本路径均为历史记录，不再决定当前入口。

2026-11-05 **0.14.0 架构更新**：主 Agent 默认迁移至官方 DeepSeek Harness，接入 Docling 文档理解、Stagehand 受控网页交互和显式任务恢复。当前入口及构建方式见 [架构迁移说明](docs/harness-migration.md)。下面保留早期版本记录，当前启动路径以迁移说明及 `start.cmd` 为准。

2026-11-05：RK 时钟、Mem0 维护、模型/记忆自启动、USB HID 启动恢复和网络等待已修复并通过真实重启。CUA 真实点击、双击、滚动及回执去重分层验收见 [可靠性修复记录](docs/rk-reliability-20261105.md)；本轮云测试共用固定预算账本，保留失败证据。

2026-11-05 本地可靠性更新：日常启动入口已切到 **r13**。修复 RichEdit 中文多行与真实全选索引、精确读取后才开放修改、工具封装有限重生成及控件进展计数。1195 项回归通过；真实 RK 中文局部修改、空白输入、勾选均有完整成功记录，版本与耗时见 [本地 Agent 验收](docs/local-agent-reliability-20261105.md)。本地 4B 仍有分钟级延迟，旧失败证据与兼容入口保留。

2026-11-03 灵动岛玻璃版：液态玻璃视觉、默认收起、悬停展开、移开350ms收起；拖动左侧手柄可移动，状态刷新保留位置。输入时保持展开，减号手动收起保留草稿，运行中收起仍保留Stop。默认入口为 `release/proactive-glass-0.13.0-20261103-r4/win-unpacked/Coloop.exe`。

2026-11-03 灵动岛直接命令输入：顶部常驻胶囊直接显示“让 Coloop 做什么？”输入框，Enter或发送箭头创建任务，中文输入法选词不提交；提交失败保留草稿，后台刷新不抢走输入焦点，执行中禁用新命令。两个默认入口已更新到 `release/proactive-command-0.13.0-20261103/win-unpacked/Coloop.exe`。

2026-11-03 顶部灵动岛常驻修正：默认 `start.cmd` 与 `start-proactive.cmd` 统一启动 `release/proactive-resident-0.13.0-20261103/win-unpacked/Coloop.exe`，空闲、RK未连接及主窗口收起到托盘时均显示；意外隐藏后自动恢复。已将用户实际运行的旧 `rk-agent-state` 进程切换为该版，并用实际 Windows 窗口验证顶部胶囊及主窗收起后可见。

2026-11-03 **新增六类真实动作覆盖，分两轮验收**：suite01通过两个中文字段分别替换；修复非paste计划空text兼容后，suite02通过复选框单击、列表双击、仅悬停、真实滚轮到底、替换/撤销/重做，独立原生状态与事件均通过。两轮共30次真实云调用、0次本地模型调用、剪贴板均恢复；首轮五失败保留，不称单次6/6。撤销重做需7组12动作多轮纠正，业务通过但记忆未保存。603项Vitest、60项RK Python、新包资源哈希和隔离启动smoke通过；`start-proactive.cmd`已指向`release/proactive-actions-0.13.0-20261103/`，旧cloud-direct包保留回退。先从托盘退出旧版再启动，详见[动作任务集与实测](docs/action-taskset.md)。

2026-11-03 首次direct历史：**云端直接动作路线真实闭环通过**，仅1次classify（3.439秒）、0次translate，2组云端动作、9次云调用。两任务15.656/22.064秒含复盘记忆，真实中文追加、tag目录/正文调用及两次剪贴板恢复通过。当时601项Vitest、58项RK Python、build及包smoke通过，历史包`release/proactive-cloud-direct-0.13.0-20261103/`资源与live源码哈希一致，现保留回退，当前入口以本页顶部actions版本为准。范围为独立WinForms真实窗口/非合成观察，不是Notepad写入、跨应用或物理手机验收；与旧live09的40.380/76.398秒不作严格性能对比。详见[主动建议与RK执行](docs/proactive-agent.md)。

2026-11-03 旧路线历史：**主动建议→真实RK USB中文写入→Mem0 tag回忆已在独立WinForms文档通过live09验收**，当时包含Qwen动作转换；第二任务按tag检索并读取记忆后追加“记忆已调用”，两次剪贴板恢复，10次真实云调用。任务约40.380/76.398秒（含复盘），本地转换25–27秒是本次移除环节的依据。上轮601项Vitest、54项RK Python及隔离打包smoke通过。首次切换仍须从托盘退出旧Coloop再运行独立入口。这不是实际记事本写入、跨应用或物理手机验收，详见[主动建议与RK执行](docs/proactive-agent.md)。

2026-11-03 早期分层与失败记录保留：数字门控单样本3.457秒，text_ref动作转换17.438秒、冻结真实观察24.864秒，不作固定提速承诺；实际记事本Document零输入观察/守卫、临时剪贴板3场景通过。live05云JSON解析失败、live08本地invalid_action且0USB均不被live09成功覆盖，详见同一专题。

2026-11-02 RK Agent状态与回执继续完善：输入前原子落盘、输入结果未知停止、同阶段不重放、受限云动作校验、首页独立Mem0记忆及近期执行上下文已接入。`start-cloud-hid.cmd` 当前启动 `rk-agent-state-0.13.0-20261102`，「电脑操作」可选择RK Agent模式。真实RK/云端/Mem0/USB在独立实验窗通过，最终协议耗时11.368秒；这是合成观察＋真实硬件验收，没有新测完整B站任务。说明及证据见 [RK Agent](docs/rk-agent-gateway.md)。

2026-11-02 云端USB试验的 **Agent已迁到RK Linux**：上下文、云指令校验、当前控件绑定、Mem0读写及USB同在板端；上位机保留联网转发、云Key和Windows观察/守卫。当前 `start-cloud-hid.cmd` 使用 `rk-agent-gateway-0.13.0-20261102`。真实三连闭环65.415秒，3次云请求、10次USB点击，三态核验和独立记忆读回通过；此轮没有获得提速。具体分工、原始证据与限制见 [RK Agent / 联网网关](docs/rk-agent-gateway.md)。

2026-11-01 云端Agent优化已实测：借鉴UFO²/Browser-use的语义步骤与实时控件绑定，完整鼠标三连 **32.309秒**（前轮42.912秒），真实云请求14→3次，输入token16,278→2,376；10次RK USB动作、20守卫和三态核验保留。云复盘回写RK，入口 `start-cloud-hid.cmd` 启动agent独立构建。实现、开源选型及限制见 [云端Agent说明](docs/cloud-ui-agent.md)，本轮没有直接引入第三方框架SDK。

2026-11-01 新增独立[云端规划 / RK USB 转达试验](docs/cloud-hid-relay.md)：运行 `start-cloud-hid.cmd`，现有手机任务消息发送“打开 Bilibili”。真实云端、RK、USB、Chrome与复盘闭环已通过；本轮物理手机传输未实测。

2026-11-01 **Android 0.6.0 任务流程补齐**：最近任务可筛选并定位原对话；当前任务可查看进度、关联原目标补充；结果可填回草稿再编辑，替换未发送草稿需确认；连接阻断提供就地恢复，核对回执防止误重发。APK：`release/android/Coloop-Android-0.6.0-debug.apk`，电脑端继续沿用0.13.0；原生验收模型/HID为模拟，见 [Android说明](docs/android.md)。

2026-11-01 **Android 0.5.1 交互优化**：超长消息保留全文并提示长度限制；任务选项点击完成才应用，取消/返回可撤销未应用编辑，选项超限有明确提示；修复离线状态下的缓存连接动画。APK：`release/android/Coloop-Android-0.5.1-debug.apk`，可覆盖旧版保留配对，电脑端沿用 0.13.0。见 [Android 说明](docs/android.md)。

2026-10-31 **Android 0.5.0 设计细化版**：保持直接进入 Coloop 聊天，细化消息层级、长按选择/复制、回到最新消息和可移除的任务选项。配对改为分步引导，连接设置区分暂停和离线；修复横屏键盘布局，以及后台刷新后重开 App 选错电脑。安装包：`release/android/Coloop-Android-0.5.0-debug.apk`，可覆盖同签名旧版并保留配对。电脑端继续使用 0.13.0；本轮界面验收使用真实 Android 模拟器和加密通道，RK/HID 为明确的模拟数据，未把历史硬件联调算作 0.5.0 新实测。详情见 [Android 交付说明](docs/android.md)。

2026-10-31 **Coloop 安卓聊天新版**：Android 0.4.0 直接进入聊天，顶部显示电脑/RK状态，发送失败会说明原因并保留草稿。电脑端 0.13.0 保存 Windows 加密的设备凭据，启动和掉线后自动连接；本机新版与固定手机服务器已上线，真实 SSH 重启及断线恢复通过。APK 为 `release/android/Coloop-Android-0.4.0-debug.apk`，统一启动使用 `start.cmd` / `start-mobile.cmd`。模型锁占用自行释放后，真实聊天、RK本地路由、USB输入/点击、安卓回执和停止已通过9项回归；下面0.3.0实测保留为历史证据。使用与验收范围见 [Android 新版](docs/android.md)。

2026-10-31 **Violoop 真实 RK 联调已通过**：现有 Android 0.3.0 经公网 HTTPS/AES-GCM 发送任务，真实 Qwen3.5-4B 解析并选择本地规划，通过 RK USB HID 输入屏幕上的随机数字并点击一次确认，Windows 独立记录与安卓结果均核对通过。一次动作组、两次完整观察；手机停止真实解析任务也通过。本轮修复 HID 接口适配、模型抄错长标题与本地规划误经文字回答通道三处问题。`start-violoop.cmd` 现在优先启动实测构建；云端分支、跨应用及 QQ 邮箱中文邮件仍未验收。详情见 [实机联调](docs/violoop-rk-live.md)。

2026-10-31 新增 **手机 → Violoop → RK 电脑任务入口**：Android 0.3.0 可发任务消息、查看独立任务状态、补充信息和停止；RK 使用桌面专用策略选择本地或云端协作，继续经过既有隐私检查。任务编号持久去重，断线或重启不自动重放。当前执行范围仍是已打开的单窗口与 ASCII 输入，QQ 邮箱跨应用及中文邮件完整流程尚未实现；本轮模拟器验收使用明确的模拟 RK/HID，不能替代实机验收。配套独立入口为 `start-violoop.cmd`，详见 [Violoop 手机任务](docs/violoop-mobile.md)。

2026-10-30 按用户要求**暂不启用系统防截屏**：主窗口、私密填写及登录窗口均可在远程画面中显示，去掉必须在电脑本机填写的提示。私密填写继续使用独立隔离窗口，记忆管理期间仍暂停 Coloop 自身截图/OCR/模型与控制。当前 `start.cmd` 优先使用 `release/remote-visible-20261030/win-unpacked/Coloop.exe`；下述旧构建的防截屏行为仅为历史记录。

2026-10-30 修复**点击记忆后整窗消失**：原实现给整个主窗口启用系统防截屏，导致捕获式远程桌面和截图看不到窗口，而页面与进程仍然正常。现在记忆目录及普通编辑保持主窗口可见，私密账号密码移至独立隔离、防截屏的填写窗口，主界面提供关闭入口与说明；私密登录窗口继续防截屏。记忆页仍暂停本应用截图/OCR/模型与控制。当前 `start.cmd` 优先使用 `release/memory-visibility-20261030/win-unpacked/Coloop.exe`；切换须先退出旧进程。508项单元测试通过，打包版记忆窗口6项与通用桌面9项通过，本轮没有重跑板端保存或USB输入。详见 [私密记忆](docs/private-credentials.md)。

2026-10-30 修复**后台仍在但主窗口打不开**：关闭到托盘后，再次启动会显示并聚焦已有窗口；最小化窗口会恢复，页面进程已退出时会在重新打开时重新加载。`start.cmd` 优先使用 `release/window-recovery-20261030/win-unpacked/Coloop.exe`。首次切换须从托盘退出旧进程，再打开新版。页面进程退出的最近一次时间、版本、原因与退出码保存在 `%APPDATA%\coloop\window-diagnostic.json`，不记录页面正文。打包版窗口生命周期3项、通用桌面9项检查通过；这不证明用户此前每次窗口消失均由同一原因引起。

新增 **Android 原生手机端与异网控制**：安卓 App 可扫码/粘贴配对、查看电脑会话和净化进度、追加要求、查看回执、停止与明确恢复、更新远程地址和解绑。电脑通过独立的加密网关和临时公网隧道主动连接，不要求用户自建服务器。APK 为 `release/android/Coloop-Android-0.1.0-debug.apk`，配套上位机为 `release/android-companion-0.12.0/win-unpacked/Coloop.exe`，`start.cmd` 优先使用它。先退出托盘中的旧版再启动。临时地址会变化，当前验收为 Android 模拟器经真实公网 HTTPS，尚非运营商流量实机测试；使用步骤与边界见 [Android 首版](docs/android.md)，交付摘要见 `release/android/verification.json`。

真实 **DeepSeek API** 已完成独立推理题和 RK 协作验证：装箱42余1、两工位最短工期8，以及源条件逐字保留的RK→DeepSeek→RK链路。该专题冻结构建为 `release/deepseek-validated-0.12.0/win-unpacked/Coloop.exe`，可直接运行；先从托盘退出旧版再启动。本次修正云端推理预算、RK摘录式资料选择及已运行默认4B的protocol 3适配；未覆盖安装版或改写保存的账户配置。[真实验证与失败记录](../RK/docs/22-deepseek-cloud-validation.md)。

2026-10-30 新增 **统一记忆管理**：在单一「记忆」入口共同搜索、分类、新建和删除普通记忆与私密引用，普通内容可编辑并保留历史；私密账号密码精确保存在板端受保护后端，Mem0只索引位置和编号，模型不能读取正文。专用同源 HTTPS 窗口校验目标后经真实 USB HID 填入，记忆管理和登录期间暂停 Coloop 截图/OCR/模型任务。独立程序为 `release/memory-20261030165137/win-unpacked/Coloop.exe`；先退出旧版再启动，现有安装版不自动替换。首版凭据限每字段64个ASCII字符，不自动提交登录，非任意公网网站验收；[使用、部署与证据](docs/private-credentials.md)。

Coloop 的开发定位是以 RK 设备为执行端的电脑操作 AI：观察屏幕、规划动作、通过键鼠执行，再回读结果。复杂任务可调用云端模型，RK 承担本地控制与执行。

**电脑操作首版**：开发源码已接入 RK 任务循环、真实 USB HID、顶部停止与结果回读。同页任务一次规划、连续执行整组动作，结束后统一 OCR 验证；随机数字输入与确认实机样例完成于 1 次规划、2 次完整观察。当前限单屏、单窗口和 ASCII 输入，后续扩展跨应用。使用、实际数据和失败记录见 [电脑操作与批量执行](docs/desktop-operation.md)，整体路线见 [开发方向](docs/development-direction.md)。

新增 **电脑会话控制与顶部提示窗**：在「Agent 协调」中预览屏幕顶部的小窗；接入 Windows OpenCode 1.19.5 后，可向空闲会话发送要求并中断由 Coloop 发起的执行。提示先显示再派发，停止等待源端确认，结果不明时保留提示；主窗口关闭后驻留托盘。会话目录、命令去重账本和回执由桌面与安卓端复用，自动续推仍待后续接入。配置与边界见 [电脑会话控制](docs/session-control.md)。

会话控制专题构建为 `release/session-control/win-unpacked/Coloop.exe`，portable 为 `release/session-control/Coloop-0.11.0-Windows-x64.exe`，可直接运行。已有旧版正在运行时，先退出旧版，再启动。Windows OpenCode 原生收发、中断、同会话恢复均已验收，模型响应使用本机合成数据。

新增 **RK + 云端隐私协作**：RK 先判断复杂度；复杂任务只将复核后的必要脱敏摘要交云端 Agent，云端返回短 JSON，再由 RK 结合本地资料回答。凭据移除且不回填，个人／业务实体映射只在本地。默认处理本次问题与附加文本，不拼入历史或 Mem0。源码与实际验收、已安装版本分别记录，详见 [协作策略与边界](docs/cloud-cooperation.md)。

本次协作独立构建为 `release/0.11.0/Coloop-0.11.0-Windows-x64.exe`，unpacked 为 `release/0.11.0/win-unpacked/Coloop.exe`。真实 RK＋HTTP 云协议 fixture 两题闭环通过；没有测试付费云账户，也未替换已安装程序。`start.cmd` 同时保留并行会话控制构建的优先入口；需要本次已绑定 SHA 的协作构建时直接运行上述文件。先退出已运行旧版，避免单实例机制只切回旧窗口。

0.10.1 支持 **RK 一次性读取审批**：受控 OpenCode 先扫描并冻结文件，经真实 RK 判断和主机签名后，只向本地 Agent 返回获准快照，消费后旧缓存撤销。固定实际测试支持的36个场景全部通过审批闸门，20次真实审批P95约2.703秒；Agent最终任务与完整隐私观察另行计分。使用设备连接给出的 `coloop-managed.sh` 入口，详见 [受控审批](../RK/docs/20-coloop-managed-approvals.md) 与 [固定题集报告](../RK/docs/19-coloop-managed-approval-evaluation.md)。

上述36/36是完整冻结批次的闸门结果。最新后端模型输入投影定向回归为21/22闸门、20/22最终任务，仍有主Agent误抄路径和422，19个消费样本P95为3.548秒且缺1项；完整隐私观察仍有缺口。没有将这些失败覆盖或宣称全面等同Violoop。

0.9.0 增加 OpenCode 1.19.5 原生 Hook：直接接收消息、工具和审批事件，RK 用有界上下文完成快审，插件复查并消费原请求。设备连接自动建立 SSH 回环通道；短期观察与 Mem0 长期事实分开管理。接入方式、测试指标及边界见 [原生 Hook 说明](docs/native-agent-hooks.md)。

受控发题、真实OpenCode pending和真实RK审批的20条验收全部成功，审批P95为3.008秒；另有无测试源的真实Qwen终端闭环通过。测试口径、失败记录和当前受限回复范围见 [验收记录](docs/verification.md)。

0.8.0 新增「Agent 协调」：接收开发 Agent 的待处理请求，RK 本地分析后复查并回复安全单项选择或权限拒绝。读取放行先保留建议，等待主 Agent 数据路径验收。会话鉴权、独立审计及板端日志保护见 [协调开发说明](docs/agent-coordination.md)。当前尚未接入 Codex 桌面原生审批。

0.7.0 接入 RK 已部署的 Qwen3.5-4B 模型服务：经固定指纹 SSH 访问板端鉴权 HTTP 接口，设备页显示服务状态、实际模型和上下文，并可启动已有服务。RK 回答完成后返回；云端沿用流式结果。

界面沿用 0.6.1 的倾斜双半圆 Logo 与石墨黑视觉：石墨黑导航、白色任务工作区、浅灰设备栏、石墨黑操作按钮和灰阶状态层级。快捷操作改为紧凑列表，表单、OCR 与设备图同步使用黑白轮廓。六个页面共享排版、控件与圆角规则；名称保持 **Coloop**。Logo 保留外弧稍厚、竖边稍细的轮廓，整体倾斜 −35°；源文件为 `resources/brand.svg`，预览为 `resources/logo-preview.png`，PNG 和 ICO 由同一 SVG 生成。设计规范见 `DESIGN.md`。

仓库位于 `D:\Coloop`。开发前已初始化 Git，首个提交为 `c1102c8`；没有上传到远端。

## 启动

双击 [`start.cmd`](start.cmd)，优先运行 `release` 下的 Windows 程序。打包程序复用本机已经安装的 `D:\RK` OCR 环境，无需重新安装 OCR。

开发环境需要 Windows 10/11 x64、Node.js 24。使用锁文件安装：

```powershell
cd D:\Coloop
npm ci
npm run dev
```

Electron 下载如受网络影响，可仅对当前终端设置镜像，再运行 `npm run setup:electron`：

```powershell
$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
npm run setup:electron
```

## 已实现

| 功能       | 行为                                                                            |
| ---------- | ------------------------------------------------------------------------------- |
| 工作台     | 文字任务、附加屏幕或 OCR 文本；默认 RK + 云端协作，另可选择仅 RK                |
| 模型连接   | OpenAI 兼容、Anthropic、Gemini 协议；自定义地址/模型；保存与连接测试            |
| 屏幕理解   | 多显示器截图、图片导入、RapidOCR 中英文识别、文字框/中心坐标、坐标 JSON 复制    |
| USB 设备   | USB RNDIS 网络 + 固定指纹 SSH；温度、内存、运行时长、模型服务就绪状态           |
| 端侧推理   | 复用板端 `qwen35-4b-rkllm` / 16K 鉴权服务；启动已有服务、超时与忙碌提示         |
| Agent 协调 | 原生事件接收、隔离上下文、RK快审、原请求校验/消费及延迟统计                     |
| 工作流     | 截屏 → 本地 OCR → 模型总结/翻译 → 本地任务记录                                  |
| 历史       | 最近 200 条任务、搜索、状态筛选、导出 JSON、清空                                |
| 本地存储   | 云端 API Key 经 Windows DPAPI 加密；SSH 密码与板端服务 Key 不落盘；图片只留内存 |

## 第一次配置

1. 使用数据线连接开发板 OTG 接口，在「设备管理」点「导入 RK 配置」，输入 SSH 密码并连接。会校验 `D:\RK\config\board.json` 中的设备指纹。端侧服务目录默认 `~/rk-opencode`，端口默认 `8088`；修改后先保存。
2. 查看「端侧能力」。已就绪时可直接在工作台选择 RK；未启动时点「启动端侧服务」，等待服务就绪。按钮只启动已部署的 Qwen3.5-4B 服务，不安装运行环境或权重。存在活跃桥接进程或端口被占用时会拒绝替换，需先检查原服务。已有启动脚本使用端口 `8088`。
3. 需要云端模型时，在「模型连接」选择协议、填写带版本前缀的地址、模型 ID 与 API Key，保存后测试。默认模型名只是可编辑示例，以账户实际可用模型为准；运行 RK 任务不需要云端 Key。
4. 在「屏幕理解」导入图片或截屏、识别，再点「用于任务」。也可在工作台直接启用「附加当前屏幕」。截图时本窗口会短暂隐藏。选择 RK 时，仅将识别文本作为参考内容交给板端模型分析。

端侧请求经 SSH 私有转发到开发板 `127.0.0.1:8088`，板端服务 Key 通过 SSH 读取后只保留在主进程内存，界面不接收该凭据。设备显示「已就绪」来自鉴权 `/health` 响应，不再使用模型文件存在作为就绪依据。模型忙碌会显示明确提示，不自动切换云端。

RK 任务的「停止等待」只停止上位机等待，不强制结束板端共享推理；之后立即提交的新任务可能收到忙碌提示。端侧当前一次返回完整回答，不提供逐 token 输出。

OpenAI 兼容地址示例为 `https://api.deepseek.com/v1`；本地 Ollama 可填 `http://localhost:11434/v1`，允许留空 Key。远程地址必须 HTTPS。云端请求使用 Electron 网络栈，沿用 Windows 系统网络配置。

OCR 复用 `D:\RK\deployment\screen-ocr\.venv\Scripts\python.exe` 和 `D:\RK\tools\screen_ocr.py`，不复制或修改 RK 环境。在「模型连接」底部可更改 RK 项目路径。识别常驻进程不监听 TCP 端口，仅通过私有 stdin/stdout 通信，网络请求被禁用。

## 检查与打包

```powershell
npm run typecheck
npm test
npm run format:check
npm run test:e2e
npm run test:coordination
npm run test:hooks
npm run package:win
```

`test:e2e` 使用真实 Electron、真实 RapidOCR 和本机 HTTP 测试服务，不消耗云端额度；需上述已安装 OCR 环境。设置 `COLOOP_TEST_BOARD_PASSWORD` 可额外验证真实 USB 设备健康读取；同时设置 `COLOOP_TEST_BOARD_INFERENCE=1` 会启动已部署的端侧服务（如未启动），运行真实 NPU 算术与 OCR 文本提取。测试配置与历史写入独立的 `.qa` 目录，不执行跨应用桌面操作。`COLOOP_EXECUTABLE` 应指向 `release/win-unpacked/Coloop.exe`，用于直接调试打包程序；portable 启动器不能直接接入 Playwright 的 Electron 调试管道。

0.10.1 历史产物为 `release/Coloop-0.10.1-Windows-x64.exe`，当轮隔离打包目录为 `release/0.10.1/win-unpacked/Coloop.exe`，当时已同步安装版。普通 `npm run package:win` 使用默认 `release/win-unpacked`；历史0.10.0产物仍保留。换电脑时，需要另行准备 RK OCR 环境并设置路径；发布物没有复制整个 Python 环境。可执行程序未做代码签名。

## 当前边界

- 服务健康就绪表示选定模型与协议可用，不代表模型回答质量已验收。端侧输出仍需核对，具体实机验证范围见验收记录。
- OCR 坐标是当前图像的像素坐标，不直接作为桌面物理坐标。不是按钮边界，也不证明可点击。
- 受控启动器支持扫描冻结快照的 RK 单次读取审批；旧版通用 read 的 allow 保持等待。任意 Shell、写入、联网、跨应用动作及 Codex 桌面原生审批尚未接入；没有物理 MCU 隔离。
- Coloop/Hook 的 Mem0 调用仅登记自己的前台占用，在推理前等待正在进行的维护排空；Hook 不召回或写长期事实。受控配置禁用长期记忆插件，正常旧版 OpenCode 启动仍保留 MemoryPlugin。共享服务可能被其他 RK 会话占用。
- 云端真实账户调用需配置自己的 Key；本次测试使用本机协议服务，不代表已验证某个账户或服务商的可用性。
- 运行历史包含任务与模型回答，保存在 `%APPDATA%\coloop\state.json`；API Key 的加密不覆盖历史文本。

详见 [架构](docs/architecture.md)、[验收记录](docs/verification.md)、[界面设计](docs/design.md)、[参考来源与第三方组件](docs/references.md)。
