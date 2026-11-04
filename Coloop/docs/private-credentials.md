# RK 私密凭据与 Coloop 专用登录

2026-10-30。用户确认：精确保存账号密码，不摘要、不加入普通记忆；云端只能引用非秘密编号；本地校验登录目标后经 RK USB HID 填入；回包、记录和屏幕观察不能携带凭据。允许目标登录网站接收用户提交的登录信息，首版使用 Coloop 专用窗口。

后续按用户要求整合为 **RK 统一记忆系统的私密分区**：Mem0 `private_refs` 集合索引记录编号、网站、`rk-vault://` 位置与 Coloop 本地执行器，原有记忆查询/自动召回及新增 `lookup_private` 都能发现引用。受保护库是该分区的正文存储后端，正文不进入普通事实、提取或摘要；“正文不进入 Mem0”不表示设备无法通过记忆找到它。索引按权威目录同步，不要求用户再手工登记普通记忆，删除/不可用后不返回旧引用，普通记忆不能覆写它或据此获得执行授权。桌面也已合并为单一「记忆」管理入口；旧独立凭据包兼容板端接口，但没有新版统一页面。

完整OpenCode/NPU查询已严格通过：`D:\RK\logs\private-memory-final-20261030-155915/report.json` 25项，实际memory工具完成，整段精确返回未知locator与resolver，退出0，约39.96秒，正文未进入模型。首轮超时、错误工具／JSON／SDK内部ID以及155332子串误验收的撤销审计均保留；详见 [RK专题](../../RK/docs/22-private-credentials.md)。这不代表自动登录公网网站通过。本阶段管理UI沿用原窗口/HID实现。

## 使用

2026-10-30 按用户最新要求暂不启用系统防截屏：当前程序为 `release/remote-visible-20261030/win-unpacked/Coloop.exe`，`start.cmd` 优先启动本版。主目录、私密填写与私密登录窗口均可在远程画面中显示。账号密码仍在独立、隔离且禁止网络访问的私密填写窗口输入，主页面不提供明文字段或创建通道，并保留关闭填写窗口入口。关闭时清理临时会话，在途保存结束前持续暂停 Coloop 自身观察。

先在「设备管理」连接 RK，再打开「记忆」。同一搜索框和列表支持「全部／普通记忆／私密记忆」分类；点击「新建记忆」选择类型。普通记忆填写名称、内容及类别，可编辑并保留历史版本，编辑后为未核实；删除清理同键版本，不恢复旧值。私密记忆点击「打开私密填写窗口」，在独立窗口填写允许的网站源（如 `https://example.com`）、账号与密码，点击「保存私密记忆」，成功后「完成并关闭」。网站源必须是规范的 HTTPS origin，不包含路径、查询、片段、用户信息或默认的 `:443`。账号密码逐字保存，首尾空格也保留；目前每个字段限 1–64 个可打印 ASCII 字符，不支持中文、换行、Tab。

私密项只显示网站和 `rk-vault://` 引用，不显示账号或密码。搜索先跨两类匹配字面内容，无字面结果才列出本地BGE语义候选。点击私密项的「本地使用」，在专用窗口导航到登录表单，点选账号框，再点工具栏「填入账号」；密码同理。需使用美式英文键盘并关闭 Caps Lock，松开 Ctrl/Alt/Win 等修饰键。每次只追加一次输入，程序不自动清空原字段、不自动重试、不提交登录。填入完成与网站登录成功是不同结果。私密正文没有查看／导出／修改接口，需删除后重建。

当前从用户在 Coloop 的按钮触发，尚未将自动登录作为云端模型工具开放。后续规划层可以引用编号，仍不得获取或要求模型生成明文凭据。普通聊天、已有历史和用户自行粘贴的文本不会因此被追溯清理。

## 存储和进程

管理层使用 `MemoryManagementService` 和现有固定指纹SSH，普通记忆经固定 `/usr/local/lib/rk-credential-vault/credential_memory_client.py` 转发至原Mem0鉴权服务；私密正文仍只走原凭据提供方，之后只发 `sync_private`。Mem0的browse输出严格区分两类schema，私密项拒绝text／username／password。管理API没有加入模型MCP枚举。目录不可用时保留已经成功保存的凭据并提示刷新，不自动重试保存。

板端安装入口为 `D:\RK\rk-opencode\scripts\setup-memory-management.py`，更新Mem0来源并安装固定客户端；保留编号备份，不改模型、USB或重启凭据服务。统一管理整页使用原观察保护，要求其他任务空闲，离页且专用窗口关闭才解除。

`rk-credential-vault.service` 是独立板端服务，通过 `/run/rk-credential-vault/service.sock` 接收有限 JSON；不监听 TCP，不调用模型、Mem0、嵌入或云端，不修改模型库。使用系统 `/usr/bin/python3 -I` 和已安装的发行版 `cryptography 3.4.8`，未改动现有虚拟环境或安装新依赖。

