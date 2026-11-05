# 云端规划与 RK USB 转达试验

2026-11-02后续：当前入口已更新为`rk-agent-state-0.13.0-20261102`，补齐RK输入回执/原子状态、未知结果停止、阶段不重放、首页独立流程记忆和近期执行上下文。真实RK/云端/Mem0/USB的独立实验窗验收通过；它采用合成浏览器语义投影，不能当作新版B站业务验收。最新源码与记录见 [RK Agent说明](rk-agent-gateway.md)，下方迁移及B站耗时为各自历史版本。

2026-11-02当前入口：`start-cloud-hid.cmd` 已指向 `rk-agent-gateway-0.13.0-20261102`。Agent上下文、严格云JSON校验、流程/当前控件绑定和Mem0读写迁到RK，与原生USB运行在同一Python进程；上位机提供联网转发、云Key与Windows观察/守卫。实测三连完成65.415秒，详细分工、失败、复盘修正与记忆验收见 [RK Agent与联网网关](rk-agent-gateway.md)。以下早期方法和耗时保留为历史，不代表当前默认。

2026-11-01，Asia/Shanghai。独立入口 `start-cloud-hid.cmd`，当前只启动 `release/cloud-hid-agent-0.13.0-20261101/win-unpacked/`。按用户最新要求采用纯鼠标、同窗口操作，缺少UI目标时停止，不回退旧命令行构建。云端默认语义流程模式，详见[Agent选型与实现](cloud-ui-agent.md)。下文保留各阶段历史结果；其他默认启动器未替换。

在上位机连接既有 RK、配置真实云模型并开启原有手机连接后，从已配对 Android 的任务消息发送 **打开 Bilibili**。也支持“打开B站”和“帮我在电脑上打开谷歌浏览器，然后进入Bilibili网站”。不需要另选已有窗口或填写完成文字。沿用原有手机协议、鉴权、加密、任务去重和停止；本轮没有修改 APK。

RK 先理解目标，上位机 Agent 附带 Windows、USB HID、ASCII、完成条件及历史流程背景交给云模型。云端只可返回 `open_browser` 和固定 `https://www.bilibili.com`。RK 选择 `chrome_bilibili_v1` 模板，运行时严格核对模板展开后的四步：Win+R、Ctrl+A、输入 `chrome --new-window https://www.bilibili.com`、Enter。任意 URL、额外动作、登录和提交不在此试验能力内；不会执行云端代码或 Shell 工具。

Windows 配套进程只读取 HWND/PID、真实进程、焦点、UIA 与 OCR。RK 通过安装好的原生 `HIDController` 写 USB 设备，每个非释放报告都有守卫；任务持有既有 `hid.lock`，包含停止、12秒心跳、600秒预算、80℃保护和原生按键释放。Run 框须为 Explorer 的真实 Edit；Enter 前逐字回读启动文本。初始已有对话框、焦点变化、USB错误、已消费许可均拒绝；可能发生输入的错误不自动重放。窗口检查与硬件报告间仍存在竞态，并非系统级隔离。

只核验本任务中新打开的唯一 Chrome 窗口，绑定 HWND/PID，依据浏览器工具栏中位于 web Document 之上的唯一 Edit 读取地址，精确主机名、首页路径、Bilibili 标题及至少两个页面导航标签共同验证。输入后只读核验允许 Chrome 已在后台，此时只使用该窗口 UIA；前台时额外 OCR，捕获前后再次确认前台，变化时丢弃 OCR。浏览器窗口标题可变化，旧的单窗口执行器边界没有放宽。

按用户此次要求，普通浏览器 UIA/OCR 内容可以发送云端，本试验没有自动脱敏。没有开放凭据正文、登录或普通记忆接口，原有私密窗口观察互斥继续生效。不要将本试验表述为 DLP 或隐私识别能力。

任务实际验证后再发云端 review，保存中文总结、操作种类、真实回执和限制。上位机 `%APPDATA%/coloop/usb-procedures/` 保存每次 `episode-*.json` 与可更新索引 `open-bilibili.json`；RK 在 `~/rk-opencode/logs/cloud-hid-procedures/` 保存独立记录。云端总结标为未核实建议，不进入 Mem0 个人事实。下次同任务仍由云端确认目标，只有历史动作与当前固定模板完全一致才复用，省掉 RK 模板选择推理；窗口、Run框和每报告守卫照常重新检查。它是程序化流程积累，不是模型权重训练。

