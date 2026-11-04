# 验收记录

最近更新：2026-10-30，Windows 11 x64，本机 `D:\Coloop`。

## 暂不启用系统防截屏

按用户最新要求移除私密填写与私密登录窗口的 `setContentProtection(true)`，源码不再启用系统窗口捕获排除；同步移除仅限本机操作的界面文案。独立隔离、同源登录与 Coloop 内部观察暂停继续生效。构建及类型检查、9项相关单元测试与6项记忆窗口检查通过，开发版报告 `.qa/memory-window-1793355563384/report.json`。当前发行目录 `release/remote-visible-20261030/`，`start.cmd` 优先启动。下节防截屏状态为前一版历史记录。

## 记忆页窗口可见性

旧实现复现时主窗口 `visible=true`、渲染进程未崩溃，而 `isContentProtected=true`，系统截图排除整窗；失败证据 `.qa/memory-window-1793353484411/report.json`。修正后主目录可见，私密字段位于独立受保护窗口，主页面仅接收保存及索引结果；旧主页面创建通道拒绝明文输入。

508项单元测试通过，新增6项覆盖来源校验、禁止网络、去重、失败重试与退出时等待保存排空。开发版记忆窗口6项和窗口生命周期3项通过；打包版 `release/memory-visibility-20261030/win-unpacked/Coloop.exe` 记忆窗口6项、通用桌面9项通过。打包版报告 `.qa/memory-window-1793354000937/report.json`，包含三次往返导航、双尺寸与空私密表单截图。生产构建和类型检查通过。本轮仅使用离线合成字段与模拟保存回调，没有重跑真实RK保存、NPU、USB输入或公网登录；已更新板端验收脚本以适配独立填写窗口。

## RK 电脑操作与同页批量执行

独立构建 `release/desktop-batch-0.12.0/win-unpacked/Coloop.exe` 已用真实 RK/NPU/HID 验收：随机读数、字段替换、点击确认合并为 1 次规划和 1 组执行，初始/最终各一次 OCR，组内 4 次快速 UIA 校验不调用 OCR/模型。实际数字一致、提交一次；发行物闭环 24.300 秒，含准备约 29.3 秒。停止、互斥、无授权、缺失窗口和不落盘截图均有检查。499 项应用、15 项桌面 Python、16 项原控制提示 Electron 检查通过。结果、保留失败与使用方式见 [电脑操作](desktop-operation.md)；文件 SHA256、实际报告与限制见 `release/desktop-batch-0.12.0/verification.json`。本轮不覆盖安装版，不把单个窗口样例当作通用成功率或真实云端桌面验收。

## Android 首版与无自建服务器的异网连接（2026-10-30）

交付原生 Kotlin / Compose Android 0.1.0 调试签名 APK 和 Coloop 0.12.0 配套 Windows 程序。手机支持配对、会话列表、进度正文、追加要求、源端回执、停止／明确恢复、以旧密钥验证新地址及解绑；电脑保留屏幕顶部独立英文 Coloop 控制提示。公网只发布独立 AES-256-GCM 网关，Cloudflare Quick Tunnel 为显式开启的临时通道，不需要用户自建服务器。

- 最终 APK 编译与 JVM 协议测试 6/6 通过；Android Emulator API 35 经实际公网 HTTPS 使用 Android Keystore 和加密 RPC，不走模拟器主机别名。初轮实际手机界面操作 4/4：两次原文各送达一次、源端确认中断、明确恢复后不重放。
- 远程网关 21 项、会话控制 32 项及原生 Hook 投影回归共 111 项通过；最新全工作树 Vitest 494/494 通过（16 文件），包含并行模块，不能都计作手机专项。此前全量运行曾在并行修改的协作测试中有 22 项失败；保留该事实，以上为相关修订完成后的新运行结果。
- TypeScript 与生产构建通过。开发程序和配套打包程序均通过真实公网 7/7：隧道、加密配对、命令／顶部提示／净化进度、中断锁存、吊销、隧道崩溃重连、禁用与异步启动竞态。最终打包程序报告 `.qa/mobile-1793342217997/results.json`。
- 手机第一轮证据 `.qa/android-live/phone-control-evidence.json`；最终 APK 的 15/15 验收项通过，地址迁移、浅／深色主题、1.3 倍字号、内容进度和固定停止入口证据在 `.qa/android-live/round2/results.json` 与同目录实际截图。初轮发现的主题偏紫、配置变更重复进入配对、停止入口随滚动离屏及暂停状态文案已修复后重新构建。最后新指令与中断各送达一次，停止按钮滚动前后中心位置均为 (393, 978)；已恢复模拟器显示设置并正常关闭本轮模拟器与公网测试进程。

