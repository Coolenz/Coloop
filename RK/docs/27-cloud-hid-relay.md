# 云端规划 → RK 转达与 USB 执行

2026-11-02继续完善：当前试验入口为 `D:/Coloop/release/rk-agent-state-0.13.0-20261102/win-unpacked/Coloop.exe`。RK Agent增加原子state.json、与真实观察ID绑定的动作回执、结果未知停止和同阶段拒绝重放；云端合法JSON仍须通过控件角色/状态/一枚币等语义检查。首页独立Mem0键`procedure:coloop:bilibili-home:mouse-v1`，三连沿用原键，云上下文附最近六条真实结果。桌面已补RK Agent模式入口。

574项Vitest、19项浏览器Python、25项Agent/runtime Python及板端同25项CPU检查通过。独立WinForms窗口的真实RK＋云端＋Mem0＋USB链路完成2次点击/4守卫/2云调用，最终协议耗时11.368秒；新进程读回同一QA记忆ID，生产流程记忆未被合成测试覆盖。该实验用合成浏览器观察指向实际实验按钮，不是新版B站/实体手机验收，也不包含产品4秒提示或准备时间。源码、全部失败及分步正常耗时在 `logs/rk-agent-state-20261102-100331/`，详见 [最新Agent实现](../../Coloop/docs/rk-agent-gateway.md)。

2026-11-02当前分工已改为 **RK运行Agent，上位机联网转发**。`D:/Coloop/resources/rk-cloud-agent.py` 在RK Linux中管理任务上下文、严格云指令校验、新观察绑定、Mem0读写和流程记录，与原生HID同进程；Windows保留手机通道、云Key/联网、UIA/OCR及逐报告目标校验。当前试验入口指向 `rk-agent-gateway-0.13.0-20261102`，完整分工见 [Coloop RK Agent说明](../../Coloop/docs/rk-agent-gateway.md)。下文早期实现保留历史。

本轮实际新视频BV1VJxs6oE7x完成10次鼠标输入、20守卫，三态true，3次真实云请求/0次RK推理/0次上位机流程记忆调用。RK Agent与HID同为lubancat PID18805，独立SSH取回源码与该轮manifest匹配。连续提交到终态65.415秒，业务核验60.604秒；PC观察/许可/守卫/回读49.177秒（其中正常成功样本49.131秒，两次页面未就绪观察失败45.633ms单列），云请求7.328秒，此次没有比此前32.309秒更快。固定点击等待仍为100ms。失败12.111秒、桌面准备和后续仅复盘修正分别留档，不拼成一次成功耗时。

云端复盘误读合法目标编号0后，已补充协议语义，对冻结的成功回执单独重新复盘，未追加USB；摘要与经验要求完整且在预算内，超限拒绝，不机械截断。RK真实Mem0当前ID9601105f-1b73-4494-843a-0af360adfaf1，保留source=agent/verified=0、来源episode及原业务追溯，独立get/语义search读回。574项Vitest、19项原浏览器Python、12项新Agent Python及板端同12项CPU检查、类型/构建/Ruff/语法、发行物摘要和启动就绪检查通过。证据在 `logs/rk-agent-migration-20261102-live-1/`、`...-live-2/`、`...-work/`。最终提示改动仅重新验收真实云复盘/记忆，未再做完整三连。未使用物理手机，已登录/模型驻留及既有Chrome首页标签为前提；当前仍是固定Bilibili能力、每任务RK进程，不是常驻通用Agent服务。

2026-11-01。新增独立试验入口 [云端协作USB试验.cmd](../云端协作USB试验.cmd)，调用 `D:/Coloop/start-cloud-hid.cmd`。手机任务消息发送“打开 Bilibili”：真实 RK 理解 → 上位机携带能力/历史上下文请求云端 → RK 选择有限 USB 模板 → 原生硬件输入 → Chrome 地址与页面 UIA/OCR 核验 → 云端总结和两端流程记录。

详细源码、用法和失败见 [Coloop 试验说明](../../Coloop/docs/cloud-hid-relay.md)。普通网页 OCR 在本次模式允许上云，未做自动脱敏；既有凭据正文通道、观察互斥及其他模式保持各自规则。