## 实测

固定原始证据在 `D:/RK/logs/cloud-hid-relay-20261101-live-9/` 和 `...-10/`。两轮都使用真实 DeepSeek 账户、既有 Qwen4B NPU、RK USB、实际 Chrome/Bilibili、UIA/OCR 和真实云端复盘。通过生产 `VioloopService.submit` 输入同一任务消息；**没有使用物理手机或本轮公网手机传输**，原 Android 通道只能沿用此前验收，不冒充本轮实机证据。

| 项目                          | 首次（9） | 复用（10） |
| ----------------------------- | --------: | ---------: |
| RK 调用，包含任务理解         |         2 |          1 |
| 真实云端调用，规划/总结各一次 |         2 |          2 |
| USB 模板动作                  |         4 |          4 |
| 每报告守卫                    |        47 |         47 |
| 运行时，含云复盘              |  22.042秒 |   15.675秒 |
| 含任务理解的服务总时间        |  34.898秒 |   28.809秒 |

第二次明确携带1条历史流程，省掉了一次约6秒的RK模板选择。两轮间还修正 Windows 管道 UTF-8 编码，不能视为严格耗时 A/B，也不能推出通用提速倍数。首轮云总结提到乱码，原样保留；第10轮中文 UIA/OCR 正常。`procedure.json` 是固定快照，`procedures/open-bilibili.json` 是该轮生成的索引，未改写前轮结果。

失败保留：1为测试启动器顶层await阻塞Electron ready，未发云/输入；2～4为提示缺少JSON字样导致DeepSeek400，零输入；5～6为旧RK抄写启动文本多一空格而拒绝，零输入；7～8已经发送四步并打开网页，但旧核验器地址栏名称/重复标题不兼容，整体失败，未自动重放。后续改为RK选择有限模板，以及句柄绑定和工具栏位置校验。9/10为独立新任务，不覆盖这些失败。

548项应用测试、19项原桌面Python回归、4项新浏览器边界测试通过；类型检查、构建、Ruff及Python语法通过。NPU/USB真实验证与单元测试分别记录。模型、运行库、USB描述符、Mem0和默认模型服务均未替换，最后核对原worker仍在、HID锁已释放。

源码入口：`src/main/services/cloud-hid-relay.ts`、`violoop.ts`、`desktop-tasks.ts`、`resources/browser-runtime.py`、`browser-observer.py`。显式真实复验：进程中提供 `RK_BOARD_PASSWORD` 后运行 `node tests/cloud-hid-live.mjs`，会使用已保存云账户和真实USB。它不由Vitest自动运行，也不自动重试输入；可用 `COLOOP_RELAY_SEED` 指定已验证的 `procedure.json` 进行第二次复用。

打包核对另存 `D:/RK/logs/cloud-hid-relay-20261101-work/`：资源SHA256一致，最终发行物启动后真实RK/已保存云账户就绪、手机relay在线、Violoop可用。首次启动过早读到的未就绪快照单独保留为package-startup.json，完整等待后的结果为package-ready.json。已启动本独立试验版并保留运行；默认启动器未替换。已验证的公开Bilibili流程从第10轮复制到默认流程目录，来源与摘要见procedure-install.json，未写普通Mem0记忆。最终打包后未再次执行USB任务；最后微调为HTTPS边界、观察字节统计及停止/复盘错误处理，具体源码摘要与范围见verification.json。

## 逐步计时与进阶任务（2026-11-01）

`start-cloud-hid.cmd` 现在优先启动独立 `release/cloud-hid-timed-0.13.0-20261101/`。支持“打开bilibili，点击主页的一个任意视频，然后三连点赞”。实际已对BV1vZxi68E2p完成点赞、投1枚币、默认收藏夹收藏并核验；通过多轮调试和显式继续完成，未声称新版本单遍完整验收。最终UIA三态与截图、每步耗时及失败见 [RK专题](../../RK/docs/27-cloud-hid-relay.md) 和 `D:/RK/logs/cloud-hid-advanced-20261101-work/report.md`。