APK 为 `release/android/Coloop-Android-0.1.0-debug.apk`，18,693,731 字节，SHA256 `3745293844a8c57fa04e971c0be2de6e5df5ad71ea8b70fb81436f6968eff560`。配套电脑程序在 `release/android-companion-0.12.0/win-unpacked/`，包含固定官方 cloudflared 2026.10.6 及许可证；`start.cmd` 优先启动该目录。未覆盖系统安装版、未上传应用商店、未使用付费模型。

本轮使用明确的 Windows 原生协议测试来源，不将其当作真实 AI 任务质量。此前真实 OpenCode 控制证据保持独立；没有运营商流量／物理安卓手机实测，也没有后台推送、稳定域名、自动续推或 Codex 桌面接管。临时隧道没有在线保证，重建地址会改变，手机在前台轮询；部署步骤与边界见 [Android 首版](android.md)。文件摘要及各轮验证范围以 `release/android/verification.json` 为准。

## 真实 DeepSeek 与源条件保真（2026-10-30）

保存的官方DeepSeek / deepseek-flash账户已真实验证。`D:\RK\logs\coloop-deepseek-direct-20261030134347/` 两题正确且严格JSON通过：18×24−137后每7件装箱为42余1；两工位依赖排程最短8，模型具体步骤已独立／人工核对。`D:\RK\logs\coloop-deepseek-full-20261030140918/` 完整RK两题通过，简单题5且零云；复杂题76.88秒，8次RK、一次实际DeepSeek、一次真实本地格式重生，源A/B条件逐字保留、私密串／合成密码及编码未出境，最终身份精确呈现，自有租约清理为0。摘要／选择问题、格式错误、截断与算错的全部失败另列，不改写历史，见 [专题报告](../../RK/docs/22-deepseek-cloud-validation.md)。

本轮将自由摘要改为RK只选原文片段id、主机精确摘录facts，最多48片段中选1～6、3000字节预算；数据面仍做Vault与RK复核。DeepSeek官方两模型使用low思考和2048 token预算，并显式JSON模式；通用端点保留512。运行中的默认4B protocol 3健康校验严格绑定profile、embedded、指纹、输出能力与metadata-only，不接纳临时验证模型。旧protocol 2启动脚本分支本轮未改写或实机重启。

当前全工作树492项测试、类型与构建通过（包含其他并行模块），新包9项通用Electron/DPAPI/OCR回归通过。新目录为 `release/deepseek-validated-0.12.0/`，未关闭或覆盖正在运行的安装版。构建绑定冻结out及真实通过轮次的关键源码；并行修改的mobile-remote.css未回滚，也不冒充本轮新样式已验证。完整构建与来源摘要在 `D:\RK\logs\coloop-deepseek-verification-20261030-141149/`。

## 顶部提示窗收窄、英文与屏幕定位

按用户补充要求，提示窗最大宽度从 560 缩为 373 DIP（约 2/3），品牌文字固定为 Coloop，去掉 OpenCode 和工作区名称；可见文字、按钮及辅助标签全部使用英文。计时与停止入口保留。窗口按整个主显示器 `screen.bounds` 定位，在屏幕顶部约 8 DIP 处居中，与主窗口是独立的 BrowserWindow；移动、缩小、最小化或隐藏主窗口都不改变其屏幕位置。

本轮类型、生产构建、所改文件格式检查通过。桌面验收新增英文/品牌、默认计时器与屏幕级定位检查，16/16 通过：主屏 1707 × 960 DIP，提示窗位于 (667, 8)、实测 374 × 76 DIP（Windows 缩放取整，与目标 373 相差 1）；主窗口移动到 (100, 170)、缩小及最小化时，小窗保持可见且坐标不变。完整屏幕实拍 `screen-top.png` 与报告保存于 `.qa/control-2026-10-30T05-31-12-751Z/`；此前原生会话链路结果保留，不将其描述为本轮重新运行。新版程序与 portable 已重新打包至 `release/session-control/`，当前摘要记录在该目录的 `verification.json`。

## 0.11.0 RK / 云端隐私协作

新增默认协作模式：RK 路由、敏感片段识别、本机替换、短摘要、RK 出口复核、云端固定 JSON、RK 本地实体声明及主机精确呈现。旧 cloud IPC 也经相同隐私流程。最终本地 JSON 仅语法／结构错误允许一次真实重新生成，不强转或修补原输出，不重发云端。政策与限制见 [协作说明](cloud-cooperation.md)。

真实 RK 两题在 `D:\RK\logs\coloop-cooperative-20261030122647/` 通过，进程退出 0：简单题 `5`、零云请求、8.03秒；复杂题含一次真实格式重生，103.24秒，共8次 RK、1次 HTTP 云协议 fixture 请求。出境捕获不含合成私密值／密码及对应编码，原业务名按声明 ID 精确呈现。首轮非法 ID 字符串与第二次合法数组分别保留。不是付费云模型调用，不证明任意业务推理质量或通用 DLP；全部9轮先前失败和本地输出协议调整见 [RK 专题](../../RK/docs/21-coloop-cloud-cooperation.md)。