当前默认已按用户最新要求改为**纯鼠标、同一Chrome窗口**，入口为独立 `cloud-hid-mouse-0.13.0-20261101` 构建；下文旧命令行方法保留为历史。新模式及前提见本文末节。

真实通过证据：`logs/cloud-hid-relay-20261101-live-9/`、`logs/cloud-hid-relay-20261101-live-10/`。首次服务总耗时34.898秒、运行时22.042秒、2次RK/2次云调用；第二次携带已验证流程，总耗时28.809秒、运行时15.675秒、1次RK/2次云调用。每轮4个真实USB动作、47次守卫，地址bilibili.com及首页内容核对，云端总结已保存。两轮同时包含编码修正，不是严格速度A/B。

本轮真实测试经过生产手机任务服务，但未使用物理手机或公网手机传输；现有Android协议未改。仅验证固定Bilibili首页任务，不能外推任意网站、应用、登录、搜索或通用鼠标任务。普通单窗口HID模式原有历史结论不被此项替换。失败1～8完整保留，尤其7/8网页已打开但核验器失败，不能算完整通过。

上位机负责云端Agent和流程索引，板端运行时负责USB守卫与记录。下次使用已验证固定流程减少一次RK选择推理，云端仍会收到历史步骤与总结；这不是微调训练，也没有把未核实云端总结升级成Mem0事实。板端模型、运行库及常驻服务未替换，结束时原worker仍在且输入锁释放。

独立发行物已启动，打包启动检查确认RK模型/保存的云账户就绪、手机relay在线、Violoop可用，见 `logs/cloud-hid-relay-20261101-work/package-ready.json`。最后资源校验、完整检查结果、测试与最终发行物边界记录在同目录verification.json；最终打包后没有重跑USB业务任务。

## 2026-11-01 逐步计时与实际视频三连

独立入口现在优先启动 `D:/Coloop/release/cloud-hid-timed-0.13.0-20261101/win-unpacked/Coloop.exe`。新增任务白名单：“打开bilibili，点击主页的一个任意视频，然后三连点赞”。RK理解、云端选片及每个互动命令、实际USB、播放页和三态核验、云端复盘均保留各自证据。新模式按当前页面生成目标ID，不缓存旧鼠标坐标。已有单窗口模式的授权规则不放宽。

本次实际任务已完成：云端选中主页视频 **BV1vZxi68E2p**（【睡前消息1124】赶走711 断供盾构机），RK硬件点击后完成点赞、**投币1枚**和默认收藏夹收藏。最新独立观察三项均为true，最终图标均为蓝色；投币确认前和每报告守卫均逐字核对弹窗标题数量为1。未改关注、评论、分享或其他收藏夹。用户自行登录，没有读取/输入凭据。

固定报告：`logs/cloud-hid-advanced-20261101-work/report.md`；逐步已核验样例来源为 `verified-step-examples.json`，最终状态 `final-states.json`，截图 `triple-result.png`。live-4打开最终视频，live-5点赞，live-8选择一枚币，live-9确认一枚并打开收藏框，live-10默认夹选择/确认、最终三态和真实云端复盘通过。中间失败和停止全部保留，继续时重新观察并跳过已生效动作，不重复投币。

**这是多轮工程调试/同一视频继续后完成的实际任务，不是最终版本一次连续全流程通过的样本。** 初期另开过一个未登录视频，但未对它互动；登录后始终只对上述一个视频进行三连。未再用另一个视频跑交互回归，避免额外账号动作。本轮没有实体手机/公网传输复验。

计时已成为执行约定：上位机每任务 `desktop-runtime/<taskId>/step-timings.jsonl` 和 `normal-timings.json`，手机任务服务另记窗口枚举/RK理解，板端 `logs/cloud-hid-timings/<timingTaskId>/steps.jsonl`。字段包含开始、结束、elapsedMs、success、category、clockHost；每台设备各用单调时钟，不跨端相减。失败/取消耗时原样保留，不进入正常调用统计。嵌套RPC和输入阶段不得重复求和；正常调用耗时不是任务完成时延/正确率，已核验业务步骤样例另外列来源。