上位机/板端每一步分别记单调时钟耗时、UTC开始结束、success和主机；正常统计与失败单列，调用返回成功与业务核验分开。数据文件为每任务step-timings.jsonl/normal-timings.json。新源码还有step-timing.ts，普通手机任务同样记录窗口枚举和RK理解。三连的所有输入仍为RK原生USB，未使用Windows软件输入、浏览器点击API或站点互动API。

账号登录由用户自行完成。已生效操作跳过；投币确认必须读到1枚并在输入守卫重新核对；只选默认收藏夹。动态目标由本次UIA身份、矩形、前台和命中拓扑约束。图标状态识别限定当前默认主题，未知就停止。可选resumeVideo只在明确视频三连任务中使用，需真实HWND/BV且重新核对实际进程/地址；没有后台自动重放。

## 单次连续耗时复测（2026-11-01）

重新发送完整三连任务，产品源码未改，未显式恢复旧任务：新视频BV1LNxr63Eoz、12动作、63守卫，三态/云复盘通过。任务服务收到命令到结束63.821秒，其中三连核验前60.569秒、总结与收尾3.252秒。已登录、模型驻留、复用启动模板；不含实体手机网络、Electron/SSH准备。每步原始时序与边界见 `D:/RK/logs/cloud-hid-singlepass-20261101-run-1/report.md`，这才是一次连续样例，不将前次调试时长拼接成它。

## RK Mem0与前台恢复（2026-11-01）

`DesktopProcedureMemory` 使用现有鉴权服务，在真实板端Mem0 OSS2.2.1写入固定键 `procedure:coloop:bilibili-triple:v1`，kind=procedure、source=agent、verified=false。内容包含固定操作顺序、重新观察/窗口绑定/1枚币/跳过已生效项/未知输入不重放等约束、证据来源和明确计时范围。云复盘后只有三态均true才回写；最新版本同时保存最多160字的云摘要及2条各60字经验，`cloudSummaryVerified=false`。摘要可能截短，只是背景，不能改变代码白名单或执行权限。

先将此前完整成功流程写入，再通过独立SSH/Python会话get及语义search验收。新任务先重新get：精确已支持任务和配方命中时由主机选择已有browser_relay能力，省去RK理解推理；未命中/删除/不可用时不使用旧值，保留普通RK理解。云规划前再读一次，将来源和未核实标记作为背景发送。源码入口增加 `desktop-procedure-memory.ts`，板端仍复用原MemoryClient，没有更换记忆后端或模型。