当前工作树全量 **395 项测试、类型检查和生产构建通过**，其中包含并行开发的既有／新增模块，不能都计成本功能专测。协作任务专项 **73 项**通过。开发版通用 Electron／DPAPI／本地 OCR／导出回归通过；本次测试配置、截图及日志均在独立 `.qa/e2e-*` 和 `D:\RK\logs\coloop-cooperative-verification-20261030-120549/`，未修改实际用户配置。工作区期间出现独立的会话控制／顶部提示开发文件，本任务未回滚或代为重写其源码，构建绑定实际编译内容及 SHA。

本次协作构建保存至 `release/0.11.0/`，旧版保留，未更新已安装程序，也未同步 `D:\Coloop-GitHub` 或推送远端。构建与打包校验、打包版回归证据以本次 verification 目录 manifest 为准；本页其他记录保留为各自专题结果。

协作portable为112809655字节，SHA256 `ce6d51ad702464c561da0379a6de69b43ea5f508b7446008a63d9bdce7eea931`。`app.asar`为38489447字节，SHA256 `01e4868f1a49949542282c3d1c0af8e5c316fb1fab09eb2eb746bfb01ae73527`；全部out文件与已验证编译结果逐个匹配，源码构建前后未变。打包版9项通用Electron回归通过，独立结果与双窗口截图在 `.qa/e2e-1793334858674/`。

## 电脑会话控制与顶部提示（2026-10-30）

已实现主屏顶部独立置顶提示、不抢焦点、预览/控制/停止/未确认状态及源端停止确认。会话注册表、命令 outbox、持久去重账本、停止锁、托盘驻留和可信工作区变更撤销已接入。没有新增手机 App、异网网关、自动续推、通用 HID 或 Codex 桌面控制。

- 全量 Vitest 395/395、TypeScript 与本轮文件 Prettier 检查通过。控制 Core 31 项覆盖重复/过期/旧实例/重启/用户接管及派发前再校验；协调和原生 Hook 回归一并通过。
- 插件控制与原审批 Node 测试 49/49 通过。插件使用原生进程内 SDK，发送 204 后回读用户消息，中断后查询源空闲；中断不再永久关闭可继续的控制会话。
- 真实 Electron + 鉴权协议来源桌面验收 14/14：窗口位置、焦点保持、隔离 preload/IPC、先显示再派发、送达不等于完成、停止回执/锁存、提示窗崩溃触发停止、托盘驻留和工作区切换撤销。源码报告 `.qa/control-2026-10-30T04-28-22-730Z/report.json`；打包版报告 `.qa/control-2026-10-30T04-30-35-383Z/report.json`。
- 真实 Windows OpenCode 1.19.5、生产插件与真实 Electron 的 5 项闭环通过：初始原生回合注册；追加原文进入原 session/稳定 messageID 并产生对应回答；顶部提示随源状态显示/隐藏；点击停止触发真实 native abort 并确认 idle；明确恢复后同原 session 可继续新回合。证据 `.qa/native-control-1793334494695/results.json`、`run-manifest.json` 和 `native-controlling.png`。

原生验收的模型响应明确为本机合成数据，4 次请求、0 工具调用，没有连接 RK 或使用付费云端账户，Hook 活动错误为 0。它证明真实会话控制和中断链路，不证明复杂 AI 开发任务质量。固定 Windows runtime 从官方 npm 包下载到隔离 `.qa/opencode-native-1.19.5`，已校验 SHA512；未安装到全局环境。

程序构建保存在 `release/session-control/`，与其他历史构建分开。控制范围、Windows 插件接入及未覆盖的锁屏/安全桌面场景见 [会话控制说明](session-control.md)。

初版打包另通过 9 项通用 Electron/OCR/DPAPI/导航/截图/历史导出回归，报告 `.qa/e2e-1793334639297/e2e-results.json`；该轮未运行 RK 推理。初版 portable 为 112809659 字节，SHA256 `1b96ef99471133830731adf02629c0b337ee5e07a0a643e301cfa42cb9bd5833`；`app.asar` SHA256 `01e4868f1a49949542282c3d1c0af8e5c316fb1fab09eb2eb746bfb01ae73527`。后续界面修订的当前构建仍位于 `release/session-control/`，实际摘要以同目录 `verification.json` 为准。启动脚本优先指向该 unpacked 程序，未覆盖或终止现有运行中的安装版。