已核验样例：RK理解14.685秒；云端首页规划1.062秒、选片1.209秒；Win+R 0.078秒，Ctrl+A 0.076秒，输入启动文字3.088秒，Enter 0.075秒；选片点击0.138秒；点赞0.128秒；投币框0.138秒、选1枚0.132秒、确认0.454秒；收藏框0.135秒、默认夹0.132秒、确认0.362秒；云端复盘2.915秒。USB步骤包含调用内逐报告守卫，不含页面等待和前后观察；每项一个指定来源样本，不能合成完整单遍时长或SLA。

执行器增加Chrome首页 `/index.html` 跳转、真实缩略图及UIA命中拓扑、未命名Group的帮助文本语义、投币/默认夹弹窗。当前默认主题状态以UIA语义和图标蓝/粉/灰颜色交叉检查；主题/布局未知时停止。未确认结果不会盲目重放点击。显式继续接口需给真实窗口句柄/BV，并重新绑定进程/地址；本轮不自动恢复旧的未确认任务。

主机550项Vitest、10项浏览器Python边界测试通过，类型检查、构建、Ruff/Python语法通过。最终打包后只做启动/连接检查，没有再对账号重复三连；最终版新增的板端完整流程写盘重构由单元检查覆盖，实际动作证据绑定各live轮次manifest。模型、运行库、USB描述符未换；结束时输入锁空闲，原worker PID2207仍在。

## 2026-11-01 单次连续任务复测

按用户要求从重新发命令到结束，未恢复旧视频/任务，产品源码及打包资源与前述最终版一致，只有测试驱动补充整体单调计时。新选视频BV1LNxr63Eoz，连续完成12个USB动作、63次守卫、三连三态核验和云端总结；1次RK理解、10次云端请求。

**实测63.821秒**：提交命令至三连核验60.569秒，随后总结/保存/结束3.252秒。起点为生产VioloopService.submit前、终点为任务终态通知，同一上位机单调时钟；包含准备和4秒开始等待，不含Electron/SSH准备或实体手机网络。已登录、模型驻留、已有Chrome启动模板。固定证据：`logs/cloud-hid-singlepass-20261101-run-1/report.md`、summary.json和runtime.json。

与上一节多轮调试不同，这次是一次连续成功样本；不能据一轮推断长期成功率或固定SLA。窗口加载期间有只读等待重试，没有未知输入重放。结束后额外截图未找到可见Chrome窗口，未追加输入；结束时执行器三态和全回执在runtime.json的relay_review请求中留存。

## 2026-11-01 RK持久记忆与自行切窗复测

当前独立入口优先启动 `D:/Coloop/release/cloud-hid-memory-ready-0.13.0-20261101/win-unpacked/Coloop.exe`。已将已验证操作顺序、来源、计时范围和守卫写入真实RK Mem0 OSS2.2.1，固定键 `procedure:coloop:bilibili-triple:v1`，kind=procedure、source=agent、verified=false。云端复盘及真实三态通过后回写，最新版本另保存有界云摘要/2条经验，cloudSummaryVerified=false。来源未升级为已核实个人事实；原固定白名单决定能力，记忆和摘要不能扩权。独立SSH/Python会话get及语义search已读回实际持久值，最新ID `6570b42b-9192-4315-bba9-ba6e300fd532`，后续写入可换版本。

新连续任务 `BV1AAsX6EEKQ` **50.324秒**，此前63.821秒，减少13.497秒（21.1%）；业务核验47.193秒，随后云复盘/记忆保存/收尾3.131秒。0次RK模型调用（此前1次14.408秒），11次云请求，12动作和63次守卫；点赞、投1枚币、默认夹收藏均true。命中固定流程记忆时由主机选择既有browser_relay，跳过RK理解，云端仍逐步规划。全步骤开始/结束/单调耗时/主机/成败及正常样本统计保留在 `logs/cloud-hid-mem0-20261101-run-2/`，汇总见该目录report.md和all-step-timings.json。

用户提出自行切窗后，执行器已通过RK USB点击绑定Chrome的可见已选标签页恢复前台，并核验原HWND/PID和视频；遮挡时保留有界系统切换。显式继续只允许用地址栏恢复本地绑定BV，键入前核对实际焦点、Enter前回读精确地址。修复Chrome地址栏小型Document误作网页主视口的问题。输入许可前明确拒绝可新观察/新云决策一次，任何可能已经发送输入的失败仍停止。没有Windows软件输入、激活API或网站互动API。