新完整任务 `BV1AAsX6EEKQ` 从头连续执行：**50.324秒**，此前63.821秒，减少13.497秒（21.1%）。其中命令至三态核验47.193秒，云复盘/保存/收尾3.131秒；0次RK模型、11次云模型、12动作、63守卫，三态均true。多出的云调用来自一次输入许可前命中拒绝后的新观察/新决策；没有重放已发送输入。全部步骤原始时序和正常样本统计见 `D:/RK/logs/cloud-hid-mem0-20261101-run-2/report.md`、all-step-timings.json、desktop/*/normal-timings.json。各主机用各自单调计时，不重复叠加RPC和报告守卫。

针对用户要求自行处理切窗：优先经RK原生USB点击绑定Chrome的可见已选TabItem，核对UIA身份/矩形/命中与遮挡，再核验同HWND/PID/视频；不可见时有界Alt+Tab/Alt+Esc轮转。显式继续时，若自动播放跳到其他视频，只能用地址栏恢复本地绑定BV，键入前核对焦点，Enter前逐字回读精确HTTPS URL。地址栏小型Document节点不再参与网页主视口判定。全程未使用Windows软件输入/激活API或站点互动API。

失败40.931秒的run-1及resume-1～4单独留存，不能充当提速成功样本。resume-5实际通过USB点击切回原窗口，完成原视频BV1QHsX6NEUL剩余互动并核验三态，未再次投币；34.585秒仅为剩余任务恢复时间。最终50.324秒来自另起的run-2，未恢复旧任务、未人工切换。当前两配置各1个成功样本，还包含前台/地址识别和许可前再观察改进，不能把全部差值归因于Mem0或保证固定速度。仍已登录/模型驻留，不含实体手机网络和Electron/SSH准备。

最终独立发行物 `release/cloud-hid-memory-ready-0.13.0-20261101/` 已启动；556项Vitest、16项浏览器Python检查、类型检查、构建和Ruff/语法通过。打包主程序/资源SHA256与源码产物一致，RK/云账户就绪、手机relay在线、Violoop可用。最终包输入资源与run-2一致；复测后新增的云摘要记忆字段做了真实Mem0写入和独立会话回读，未再重复账号互动。当前记忆ID为 `6570b42b-9192-4315-bba9-ba6e300fd532`，后续同键写入可换版本。证据：`D:/RK/logs/cloud-hid-mem0-20261101-work/independent-final-readback.json`、package-ready.json、package-hashes.json及verification.json。原worker PID2207仍在、HID锁空闲。

## 同一浏览器内纯鼠标（2026-11-01，当前默认）

用户要求取消命令行打开方式，改为直接点击软件，并在同一浏览器里鼠标操作。当前固定能力为 `chrome_bilibili_mouse_v1`：新鲜UIA观察任务栏Chrome图标→RK USB点击恢复既有唯一Chrome→点击其已有Bilibili首页TabItem→地址和页面核验→云端选片与三连。全程绑定同一HWND/PID，视频可打开同窗口的新标签页；不承诺同一标签页。每个点击仍校验UIA身份/矩形、实际进程、前台和命中拓扑，非释放USB报告逐次守卫。窗口已在前台时跳过任务栏点击，避免将其最小化。

当前范围要求一个已运行Chrome且有可见的Bilibili首页标签。多个窗口、首页标签缺失或遮挡会停止；尚未覆盖任意起始页面的纯鼠标导航。切回只允许点击已选可见标签，取消Alt+Tab/Alt+Esc和地址栏键入恢复。旧permit/navigation_permit明确拒绝，RK运行时也拒绝非click许可；不使用Windows输入/激活API、浏览器点击API或站点互动API。

云端规划必须返回 `method=mouse_same_window`，RK选择新能力；主Agent提示也同步鼠标/已有目标约束。流程索引改为 `open-bilibili-mouse.json` / `bilibili-video-triple-mouse.json`，Mem0使用独立键 `procedure:coloop:bilibili-triple:mouse-v1`、capability=bilibili_video_triple_mouse_v1，增加mouse_only守卫。旧记录只保留历史，不读入当前流程。新记忆保留source=agent、verified=false、云复盘未核实标记和来源，不存旧坐标。

真实进阶任务：**BV13Nxq6REre**，原Chrome HWND723406/PID42264保持；10次USB鼠标点击、20次守卫，点赞、投1枚币、默认夹收藏三态true。初次新流程2次RK模型、12次云请求，命令提交至业务核验64.550秒、总结/记忆/收尾4.247秒，总计 **68.797秒**。未使用旧配方，不能与之前50.324秒的记忆命中样本归因比较。三连完成后测试驱动仍按旧索引导出而退出1；failure.json原样保留，正确文件原字节补充导出，未追加互动。随后修正驱动，仅打开首页的新任务 **37.713秒**、2次鼠标点击、4次守卫，进程/业务/云复盘/导出均通过，未再次投币。

证据固定目录：`D:/RK/logs/cloud-hid-mouse-20261101-run-1/`、`...-home-1/` 和 `...-work/`；每步时序、成功样本统计、导出恢复、云复盘、同窗口身份和限制分别见report.md、verification.json、all-step-timings.json、desktop/*/normal-timings.json。均经生产手机任务服务，未使用实体手机/公网手机传输，已登录/模型驻留，包含开始等待，不含Electron/SSH准备。

新流程/云复盘已真实写入RK Mem0并在独立SSH/Python会话get及语义search读回，本次ID `e0893dfe-dced-4d4e-8780-e1f5b094be23`。556项Vitest、19项浏览器Python、类型检查、构建和Ruff/语法通过；最终鼠标版源码与首页实测manifest一致，打包主程序/输入资源SHA256匹配，已启动且RK/云账户ready、手机relay在线。最终包未另做账号互动；模型/运行库未更换，原worker2207与空闲HID锁核对通过。