数据目录 `/var/lib/rk-credential-vault` 为 root 所有、0700，密钥与 SQLite 为 0600；普通 `cat`/OpenCode 文件读取无法访问。账号和密码作为一个 Fernet 密文保存，并在受认证的内容里绑定记录 ID 与网站源，拒绝交换密文行。密钥同机保管，因此不构成硬件密钥隔离或对 root 的保护。默认最多100条。删除取消后续查找，旧备份和磁盘物理擦除不在该接口承诺内。

接口只有 `status/list/create/delete/fill`，没有 `get/export`。对外的记录结构严格限 `{id, origin, createdAt}`。输入和错误不写日志，异常只返回固定代码。Coloop 通过已有固定指纹 SSH 会话运行固定客户端，数据进入 stdin，不进入命令参数、Shell、模型请求、任务历史或普通记忆。操作系统管理员、拥有可信本地执行权限的程序以及已被攻破的 Coloop 不在这一应用权限边界之外被保护。

## 登录窗口和观察

可信工具栏与网站使用分开的 WebContents。网站无 preload、无 Node、启用 sandbox/contextIsolation/webSecurity，拒绝权限请求、下载、弹窗及跨源导航/网络请求。仅允许记录绑定网站的同源 HTTPS 资源；第三方脚本、验证码、SSO、外部登录弹窗与部分复杂网站因此可能不可用。此规则限制流量目的地，不证明获准网站的代码或服务器如何处理用户输入。

网站使用一次性的内存 session，关闭后清理 Cookie/缓存等数据，不复用普通浏览器会话。信任的主进程从实际 URL 校验 origin，仅对主框架中可见、可编辑、已聚焦的 input 填入；密码只能进入 `type=password`，账号限 `text/email/tel`。主进程在 isolated world 保留目标元素引用，检查只返回布尔值，从不读取或回传字段值。

Native helper 只处理窗口句柄和键盘元数据，每次填入前检查 Windows 实际前台、键盘布局、Caps Lock 与修饰键；过程中继续检查原窗口、URL、原输入元素及焦点。主机每65毫秒尝试续租，板端在每个 HID 报告前检查最多300毫秒的有效心跳。请求 UUID 在首次按键前消费，断连、失焦、超时不重放，按键结束或错误尽力发送全释放报告。真实硬件输入不是事务；焦点/调度故障可能留下部分输入，检查与发送间存在竞态，不能保证切换瞬间零字符误投。结果不确定时要求用户检查，不能描述成成功或自动补发。

进入记忆页前要求其他任务、OCR、审批和受管控制空闲；表单在保护成功前禁用。记忆页、私密填写或登录窗口存在期间，Coloop 清空旧 capture 引用，拒绝本应用的截屏、导图/OCR、模型任务及新会话控制。当前不启用系统窗口内容保护；挂起/锁屏关闭私密窗口。在途保存或 HID 没有结束前保留观察保护。保护范围是 Coloop 自身流程，不是全系统 DLP；不控制独立录屏软件、其他云端 Agent 的观察通道、登录站点行为或管理员权限。手工拍照、系统内存与物理擦除没有保证。

## 部署和验收

板端源码和可重复安装器在 `D:\RK\rk-opencode\agent/credential_{vault,client}.py`、`scripts/setup-credential-vault.py`。从 RK 根目录使用既有 `.venv` 和会话级 `RK_BOARD_PASSWORD` 执行安装器。只安装 `/usr/local/lib/rk-credential-vault` 的固定代码与一个 systemd unit，保留编号备份，复用既有桌面 HID 锁，不重新配置 USB、系统代理、内核或模型。回退可停止/禁用该 unit；保留数据目录，勿把它加入仓库。备份需以管理员身份在服务停止后保存整个目录（包含密钥），离线妥善保管。

2026-10-30 实际安装证据：`D:\RK\logs\credential-vault-deploy-20261030-135035\manifest.json`。Linux 5项专项测试通过，既有 HID 2项、桌面4项回归通过；本轮初次 Coloop 全量403项通过，最终全量数量以最终构建记录为准，不能把并行功能测试都记作本功能新增。

真实硬件验收：`.qa/credential-vault-1793340008295/report.json` 七组检查通过。使用真实 Electron/WebContentsView、真实 SSH/根服务/USB HID 和内置 HTTPS scheme 合成页面；完整账号与含空格、大小写、引号、反斜杠的密码逐字一致。中途切换前台后部分输入停止并报告结果不明。元数据回包无秘密、网站没有 Node/privileged bridge、跨源导航拒绝、截图/OCR/模型/控制拒绝、没有云调用、Mem0 状态不变、模型请求和 worker 日志新增0字节，普通用户不可读库/密钥。没有真实网站、真实凭据、付费云账户或 NPU 推理；不代表通用网站成功率。

初期失败记录保留在 `.qa/credential-vault-1793339610897`、`1793339705931`、`1793339748603`、`1793339812266`、`1793339869558`。分别为标签定位、页面加载时序和测试窗口非真实前台的保护拒绝。最终由 computer-use 激活已核对的合成窗口，未移除原生校验。没有将失败运行当作完成或改变既有 Mem0/HID 历史记录。

```powershell
# 不包含实机的常规检查
npm run typecheck
npm test
# 已授权专用合成窗口、提供会话级密码后运行真实硬件验收
npm run test:credentials
```