run-1在收藏确认前失败40.931秒，resume-1～4的后台/自动播放/地址栏/切换与测试器上限失败原样保留；resume-5核验原视频BV1QHsX6NEUL三态true，未再次投币，34.585秒只是剩余任务恢复，不计为完整提速样本。50.324秒来自另起run-2，无旧任务恢复或人工切换。本轮有一次许可前重新观察，故多1次云请求但动作仍12。各配置仅1个成功样本，期间还有恢复/观察改进，并非严格统计A/B；不含物理手机网络或Electron/SSH准备，不能保证下次固定耗时。

556项Vitest、16项浏览器Python边界检查、类型/构建、Ruff与语法通过；最终包已启动，真实RK/保存云账户就绪、手机relay在线。输入资源与run-2一致，最终云摘要字段真实写入并经独立会话读回；未在打包后再重复三连。详细报告和打包/记忆证据在 `logs/cloud-hid-mem0-20261101-work/`，专题实现见 [Coloop说明](../../Coloop/docs/cloud-hid-relay.md)。模型/运行库未换，原worker PID2207和空闲HID锁核对通过。

## 2026-11-01 改为点击打开、同窗口纯鼠标

当前 `云端协作USB试验.cmd` 经 `D:/Coloop/start-cloud-hid.cmd` 只启动独立 `release/cloud-hid-mouse-0.13.0-20261101/`。新能力chrome_bilibili_mouse_v1通过新鲜UIA观察和RK原生USB点击任务栏Chrome图标、同窗口已有Bilibili首页标签，再点击主页视频并三连。绑定原HWND/PID；视频可产生同窗口新标签，未承诺同一标签页。鼠标许可保留身份/几何/前台/命中守卫，明确拒绝键盘/命令行许可，缺少目标不回退旧启动方式。

真实新视频BV13Nxq6REre：原Chrome HWND723406/PID42264保持，10次USB鼠标点击、20守卫，点赞、投1枚币、默认夹收藏三态true。首次完整任务68.797秒（业务核验64.550秒，云复盘/记忆/收尾4.247秒），2次RK模型、12次云请求；新模式首轮未复用旧命令行记忆，不能拿它与旧记忆命中速度直接比较。三连业务完成后测试器旧文件名导出失败，原错误保留、正确索引原字节补充导出，没有追加输入。修正后仅打开首页另跑一轮37.713秒、2个鼠标动作和4守卫，进程/页面/云复盘/导出通过，未再次投币。

新流程与云复盘已保存到板端真实Mem0独立键procedure:coloop:bilibili-triple:mouse-v1，带mouse_only、source=agent/verified=false和来源；旧v1只留历史，不参与当前计划。独立SSH/Python会话get及语义search读回ID e0893dfe-dced-4d4e-8780-e1f5b094be23。全步耗时/正常样本统计/原始失败、记忆及打包证据见 `logs/cloud-hid-mouse-20261101-run-1/`、`...-home-1/`、`...-work/` 的report.md与verification.json。

当前覆盖一个已运行Chrome且有可见Bilibili首页标签；缺失标签、多窗口或遮挡停止，未覆盖任意初始页面的纯鼠标导航。仍已登录/模型驻留，未含实体手机/公网传输或Electron/SSH准备。556项Vitest、19项浏览器Python、类型/构建、Ruff/语法及最终包就绪检查通过；源码与首页实测manifest、主程序/输入资源哈希匹配。最终包已启动，未再追加账号互动；模型/运行库和原worker2207保留，HID锁空闲。

### 2026-11-01 等待降至100ms

用户要求缩短700ms×10固定等待，已将browser-runtime.py点击后settle改为100ms。十次配置等待7秒→1秒，理论减少6秒，页面未就绪仍由既有只读观察/核验等待；没有修改超时、输入守卫或未知输入不重放规则。当前独立入口启动cloud-hid-mouse-fast-0.13.0-20261101；沿用已验证主程序，仅更新Python额外资源，19项相关Python、语法/Ruff、打包哈希及启动就绪检查通过。

本轮首页实机尝试在RK返回额外JSON字段时拒绝，零USB/零云请求，失败26.578秒单列；当前Chrome已关闭，未新跑完整三连，不能声称新全程耗时或100ms硬件验收通过。证据在logs/cloud-hid-short-wait-20261101-home-1及-work。