### 缩短固定等待与RK耗时归因（2026-11-01）

按用户要求，点击后的settle从700ms改为100ms；10次点击的配置等待由7秒降至1秒，理论减少6秒。实际页面未就绪时仍由既有只读观察/核验循环按需等待，未修改超时、报告守卫或重放策略，不承诺总耗时必然减少6秒。只更改browser-runtime.py这一处参数，19项相关Python检查、语法和Ruff通过。

本次实际复验 `D:/RK/logs/cloud-hid-short-wait-20261101-home-1/` 在RK意图JSON多出message字段时被严格校验拒绝，零云端/零USB；26.578秒失败耗时原样保留，不计正常样本。当前Chrome也已关闭。本轮未新增完整三连或100ms下的USB成功样本。独立fast发行物沿用已验证的mouse主程序和资源，仅替换源端维护的Python运行时；哈希及启动检查通过，已启动且RK/云/手机relay就绪，旧版本保留。

此前6.659秒的RK流程选择调用，板端metadata-only原始记录匹配为177输入token、13输出token：prefill3459.856ms、generate2670.817ms，其余接口/租约/传输等合计约528.685ms；finish_reason=stop，未用满32输出上限，kv_before=0。原驱动未保存响应ID，按独有2896字节理解请求及紧随604字节选择请求的相邻序列匹配，未跨端相减墙钟。证据与限制在 `D:/RK/logs/cloud-hid-short-wait-20261101-work/report.md` 和original-rk-perf.json。

### 100ms与记忆命中后的第二次完整实测（2026-11-01）

用户要求再次运行同流程。正式新任务连续成功 **42.912秒**，首次68.797秒，减少 **25.885秒（37.6%）**；业务核验前39.716秒，云复盘/记忆/收尾3.197秒。新视频BV1j3x16XEuR，原Chrome在本次内保持HWND7079868/PID42476，完整10次鼠标动作和20守卫，点赞、投1枚币、默认夹收藏三态true。真实Mem0两次命中，RK模型2→0次；点击后settle合计7.002→1.002秒。页面只读等待另计，本轮总显式等待2.002秒。点赞和收藏确认各有一次输入许可前命中拒绝，新观察/新云决策后继续，云请求12→14，没有对应点击重放。

本次源码/输入资源与已启动fast发行物一致，未改产品代码，没有额外PC模板种子。云复盘后更新Mem0到ID6145882b-62cb-40d3-88c3-08d9bb7f9ca9，并在独立SSH/Python会话get及语义search读回；未验证来源标记保持，原worker2207仍在且HID锁空闲。原始记录、分项比较和正常耗时统计见 `D:/RK/logs/cloud-hid-mouse-repeat-20261101-run-1/report.md`、verification.json、all-step-timings.json及 `...-work/comparison.json`。

开始时Chrome已关闭。正式提交前先用RK USB完成显示桌面、双击Chrome、新标签页已有Bilibili快捷方式、站内首页链接等恢复准备；每步窗口/控件/命中守卫与独立耗时见-work/prepare-*.json。这是多步准备，不能拼成一次连续准备耗时，**不包含在42.912秒里**。正式计时边界与基线一致：已有首页、已登录/模型驻留后提交命令→终态，含4秒开始等待，不含Electron/SSH准备或实体手机/公网传输。各配置1个成功样本、视频/云响应及重查不同，不能把全部差值归因于等待或推出固定SLA。

### 云端Agent优化：32.309秒（2026-11-01）

调研UFO²、Browser-use、LangGraph.js、Agent-S并核对许可证/固定revision。当前先借鉴语义规划、实时绑定和上下文投影，实现自有可插拔适配层，未安装或声称完整集成任何第三方框架。具体模块取舍、来源链接和协议边界见[云端Agent说明](cloud-ui-agent.md)。