最终受控后端修订为core `f269f5bf...`、entry `bf3c981f...`，应用产物仍0.10.1。已批准结果仅在模型输入副本变为简洁原文，原工具JSON、签章和字节不变，76项Node和当前源码Linux fd27项通过；当前策略127/128。前轮长文本/CRLF单独复测2/2，但扩大22项回归中21项闸门、20项任务通过，另有误抄路径和422；19个消费样本P95/max3547.726ms、缺1项，超过本轮3500ms目标，完整隐私strict仍未通过。详见 `D:\RK\docs\19-coloop-managed-approval-evaluation.md` 与各轮原始目录，不以旧轮通过覆盖本轮失败。

## 0.10.1 完整实际审批批次

固定native40：支持的36题全部通过闸门（20次RK签名放行、16次规则拒绝），4个route变体unsupported。20个消费样本P50 2564.365ms、P95 2702.595ms、最大2705.685ms，20个permit另用来源绑定公钥离线复核。Agent最终任务34/36，长文本和CRLF两题读取完成但模型收尾422；完整隐私scope未齐，strict仍0/40。原始及独立报告在 `D:\RK\logs\coloop-managed-native-final-20261030-040600/`，未用闸门分数替代任务或完整隐私验收。

92次模型调用均metadata-only，worker新增0字节，Mem0状态不变，自有进程/会话/租约/连接清理通过。主机实际截取20个reviewer输入，没有文件nonce/canary；不冒充primary wire或全存储检查。模型驻留、单NPU串行，非冷启动SLA。

最终Linux策略127/128、Coloop189项、Hook/core/profile合计65项Node、73项Python（Windows3跳过）及本轮68项工具测试通过；新增Linux fd27/27及其6项helper另存。类型、语法、相关Ruff和打包版10项通用Electron/OCR/导出回归通过。验证manifest为 `D:\RK\logs\coloop-0101-verification-20261030-093105/`，后续专项测试保留独立日志，不混为本轮数量。

`release/Coloop-0.10.1-Windows-x64.exe` 为112781791字节，SHA256 `d93f678a2b569b377a5686ae7327a9aa069366d7871417c9f48caeb79fef2bde`。已正常关闭本任务启动的旧实例并更新安装版，app.asar与 `release/0.10.1/win-unpacked`一致，用户数据保留，备份 `release/installed-backup-before-0.10.1-20261030-093724/`。未强制终止用户进程，未推送远端。

## 0.10.0 RK 一次性快照读取

生产受控 profile 的真实 Qwen primary → RK reviewer → Ed25519 permit → 原生 once → 快照 → 最终未知验证串闭环已通过，`D:\RK\logs\coloop-managed-read-1793302073936/`：整任务41.937s，审批2501.376ms，三次metadata-only调用，双SHA、任务绑定和实际消费均核对，Mem0计数不变。上位机真实审批请求的合成数据 observer 确认未包含文件验证串，`.qa/hooks-1793302068969/results.json`。这只是单例，不当作固定题集全部通过。

最终源码的Linux128策略测试126/128，2项许可消费重放不能由CPU策略层证明；固定版本与逐题原始证据在 `D:\RK\logs\coloop-approval-policy-linux-final-20261030-033707/`。真实native40批量测试另列，主模型wire/fullMem0未实际观察时不记为隐私通过。测试口径见 [固定评测](../../RK/docs/19-coloop-managed-approval-evaluation.md)，能力边界见 [受控审批](../../RK/docs/20-coloop-managed-approvals.md)。

自动检查原始stdout/stderr与源码/产物SHA归档 `D:\RK\logs\coloop-010-verification-20261030-034207/manifest.json`：173项Coloop、62项Node Hook/managed core、73项Python（Windows3项Linux-only跳过）、60项Coloop工具、5项Linux活动租约、类型与Bash语法均通过。随后controller最终版另有12项helper测试，保留独立日志。打包版10项通用Electron/RapidOCR/导出回归通过。

portable `release/Coloop-0.10.0-Windows-x64.exe`，112781771字节，SHA256 `2f34fe0a64bf748a84f9743caade5561a96299aaa1709503b61172346f6d50e4`。安装版已更新并正常重启，app.asar与已验证release完全相同，旧程序备份 `release/installed-backup-before-0.10.0-20261030-034521/`，用户配置与历史保留。没有推送远端。

## 0.9.0 原生 Hook 与 RK 快审

OpenCode 1.19.5 原生消息、工具、状态和审批直接接入 Coloop，默认终端通过同进程 SDK 读取/回复 pending。来源/实例/会话/任务隔离、压缩失效、过期、防重放、容量、队列及断连清理边界均已加入。Hook 不写 Mem0 长期事实，候选推理前遵守前台租约；私密模型请求继续核对能力与回执。自动执行限既有安全单选和权限拒绝，所有 allow 等待数据路径验收。

使用同包 `release/win-unpacked/Coloop.exe` 完成两类独立实机验证：