实机测试需要对应窗口真正处于 Windows 前台；CDP/Playwright 逻辑焦点不足时会被拒绝。可设置 `COLOOP_CREDENTIAL_PAUSE=1` 等待测试目录中的 `continue` 文件，先用正常系统窗口激活工具激活测试窗口。只使用合成凭据，不要为测试关闭保护或把真实密码写入测试脚本。

## 独立交付

新版统一记忆程序冻结于 `release/memory-20261030165137/`，portable 为 `Coloop-0.12.0-memory-Windows-x64.exe`，126374591字节，SHA256 `e3ab86e4b193f67e6a1bc5aa9aa7d302b77b08097d407268ce56d06d9a32ea73`；解包目录 `win-unpacked/Coloop.exe`。请先退出旧Coloop再运行；没有改写现有安装版或 `start.cmd` 默认入口。包内编译文件、附加资源及运行依赖按 `memory-manifest.json` 校验；app.asar摘要见该清单。本节后面的旧credentials包记录仅保留历史。

最终打包版真实板端流程 `.qa/memory-management-1793350369301/report.json` 16项通过：两类新建、共同搜索与分类、普通编辑和两类删除、专用窗口打开、观察／模型拦截、离页释放保护，以及1440×940／1060×720界面检查。实际扫描16个生产Mem0文件及70个已关闭的Coloop profile文件，没有本轮合成账号密码；原普通事实与队列不变，本轮cloud调用0，模型requests／worker日志增量均0字节。源码修正后的同项16项在 `.qa/memory-management-1793350325061/`。未重跑真实USB输入、NPU规划或公网登录。

首个memory包 `memory-20261030164302` 运行依赖漏包、启动失败（`.qa/memory-management-1793350051301/`），不交付。安装目录junction使打包依赖收集返回undefined版本，现已改为按已安装版本冻结生产依赖闭包，不联网、不改全局node_modules。最终验证器按固定版本electron-builder实际转换结果校验package元数据，并记录其嵌套依赖提升后的路径；JS入口与编译文件逐字节匹配。原始失败产物保留，未通过跳过缺失依赖或忽略JS差异来验收。

本次真实SDK管理检查在 `D:\RK\logs\unified-memory-sdk-20261030-164144/report.json`，27项通过，覆盖两类浏览、分页、搜索、版本／TTL、删除不复活与32个存储文件无合成秘密。14项Python相关测试和Ruff通过，Coloop全量502项通过（含并行模块）。源码界面流程 `.qa/memory-management-1793349671356` 已完成共同管理与专用窗口打开、两尺寸目视检查；该轮存储扫描实际0文件，audit明确不采信该项，修正后的测试要求实际文件数大于0。两轮小窗口溢出失败保留。最终打包版真实板端流程见后续补充记录，不把旧七组USB测试当成本轮重跑。

新页／CSS的Impeccable检测无主要问题，有一项沿用灰阶标签8px圆角的建议项（`.qa/memory-design-detect.json`），没有扩展重设计。

本次构建冻结于 `release/credentials-20261030140855/`。工作区存在并行的0.12手机接入更新，本包版本沿用0.12.0；凭据专题不把其他功能测试或能力计为本功能新增。没有覆盖安装版、旧release或既有 `start.cmd` 优先项。

- Portable：`Coloop-0.12.0-credentials-Windows-x64.exe`，126487471字节，SHA256 `56a469a81b0d3fad7e98c9084cdc26324395cba8380421bd29870a683837934f`。
- Unpacked：同目录 `win-unpacked/Coloop.exe`。退出已运行的旧Coloop后再打开本版，避免单实例机制只激活旧窗口。
- `credential-manifest.json` 保留冻结编译文件逐项SHA及资源校验；app.asar SHA256 `75c10abac898045385be272ba857a62a863bf751635d6d70e82d7a558ba1ef1c`。PowerShell原生焦点脚本等资源与冻结输入匹配。
- 打包版实际启动、凭据页、断连禁用、1440×940/1060×720无横向溢出及退出页面释放保护通过，`.qa/credential-visual-1793340764986/report.json`；最终界面已目视核对。源码同项复核在 `.qa/credential-visual-1793340533440/`。常规最终全量485项通过，包含其他并行模块。
- 板端ARM64/系统cryptography再次运行5项专项测试通过，且已部署的3个Python文件SHA与维护来源一致，证据 `D:\RK\logs\credential-vault-board-tests-20261030-141148/`。真实USB七组验收来自前述开发运行，打包版复核为界面/资源和相同冻结实现检查，未重复宣称打包版公网登录或全系统安全验收。

`scripts/package-credentials.mjs --memory` 冻结 out、资源和已安装生产依赖后独立打包，并核对包内文件，避免其他任务更新 out 后混入产物；不加参数仍生成历史凭据包命名。首次旧包验证因asar工具在Windows要求本机路径分隔符而失败，修正验证器后对同一既有包重新校验通过，没有忽略缺失文件或以进程退出0代替内容校验。没有发布、推送或同步发布副本。