真实新视频BV1XZxe6SEuU完成同窗口10次USB鼠标动作、20守卫与三态核验，耗时 **32.309秒**，前轮42.912秒，减少10.604秒（24.7%）。云端只做流程批准、动态选片和最终复盘，真实云请求14→3；接口报告输入token16,278→2,376（减少85.4%，包含API缓存token，非计算量/费用等比例结论）。RK仍0次模型推理；其余9个已发送动作由云方案结合新观察在本地绑定，回执明确标记来源，没有伪报逐次云模型调用。

初始方案严格限定已支持能力，不含未来目标ID/坐标。按同一任务AbortSignal、窗口身份、阶段和观察ID约束唯一控件绑定；异常/歧义仍回云端或停止。Native执行器的UIA/命中、1枚币/默认夹、每报告守卫与未知输入不重放保留。本轮一次点赞许可前重新观察重新绑定，未增加云请求。原始cloud.json、runtime.json、各步正常统计在 `D:/RK/logs/cloud-agent-optimization-20261101-live-1/`；研究、独立Mem0读回、最终包哈希/就绪验证在 `...-work/`。云复盘后记忆ID更新为3d9fb3b3-5a79-4955-bc3b-3e122f9e2671。

562项Vitest、19项浏览器Python、类型/构建和Ruff/语法通过。最终独立agent发行物已启动，主进程默认semantic-plan，核心源码与真实模式相同；打包后未再重复账号互动。计时同生产服务提交→终态，已有首页/已登录/模型驻留，含4秒开始等待，提交前“显示桌面”准备、Electron/SSH和实体手机网络不计入。不同视频与单次样本不能外推通用任务质量或SLA。

### 2026-11-02 手机“打开 Bilibili”意图解析修复

手机真实记录中，00:48:59 的“帮我打开哔哩哔哩”与 00:49:29 的“打开bilibili”均已到达 Violoop；窗口枚举和 RK 调用成功，随后在意图解析/启动前失败，没有 desktopTaskId。旧入口没有保留原始模型文本，不能断言两次原输出的逐字内容。独立真实 RK 复现返回 `kind=browser_relay` 并附加 `message`，内容还错误声称要执行三连；严格 schema 拒绝额外字段。复现是只读观察/模型调用，没有发送 USB。

修复位于 `src/main/services/violoop.ts`：完整匹配现有 isBrowserPilot 白名单、任务为 home 的请求，由主机固定路由到 cloud-hid，固定首页完成条件和最多4步，不再让生成式模型重新分类。三连原有记忆/模型路由保持；普通任务仍严格解析，未放宽额外字段、重复 JSON 键或任务授权。格式错误给出明确提示；失败和停止不自动重放。云端规划、RK 翻译/USB、窗口身份与新观察守卫继续执行，不代表通用打开应用能力。

47项相关 Vitest（含原手机中文/英文请求、去重、越界、额外字段拒绝）、类型检查和构建通过。真实生产 VioloopService 提交“帮我打开哔哩哔哩”完成，2次USB鼠标动作、首页地址/内容核验，2次云调用、1次RK模板翻译、0次RK意图推理；提交到终态22.133秒，其中业务核验19.125秒。实际 Chrome 已运行且有首页标签；本轮未由实体手机重新发起，不代表物理手机/公网全链路复验，也不扩展任意初始页面支持。

新独立包 `D:/Coloop/release/phone-bilibili-fix-0.13.0-20261102/win-unpacked/Coloop.exe` 已启动，`start-cloud-hid.cmd` 指向此包；旧agent发行物保留回退。已核对无执行中的任务，再定向停止旧主进程并启动新包；原配置、手机配对和失败记录保留。包内主程序与本轮构建一致，四个观察/输入资源与源码一致；启动后 RK就绪、Violoop可用、relay在线。此次包后只检查就绪，没有再次发送USB动作。

证据：`D:/RK/logs/phone-bilibili-fix-20261102/diagnostic.json`、`verification.json`、`package-ready.json` 和 `D:/RK/logs/phone-bilibili-fix-20261102-live-1/` 的输入、manifest、原始模型/云响应、运行时回执和分步耗时。旧两次手机任务时间来自原任务记录（Asia/Shanghai），不以新结果改写旧失败。

### 2026-11-02 意图层容错修正