- `D:\RK\logs\coloop-internal-hook-1793295194567/`：真实 Qwen primary、真实 RK reviewer、stock `--mini`、无测试源/阶段fixture；原生 pending 被消费、tool completed、最终文字精确匹配，2957.743ms审批、53.047s任务。3次私密模型请求、无源TCP监听。UI证据 `.qa/hooks-1793295190991/results.json`。
- `D:\RK\logs\coloop-hooks-benchmark-1793296894702/`：**受控源发题/回显＋真实OpenCode pending＋真实RK审批/SDK消费**，不是20次主模型开发成功率。100事件接收P95 **22.200ms**；10规则拒绝P95 **28.279ms**；20审批全部成功，P95 **3008.326ms**、最大3029.731ms，达到3500ms目标；预热单列3124.880ms。选项位置交替，摘要与事件回执全部绑定。UI证据 `.qa/hooks-1793296891877/results.json`。

正式样本21次实际RK请求全部metadata-only、worker日志新增0字节；Mem0事实/版本/摘要/队列计数未变。自有会话、进程组、租约和连接文件清理通过；最终板端0残留测试进程，部署插件SHA与本地一致。来源脚本化、热模型与单NPU串行的口径，以及源模型JSON失败、验收器竞态和独立非私密合成诊断均单列保留，详见 [原生Hook说明](native-agent-hooks.md) 和 `D:\RK\docs\18-coloop-hooks.md`，没有放宽格式、阈值或安全规则来掩盖失败。

类型、生产构建、相关格式/语法/Ruff通过。Coloop144、Hook插件36、benchmark16、受控源HTTP/SSE9、进程内smoke验收5、旧适配器22和子仓库60项测试通过。普通Electron导航、DPAPI、协议、取消、离线RapidOCR、截图和历史导出回归通过；SSH竞态由fakeSSH/SFTP覆盖，TTL为假时钟边界测试。

产物 `release/Coloop-0.9.0-Windows-x64.exe`，112780740字节，SHA256 `efecae01552bd94a7313fd40851bc92ca68ae768578e8dfcf9c527291b0b23ba`。源码、SDK锁、fixture和产物摘要见正式实验的 `run-manifest.json`；没有复制到 `D:\Coloop-GitHub` 或推送远端。

## 0.7.0 上位机与 RK 真实联调

上位机从固定的 9B 命令行入口改为复用 RK 已部署的 4B 服务。USB RNDIS 与固定指纹 SSH 实机连接通过；主进程经 SSH `forwardOut` 访问板端回环鉴权 HTTP，不开放新的本地监听端口。服务 Key 仅在主进程内存使用。已通过上位机接口启动原先未运行的服务，鉴权 `/health` 返回 `qwen35-4b-rkllm`、上下文 16384、Runtime 1.3.0、worker protocol 2。

开发版和 `release/win-unpacked/Coloop.exe` 均完成 14 项真实 Electron 联调，包含原有云端环回协议、凭据加密、RapidOCR、原生截图和历史导出，以及本次真实 USB/SSH、RK 服务健康和 NPU 任务。打包版结果：算术题 `2+3` 回答 `5`，约 2.64 秒；将真实 RapidOCR 识别文本送入 RK，回答品牌 `Coloop` 与金额 `128.50`，约 6.37 秒。耗时包含应用请求和前台活动登记，仅代表这次短任务。原始任务与设备结果保存在本机 `.qa/e2e-results.json`，模型与 OCR 没有使用云端账户。

39 项自动测试通过，其中 21 项针对 SSH/HTTP 设备链路，覆盖认证前指纹拒绝、Key 不回传、服务离线与恢复、模型/协议检查、中文 UTF-8 预算、429/503、取消后忽略迟答、断开与刷新重连竞态、无效/截断/工具回答拒绝，以及服务启动和重新验收。TypeScript、生产构建、Windows portable 打包通过。

已将本机 `C:\Users\52760\AppData\Local\Programs\Coloop` 更新至 0.7.0，旧可执行文件与 `app.asar` 备份在 `release/installed-backup-0.6.1-20261029-211306/`。更新后的实际安装程序再次通过工作台 UI 发起中文算术任务，RK 回答 `5`；当前保留 USB/SSH 连接，工作台已选 RK。没有保存 SSH 密码，应用重启后仍需输入密码连接。安装版结果与截图在 `.qa/installed-live-result.json` 和 `.qa/installed-live-workspace.png`。

RK 当前完整回答后返回，停止等待不会终止共享 worker；这项语义已在界面明确说明。Mem0 仅登记前台占用并等待已有维护排空，没有接入记忆召回或写入。此次接通范围是设备健康和文字/OCR 推理，没有接入 RK 独立的 HID、工具执行和跨应用桌面 Agent，也未做模型全面质量或耐久性验收。

## 0.6.1 石墨黑调整与能力核查

按用户要求将纯黑改为 #202124 石墨黑，配合 #2b2e33 抬升表面和 #383c43 悬停层级，导航、按钮、Logo 与图标同步。界面布局和标志几何保留。