此前6.659秒流程选择的板端记录：输入177token，prefill3.460秒；输出13token，generate2.671秒；其余约0.529秒，正常stop且未用满32上限，kv_before=0。按本轮独有输入字节数与相邻记录序列匹配，原驱动未保存请求ID；不跨端墙钟计时。原始metadata-only证据见-work/original-rk-perf.json。

### 2026-11-01 第二次完整鼠标流程：42.912秒

按用户要求再次执行，正式连续任务 **42.912秒**，首次68.797秒，本次减少25.885秒（37.6%）。新视频BV1j3x16XEuR，10次RK USB鼠标动作、20守卫，点赞、投1枚币、默认夹收藏三态true；本次内绑定同一Chrome HWND7079868/PID42476。真实Mem0命中后RK模型2→0次，点击后settle实测7.002→1.002秒。本轮额外两次输入许可前命中拒绝，通过新观察/新云决策恢复，云请求12→14，完整动作没有减少或重复发送。

业务核验39.716秒，随后云复盘/记忆保存/收尾3.197秒；源端资源与已启动fast发行物哈希匹配，未修改产品代码。更新Mem0 ID为6145882b-62cb-40d3-88c3-08d9bb7f9ca9，独立会话get及语义search读回，原worker2207和空闲HID锁核对通过。所有分项、正常样本统计及原始证据在logs/cloud-hid-mouse-repeat-20261101-run-1与-work。

Chrome原先已关闭，已先用RK鼠标完成显示桌面、双击桌面Chrome、点击新标签页已有Bilibili快捷方式及站内首页链接来恢复准备状态；各步单调耗时单独留档，不拼接成一次连续准备时长，**不含在42.912秒中**。正式阶段从生产任务服务提交到终态，与基线相同口径；已登录/模型驻留，包含4秒开始等待，不含Electron/SSH准备或实体手机网络。两个成功样本的改动同时包含记忆复用和等待缩短，视频/云端响应不同，不能视为单变量A/B或固定SLA。

## 2026-11-01 云端Agent语义流程优化

当前独立入口启动 `D:/Coloop/release/cloud-hid-agent-0.13.0-20261101/`，默认semantic-plan。调研UFO²（WindowsUIA/多动作）、Browser-use（上下文/动作边界）、LangGraph.js（TS状态编排/检查点）、Agent-S（经验/接口）；原始仓库、MIT或Apache-2.0许可证、固定revision和适配取舍见 [Coloop云端Agent说明](../../Coloop/docs/cloud-ui-agent.md)。本次借鉴设计并实现自有适配层，没有直接安装框架SDK或更换USB后端。

云端先批准严格受限的语义阶段，本地按新观察绑定唯一控件；选视频、歧义与异常仍请求云端或停止。不会批量重放跨页面旧ID/坐标，按任务信号、窗口、阶段和已用观察隔离；保留现有1枚币/默认夹、UIA命中与每报告守卫。上下文只发送当前必要候选和记忆来源/约束，原始观察仍在本地校验。回执区分cloud_model与cloud_plan_local_binding，不能把planningCalls接口计数当真实云调用。

真实新视频BV1XZxe6SEuU：10次RK USB鼠标动作、20守卫，同窗口三态true，0次RK模型。**32.309秒**，前轮42.912秒，减少10.604秒（24.7%）；业务核验28.919秒，云复盘/记忆/收尾3.390秒。真实云请求14→3次，API输入token16,278→2,376（减少85.4%，包含缓存token，不等于计算量/费用等比例下降）。一次输入许可前重新观察重新绑定，没有额外云调用或点击重放。

云复盘回写RK Mem0，本次ID3d9fb3b3-5a79-4955-bc3b-3e122f9e2671，独立会话get/语义search读回，worker2207和空闲HID锁核对通过。562项Vitest、19项浏览器Python、类型/构建、Ruff/语法及最终包哈希/就绪检查通过。原始时序与正常样本统计见logs/cloud-agent-optimization-20261101-live-1，选型/来源/打包/记忆证据见-work。正式起终点和此前一致，已登录/模型驻留，不含提交前桌面准备、Electron/SSH及实体手机网络；固定Bilibili能力、单次样本不代表通用桌面任务质量或SLA。


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