手机任务的模型意图 schema 改为显式 strip：保留已知任务类型与必要参数，忽略 message/reason 等额外字段；额外字段不传给执行器，不据此展示“已完成”。这修正此前“正确 kind + 多一句说明即整任务失败”的不合理限制。用户输入授权 envelope、执行动作参数、任务范围和业务核验独立保留；未知 kind、缺失/错误必要字段及重复JSON键仍不能直接执行。没有新增任意网址、登录或三连授权。

47项相关测试与类型检查通过。使用上一轮真实RK原始输出回放，带错误三连说明的 browser_relay 现在正常归一化为单一 kind；单元测试确认普通desktop额外shell、authorizeInput和maxSteps不会传到执行器，实际参数仍由用户目标及主机策略产生。没有为解析器改动再次启动板端模型或发送USB；本轮验证为真实历史原文回放、单元/类型及发行物就绪，不宣称新增实体手机端到端成功。

源码为 src/shared/violoop.ts；测试 tests/violoop-intent.test.ts 与 tests/violoop.test.ts。工作区另有进行中的RK Agent迁移，故基于已验证 phone-bilibili-fix 发行物冻结应用，仅替换编译后五个意图对象的strict为strip，并与源码对应；其余主程序字节和观察/输入资源保留原发行物。通过electron-builder重打包并更新asar完整性，独立目录release/intent-tolerant-0.13.0-20261102；start-cloud-hid.cmd指向新包，旧包保留。正常退出旧程序后启动新包，不自动重放旧失败任务。可复现冻结/打包配置、原始manifest、模型原文回放和包验证在D:/RK/logs/intent-tolerance-20261102/；本地准备脚本D:/Coloop/.qa/prepare-intent-package.mjs，构建配置D:/Coloop/.qa/intent-tolerance-builder.json。

### 2026-11-02 安卓模拟器真实发送首页任务验收

用户手机暂不可用，改用现有安卓模拟器中的原生Coloop客户端，独立临时配对，经公网HTTPS/AES-256-GCM发送“打开bilibili”，真实生产VioloopService、RK CPU Agent/真实云规划、硬件USB、首页UIA核验和安卓回执均经过实际链路。未使用模拟worker或模拟输入；本任务0次NPU推理，不冒称模型推理验收。测试实例使用隔离Windows资料目录和临时Cloudflare公网通道，没有改用户原手机配对；不是用户物理手机或原自有relay的网络复验。

首轮任务957cd984-d13c-4686-9b5a-ec6132867e21在mouse_permit两次失败后停止，0次USB；准确错误码此前被通用提示隐藏，独立只读许可检查随后通过，该瞬时失败未再次复现，未修改或绕过守卫。原始失败保留。测试恢复轮完成任务49ccc12d-ff63-481b-85c4-8764042431b3，2次USB；期间测试驱动重连，故不作为连续耗时样本。

独立正式run-3任务8fda1402-4d4c-4ab0-9265-9295ccd05315完成：Chrome已在前台，因此1次首页标签点击、2次实际守卫、2次云请求，RK Agent的board episode独立SSH读回verified=true，安卓客户端最终出现最新总结和“结果已验证”，不再显示执行中。驱动发起发送到主机终态轮询15.504秒，包含定位/点击安卓发送按钮和轮询开销，不是纯业务耗时，也不是手机渲染完成时间；Chrome已有首页标签，不代表任意初始桌面成功率。

测试包rk-agent-gateway-0.13.0-20261102。工作区其他任务随后启动rk-agent-ui包，其主程序差异仅增加task.total计时，观察/输入/RK Agent资源逐字一致；本轮未切换或重启该用户实例，也未将未验收的UI变动冒充本轮业务测试。测试结束撤销本次两个临时配对、正常退出隔离测试实例，并移除复制的加密配置/配对邀请；原用户实例保留。

证据D:/RK/logs/phone-emulator-bilibili-20261102/：首轮result.json，run-2/result.json，run-3/result.json、android-final-verified.png、android-final-text.json、board-episode.json、board-artifacts/、host-timings/，以及verification.json、cleanup.json、running-package-comparison.json和running-main.diff。两端墙钟及模拟器显示时区不同，耗时只用驱动/各主机单调时钟，不跨端相减墙钟。