核查确认：OCR 调用本机 D:/RK 的 RapidOCR Python 环境，桥接脚本随应用打包，但 Python、OCR 模型与 RK 模块未完整打包进应用。本机存在所需运行文件，真实中英文 OCR 联调通过。云端适配器支持 OpenAI 兼容、Anthropic 和 Gemini 协议；协议测试及环回服务流式调用通过，本轮未使用用户真实付费云端账号。

TypeScript / 生产构建、21 项单元测试、10 项桌面联调通过；六页两种窗口尺寸无横向溢出。已查看默认及紧凑窗口石墨黑视觉效果。

## 0.6.0 黑白 UI 与倾斜品牌统一

用户明确选择最新线条图标恢复倾斜，并将前端按该风格重新设计。Logo 在保持外弧 9.5、竖边 7.3 与平滑肩部的基础上，整体恢复 −35°；六页统一为纯黑导航、白色任务区、浅灰设备栏、黑色主操作和灰阶状态。快捷操作改为紧凑列表；OCR 文字框与设备图改为灰阶。控件保持标准方向，圆角、线条和字重呼应品牌。

TypeScript、生产构建、21 项单元测试和 10 项通用桌面联调通过。六页在默认与最小桌面窗口共 12 个组合均无横向溢出，默认工作台完整显示最近任务区，OCR 编辑器焦点与 Sora 字体加载通过验证。首次独立复核提出的首屏高度与任务编辑器焦点规则两项均已修正，第二次复核逐项确认解决。本轮未测试真实板端推理或正式云端账户。

Windows 程序为 `release/Coloop-0.6.0-Windows-x64.exe`，启动入口已更新。设计系统同步到 `DESIGN.md` 与 `.impeccable/design.json`；Impeccable 引擎仍不可用，本轮没有声称自动设计检测通过。

## 0.5.7 线条轻重与连接过渡

用户确认竖直形状后，本轮只优化线条。外弧名义厚度为 9.5，竖直封口为 7.3；上下连接处使用连续平滑轮廓，内侧转角略圆，避免独立描边叠加形成端点鼓包。保留黑白、竖直、镜像对称和闭合双半圆。已查看原版与新线条的大图和小尺寸对比，同步更新正反 SVG、PNG、ICO 与发布程序。

## 0.5.6 竖直双半圆 Logo

按用户要求移除整体 −35° 旋转，双闭合半圆改为左右竖直对称。保留黑白、线宽、圆弧半径和间距；正反 SVG、PNG、ICO、预览与 Windows 程序同步更新。

## 0.5.5 恢复对称结构并做光学微调

用户更喜欢 0.5.3 的原版，明确要求只调整线宽、轮廓和半圆距离。本轮恢复对称、等线宽和圆角收口，取消 0.5.4 的独立旋转、错位和曲线内腔。线宽从 11 改为 9；圆弧半径从 36 改为 37，保持整体外径；中央净间距从 15 改为 13。已生成与 0.5.3 原版的大小图标对比，SVG、反白版、PNG、ICO 与应用同步。

## 0.5.4 Logo 光学与曲线调整（已被用户否定并替代）

按用户提出的艺术性反馈，保留黑白及闭合双半圆，通过轻微错位、反向旋转、曲线内腔和粗细变化增加旋转感。直线封口和圆弧外形保持；同步 SVG、反白 SVG、PNG、ICO 与品牌预览。已查看调整前后及小尺寸图标对比。

## 0.5.3 闭合半圆 Logo

按用户反馈，为每段圆弧分别添加连接自身端点的直线，形成两个闭合半圆。保留黑白、倾斜角度、线宽、圆弧和两片之间的间隔；SVG、反白 SVG、PNG、ICO、预览及 Windows 发行物同步更新至 0.5.3。

## 0.5.2 黑白圆弧 Logo

按用户最新反馈，将 Logo 改为纯黑白，并以两段镜像圆弧替代原来的长圆 C 与中心直线杆，形成接近完整圆环的 loop。沿用倾斜角度、等线宽和清晰开口。SVG、反白 SVG、PNG、七种尺寸 ICO 以及品牌预览同步生成；Windows 程序与启动入口更新至 0.5.2。

## 0.5.1 Logo 开口微调

根据用户反馈，将连接器两侧改为对称、开口更清晰的 C。端点中心距由 10 增至 24 SVG 单位，净开口为 13 单位；保留 −35° 倾斜、中心连接杆、蓝色与等线宽。已同步生成 SVG、PNG、七种尺寸 ICO 和品牌预览，并通过 TypeScript / 生产构建与大小图标视觉检查。Windows 程序及启动入口更新至 0.5.1。

## 0.5.0 科技风格与新 Logo

用户明确选择「更鲜明的科技风格」。六页采用深海蓝导航、冷白工作区和信号蓝主操作；工作台增加本机 / Coloop / RK 设备连接路径。新 Logo 为倾斜相扣的双回路，字标使用本地 Sora 字体；附带 OFL 许可证。SVG、PNG、ICO 与预览来自同一几何源文件，生成入口为 `python scripts/make-assets.py`。

TypeScript、生产构建、21 项单元测试和 10 项通用 Electron 联调通过，包括真实中英文 OCR、配置保存、凭据加密、流式任务、取消任务、原生截屏与历史导出。本轮未重复执行真实 RK 设备连接或端侧推理。

布局检查覆盖六页在 1440×940 和 1060×720 两个窗口尺寸下的实际渲染，12 个组合均没有横向溢出；长表单允许纵向滚动。字体加载与 OCR 编辑器键盘焦点通过计算样式确认，焦点为 2px 实线。布局记录位于 `.qa/layout-results.json`，另有表单底部、窄窗口和焦点截图。

Impeccable 4.8.0 从上游 pbakaus/impeccable 安装到用户 skill 目录。配套引擎下载失败，自动上下文、设计检测与随机方向验证未运行成功；本轮按其指南直接读取项目上下文并实现。独立视觉复核发现的字标、模型图标、输入区标题与 OCR 焦点四项已修正，第二次复核逐项确认解决。最终设计记录在 `DESIGN.md` 与 `.impeccable/design.json`。

Windows 发行物为 `release/Coloop-0.5.0-Windows-x64.exe`，`start.cmd` 优先启动该版本。

## 0.4.0 极简桌面风格

根据用户明确选择的 macOS 式极简桌面方向，调整浅灰侧栏、白色任务画布、16px 容器圆角与轻量层级，增加留白并降低边框密度。保留 Coloop 名称、双环标志及统一组件规则。浅色层次通过表面和阴影表达，正文与辅助文字仍保留可读对比度。

生产构建与 TypeScript 检查通过，现有 10 项通用桌面联调通过。视觉检查覆盖六个页面及 1060×720 最小窗口；Windows 发行物为 `release/Coloop-0.4.0-Windows-x64.exe`。

## 0.3.0 组件规范与名称统一

可见品牌名称统一为 Coloop。移除个人问候、署名与装饰字母；Logo 由等半径、等线宽的 C 与闭环构成。清理旧版两层样式，唯一入口为 `src/renderer/src/system.css`，将间距、字级、控件高度、圆角、状态色与三栏布局固定为组件规则。

工作台、屏幕理解、工作流、模型连接、设备管理与运行历史采用同一套页面标题、边距与交互规范。截图和真实 Electron 联调沿用现有测试，另检查 1060×720 最小桌面窗口的可用性。发行物为 `release/Coloop-0.3.0-Windows-x64.exe`。

## 0.2.0 界面与品牌更新

使用 frontend-design skill 调整整体视觉、导航、任务画布、表单与设备示意图；基于 coolen 的字母结构设计 Coloop 标志，导出 SVG、PNG、ICO 与品牌预览。数据模型、设备与云端协议保持兼容。

TypeScript 与生产构建通过；真实 Electron 的 10 项通用联调通过，覆盖六页导航、凭据加密、模型调用、任务取消、离线 OCR、结果附加、截图和历史导出。此次界面更新没有额外运行板端推理。六个页面均生成截图做视觉复核，位于 `.qa/page-*.png` 和 `.qa/workspace.png`；最终 Windows 程序为 `release/Coloop-0.2.0-Windows-x64.exe`。

## 自动检查

- TypeScript：renderer、preload、主进程与测试均通过。
- Vitest：4 个文件、21 项测试通过。覆盖三种模型协议、中文分块 SSE、结束事件、空结果、HTTP 错误脱敏、重定向策略、凭据隔离与删除、存储恢复、任务取消、并发互斥、OCR 失败阻断、组合上下文、写盘失败回滚、shell 转义，以及 SSH 指纹验证。
- SSH 测试启动本机临时服务器，验证正确指纹可连接，错误指纹在密码认证前被拒绝。
- npm audit：0 个已知漏洞。初始 Zod 3 依赖已升级到 4.6.7 后重新测试。
- Prettier 与 `git diff --check` 用于最终格式检查。

## 桌面联调

`tests/e2e.mjs` 在独立 `.qa/profile-*` 资料目录运行，不写入实际工作区配置。模型服务使用临时环回 HTTP/SSE 测试服务器，不向云端发送屏幕或消耗账户额度。

11 项场景通过：

1. 真实 Electron 启动与 preload 调用。
2. 六个页面导航与渲染。
3. Windows DPAPI 实际加密测试 Key；磁盘没有明文，公开接口没有 Key。
4. 界面保存模型设置、测试连接与 HTTP SSE 任务完成。
5. 任务取消后保持 cancelled。
6. 已安装 RapidOCR 对真实测试 PNG 做离线中英文识别，验证 `COLOOP`、`128.50` 与 `本地`。
7. OCR 结果附加到任务。
8. 原生桌面截图，返回 2560×1440 图像。
9. 经 USB RNDIS 和固定指纹 SSH 读取真实 LubanCat-4 健康数据。
10. 没有 renderer 运行时异常。
11. 导出真实历史 JSON 文件，记录数与任务数一致。

开发运行与 `release/win-unpacked/Coloop.exe` 打包程序均已通过桌面联调。截图保存在本机 `.qa/workspace.png`、`.qa/ocr.png`、`.qa/device.png`，逐页查看并修正了 OCR 叠加层的布局。

## USB 实机结果

- hostname：`lubancat`。
- compatible：`rockchip,rk3588s-lubancat-4-v1 rockchip,rk3588`。
- 内存总量：15962 MB，约 15.6 GiB。
- 可用内存：约 15600 MB。
- 温度：多次读取约 36–44°C。
- Qwen3.5-9B 文本模型文件与运行入口存在。

这些是该次读取结果，不是固定产品性能指标。没有在本次验收中执行 Qwen 推理、修改板端环境或发送桌面键鼠动作。

## 未覆盖范围

- 正式云端账户、付费额度与服务商可用性，需要在界面配置自己的 Key 后测试。
- 多屏混合 DPI 下的物理点击坐标映射、HID 硬件协议、自动点击和跨应用流程未实现。
- 没有用下位机完成通用模型质量验收；现有 RK 算术测试有未通过记录。
- Windows 其他电脑、长期稳定性、安装签名与自动更新未做验收。portable 程序仍需要本机现有 RK OCR 环境。

## 2026-10-29：0.8.0 Agent 协调

新增独立的本机回环鉴权接口、「Agent 协调」页、规则筛选后的 RK 判断和 OpenCode 待处理请求适配器。当前自动回复明确的安全单项选择和权限拒绝；读取 allow 保留建议，原因 `UNVERIFIED_AGENT_DATA_ROUTE`。通用 API 不执行动作，Codex 桌面原生审批尚未接入。

- TypeScript、生产构建、Prettier及97项单元测试通过，其中54项协调核心测试；包括私密能力/响应头、共享模型互斥、路径/扫描预算、幂等、重试、迟到和失效决定。
- `D:\RK\tools\tests\test_coloop_agent.py`：22项本机 HTTP 测试通过；实际消费测试包含 fake OpenCode 服务，单独计证。
- 原有真实Electron回归通过：七页面、DPAPI、云端协议fixture、取消、RapidOCR中英文、OCR附加、桌面截图及历史导出。未调用付费账户。
- `D:\Coloop\.qa\coordination-1793286374262/results.json`：实际 Electron/SSH/NPU，安全选项选择及模拟 pending 消费通过，1440/1060宽度无横向溢出。
- `D:\Coloop\.qa\coordination-1793287026119/results.json`：进一步通过真实 OpenCode 1.19.5 会话。证据 `D:\RK\logs\coloop-real-opencode-1793287042732/`：实际模型调用 question 产生 pending，Coloop/RK选中原有离线标签，适配器复查并提交一次reply，question工具completed，pending消失，最终回答含该选择。已删除本次独立session并终止自有临时进程。
- 同轮仅合成数据、仅question工具，模型服务3条新请求均为metadata-only，worker日志新增0字节。实际模型为Qwen4B/16K/Runtime1.3.0，未换模型库。另一个随机串隐私实测见 `D:\RK\logs\coloop-coordination-20261029-225344/`。

第一轮NPU合法返回defer，提示明确离线优先后新轮通过；失败审计仍在先前隔离目录，未作为通过记录。真实OpenCode样例是受限合成问题，不能外推为通用开发成功率，也未证明上游选择标签后的任意数据传输行为。日志保护是请求级能力；其他普通任务、其他Agent会话与历史备份未整体脱敏。

已生成 `release/Coloop-0.8.0-Windows-x64.exe`（112775600字节），SHA256 `bfa7bebfae0e6b020e90b7330a669a51178c96b8b48d430c97ae9d4e06240ac0`。同包的 `release/win-unpacked/Coloop.exe` 实际启动、鉴权、敏感路径拒绝、双尺寸页面及正常退出删除凭据验证通过，结果 `.qa/coordination-1793287404037/results.json`，没有重复硬件推理。首次直接把portable包装器交给Playwright未能接入调试管道而超时；该轮不计通过，测试自身残留的失效会话连接文件已移除。自动化应指向unpacked可执行文件，portable保留为正常启动分发物。输入源码与打包摘要见 `D:\RK\logs\coloop-real-opencode-1793287042732/run-manifest.json`。
