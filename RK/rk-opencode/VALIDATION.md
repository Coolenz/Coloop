# 验证记录

## 2026-10-30：RK 端侧 Agent 默认策略与全 RK HID 闭环

新增 `agent/hid_agent.py` / `scripts/hid-agent.py` / `RK桌面Agent.cmd`：原生模型循环默认紧凑/增量观察、实际composed-prompt预算、超预算任务/真实回执/当前全视图重建及冷KV会话、失败停止；业务条件独立核验，缺条件时不宣称程序验证成功。可选FastDesktop默认复用HIDWorkflow及短Agent引用，保持原OpenCode记忆权限与历史benchmark协议；原生入口不调用记忆内容工具。

用户明确要求全部操作由RK完成后，新增只读caption身份查询/一次性reservation，由RK硬件点击获取前台；不再使用computer-use或PC输入来操作测试窗。最终父项目 `logs/hid-agent-layer-20261030-224152/e2e-5/`：被动窗口预置后，RK自己获取前台 → 两次真实Qwen4B请求 → 模型生成fill_form参数原样派发 → USB键鼠 → UIA回读与Windows独立业务 → 完整最终值回答，通过。Text首尾空格、数字负号/前导零/尾零和未知Code均准确，Apply恰好1次，无按键残留；约66.548秒、最高53.615℃。第一轮新增980 token，第二轮新增218 token及1061缓存token分开记账。没有MCP、软件输入、模型/库替换或USB重绑。

主机相关73项（2项Linux锁跳过）、板端73项通过，安装源码SHA256一致，租约和执行会话解除。真实OpenCode debug config短引用/权限检查通过，尚非新一轮完整OpenCode任务验收。首版422、用户中止等待、较弱收尾样例、fixture共享冲突及最终通过分别保留，不能汇总为通用准确率。原生上下文rebase与只读收尾澄清只有边界单测，本次短任务未触发。完整实现、启动和边界见 [端侧Agent报告](../docs/25-rk-desktop-agent.md)。

## 2026-10-30：真实 NPU 观察数据量 A/B

新增 `scripts/bench-hid-observation.py`，使用固定真实HID初末快照及一项明确合成的禁用按钮干扰，六题分别以原始JSON和现有 `ObservationView` 紧凑/增量视图送入常驻Qwen4B W8A8 / RKLLM 1.3.0。相同提示/160输出上限，独立请求cache off、12次cached token均0，按题交替先后，metadata-only，独立前台租约不读写记忆内容，无工具注册/HID/MCP/OpenCode动作。固定目录 `logs/hid-observation-ab-20261030-221053/` 在父项目：实际input token 9156→2244（少75.49%），SDK prefill 168.088→41.082秒（少75.56%），output 200→149 token；HTTP212.649→72.860秒包含输出差异，不能作为纯输入加速倍数。最高56.384℃，lease释放，没有重启模型或更新生产执行器。

严格JSON及内容得分原始2/6、紧凑6/6。原始三题内容正确但有Markdown围栏，另一题JSON不完整；未剥围栏、补输出或重试，不称为通用准确率/模型HID任务成功率。两个新增主机评分/答案隔离单测、Ruff与Python语法检查通过，12项实际NPU响应/计时及源码SHA256完整核对。详见 [协议、逐题结果与边界](../docs/24-rk-hid-input.md#真实模型处理量-ab)。

## 2026-10-30：原生 HID 紧凑观察与批量填写

`agent/hid_workflow.py` 与 `hid-act.py --compact` 已接入完整本地缓存、紧凑控件数组/带base增量、原生JSON Schema和1..4字段的板端批填。全批共用HID锁，每步重新观察、检查焦点和真实UIA value，末尾统一核对才可选提交；错误/中断持久化阻断，未知结果不自动重放。PC仅增加只读窗口/控件身份及客户区标记，未注入输入；默认CLI与可选MCP继续保持旧协议。

父项目 `logs/hid-workflow-final-20261030/summary.json`：现有RapidOCR+UIA → 板端本地CLI → USB HID → Windows字段及随机Applied状态，通过。初始原始2582→紧凑383字节，增量70字节；1请求执行7动作，约13.969秒；文本首尾空格、负号/前导零/小数尾零一致，Apply恰好一次，修饰键/鼠标释放。含中文的后字段整批拒绝且窗口未变。主机相关51项中49通过、2个Linux锁测试跳过，板端51项通过；Ruff/Python/skill/C#及独立OCR离线/空白/坐标回归通过，源码SHA256及安装前副本留档，会话解除。没有调用模型、MCP、OpenCode或记忆；不代表模型自主填表或NPU速度验收。首轮通过日志另留 `logs/hid-workflow-20261030-2145/`。详见 [优化报告](../docs/24-rk-hid-input.md#紧凑观察与板端批量填写)。

## 2026-10-30：直接 USB HID 主接口与进度对齐

按用户明确要求，skill改为板端本地Python/JSON CLI优先，能力声明 `mcp_required=false`；MCP只保留旧OpenCode适配。专项安装默认不读/改OpenCode配置，仅显式 `--opencode-compat` 才更新兼容prompt。与「为 RK 添加 Windows 操控 Skill」已对齐：电脑负责OCR/UIA观察、校验与回读，RK通过USB发报告；软件通道的Unicode/文件关联/批填结果不当作HID证据。该阶段尚未迁入增量观察/批填，后续独立硬件验收见上节。

父项目 `logs/hid-direct-priority-20261030-174233/direct/`：无MCP、无OpenCode、无模型的板端CLI `hid-act.py --step` → USB HID → Windows随机串输入 → 实值回读通过；computer-use仅用于激活测试窗。主机143项（9平台跳过）、板端当时已部署102项通过，能力文件SHA256一致，安装未修改OpenCode配置，会话已解除。保留此前模型规划未完成最终复验的边界；此轮不是新的通用模型任务质量验收。详见 [直接接口与证据](../docs/24-rk-hid-input.md#直接-hid-定位修正与另一聊天对齐)。

## 2026-10-30：HID 统一 skill 与能力查询

新增 `skills/rk-hid-desktop/SKILL.md`，日常 `rk-desktop` / `rk-desktop-fast` 通过 OpenCode 原生文件引用加载同一说明。保持原 MCP 名称、普通 observe/act 和轻量 step 兼容；CLI增加capabilities/observe/step，能力声明、动作列表与限额共用执行器常量。skill不授予执行权限。专项安装器只合并两个既有HID agent prompt并部署相关文件，保留其他agent/模型/权限及配置；未来完整host打包包含skills。compact观察补回真实Edit value，缺失时不编造，供模型核对文字。

父项目 `logs/hid-skill-20261030-164656/`：主机最终141项（9平台跳过）、板端当时已部署101项通过，Ruff/Python/skill/C#编译验证通过；真实OpenCode确认两个agent加载同一skill。`protocol-final/` 真实MCP→USB→Windows随机串→compact实值核对通过，明确无NPU推理。`model-2/` 旧验收的真实NPU输入/最终串通过，但当时精简结果缺value；补齐value后的严格完整模型复验仍未通过：模型多带target_id、失去前台或同名窗口都被拒绝。错误/失败均保留，没有修补模型参数或自动重放。Computer-use只用于激活隔离窗口，文本输入仍由RK发出。未停止已有模型/凭据服务或重配USB，详见 [本轮协议与证据](../docs/24-rk-hid-input.md#统一-skill-包装与调用入口)。

## 2026-10-30：USB HID 完整动作与停止释放

扩展 `agent/hid.py` / `desktop.py`、PC观察校验与普通/fast MCP schema：移动/悬停、三键点击/双击、持锁插值拖拽、明确刻度的垂直滚轮、Win/GUI及常用键组合。指针始终绑定目标ID，可选截图像素不能越过对应目标；屏幕/DPI、UIA身份、焦点、一次消费及逐报告会话/窗口guard继续校验。取消/异常/进程信号尝试在最后位置释放，释放不受焦点变更阻挡；未知结果不自动重放。未提供跨调用按住、水平滚轮或纯HID中文。

父项目 `logs/hid-input-hardware-20261030-6/` 最终16次动作按预期通过：15次真实输入与Windows效果核对，另1次真实按下后停止并确认释放；三键/双击/拖拽/+2及-3滚轮、文本首尾空格和LF、Home/End/PageUp/PageDown/Delete事件分别留档。主机相关50项（1项Linux锁跳过）、板端当时已部署全套96项通过，Ruff/Python语法/C#编译通过，板端源码SHA256与本地一致。主机同期全套126项另有私密记忆测试 `no such table: jobs` 错误，9项平台跳过，未处理该并行任务。报告完整保留各轮失败、处理耗时与名义拖拽时长偏差，见 [协议与证据](../docs/24-rk-hid-input.md)。

这次由测试程序构造动作，通过真实观察HTTP、板端执行器及USB报告完成；没有运行NPU规划回归，Win键仅编码测试。没有停止原常驻模型/凭据服务、重配RNDIS或更换模型/库；本次测试窗与观察执行会话已停止。

## 2026-10-30：私密记忆统一目录

后续完整OpenCode/NPU严格验收通过，父项目 `logs/private-memory-final-20261030-155915/report.json` 25项，1次真实memory工具查询，整段未知locator与resolver精确匹配，退出0，约39.96秒。此前超时／422／SDK ID混淆均保留；`155332` 原报告的子串误验收由同目录audit撤销，最终改为整段严格检查。

管理入口已进一步统一为Coloop单一「记忆」页和原Mem0管理API：普通／私密共用搜索、分类、列表、新建和删除，普通内容编辑保留历史与TTL，按逻辑键删除避免复活旧版本。私密正文仍只交受保护提供方，browse只有引用，MCP不开放新增管理操作。`scripts/setup-memory-management.py` 已部署；真实SDK 27项管理／目录检查通过于 `logs/unified-memory-sdk-20261030-164144/report.json`，实际32个存储文件无合成秘密。电脑相关14项Python测试和Coloop全量502项通过；早前并行全量中的 `no such table: jobs` 是本任务新增单测漏建jobs表，现已补齐，不改写旧测试记录。真实界面／打包验收与失败记录见 [专题](../docs/22-private-credentials.md)，本阶段未重跑USB输入或公网登录。

最终电脑子仓库全量131项：122通过、9项按平台跳过。Coloop统一记忆包 `release/memory-20261030165137/` 已实际启动并通过真实板端管理16项，`.qa/memory-management-1793350369301/report.json`；16个Mem0文件与70个Coloop配置文件无合成秘密，cloud0且模型日志无增量。包内编译／资源／依赖校验通过。没有覆盖原安装版或改变默认启动器，USB／公网登录仍沿用各自独立验收边界。

凭据成为现有Mem0系统的私密分区：独立 `private_refs` 集合保存元数据引用，普通memory search/get/recall及lookup_private可定位到编号、rk-vault位置和Coloop执行器。正文仍在受保护后端，引用不授予读取明文或执行HID权限，不进入facts/capsules的提取与压缩。按user/project绑定，查询核对权威目录，普通set/delete不能改写私密项，失效或不可用时不返回旧引用。

电脑侧 `logs/private-memory-acceptance-20261030-150409/report.json`（父项目）20项真实SDK/CPU/HTTP/MCP与生命周期检查通过；32个Mem0文件中未出现合成账号/密码，原2条普通事实及队列状态保持。`logs/private-memory-model-20261030-150717/report.json` 的真实Qwen4B消费召回引用通过：精确未知ID、完整位置、Coloop调用方式，metadata-only确认、cache off、worker新增0字节，约19.23秒，不调用云端。完整OpenCode首轮240秒超时单列，不用上述分层通过替代完整Agent验收。11项相关Python单测、1项Node插件回归通过；模型/库/嵌入未更换，本轮不重跑HID输入。详细数据流、配置、失败及信任边界见父项目 [私密记忆](../docs/22-private-credentials.md)。

## 2026-10-30：RKLLM 多模型结构

源码新增 `model_profiles.py` 和 `model-profiles/*.json`，把模型 ID、资产目录、匹配 Runtime/Header、上下文/输出、模板、思考和缓存能力集中声明。启动、构建、HTTP、OpenCode 配置和常驻 Mem0 请求共用这些信息；worker 协议升级为 3，不再按 4B/DeepSeek 名称选择 C++ 参数。默认模型与原权重/运行库保持原配置。

原始证据位于父项目 `logs/rk-agent-model-profiles-20261030-134153/`：`manifest.json`、`summary.json`、`final-source/`、各阶段退出码、输入/响应、OpenCode 原始事件和资源采样。目录按电脑时间命名；板端墙钟明显有偏差，未修改时间，单次耗时用板端 monotonic。初轮与最终源码的 profile 指纹分别为 `84eed447…`、`8bb8bfb8…`；最终轮补充了配置类型校验与格式整理，分别保存各轮结果，不能把初轮全部通过当成最终轮结果。

| 检查 | 本次实际结果 |
| --- | --- |
| Windows Python | 最终发现 90 项，82 通过、8 项按环境跳过。过程中工作区另有并行模块新增测试，本次未部署那些模块 |
| Node 插件 | 90/90，通过自定义受控模型 ID 后仍拒绝改 endpoint、权限、隐私头与旧 small_model |
| 板端已部署测试集 | 72/72；与 Windows 当前测试文件范围不同，不能当作相同全量集对照 |
| 静态/启动器 | 修改的 Python 语法与 Ruff、Bash 与内嵌 Python 语法通过；PowerShell 语法及 `-Profile`/UTF-8 编码恢复通过模拟 SSH 验证，没有打开交互控制台或执行桌面 HID |
| 构建与真实不同模型 | 用各自应用内的 Header/Runtime 编译 Qwen 4B 1.3.0、DeepSeek 1.3.1 worker；两者真实初始化、生成、正常切换及退出通过。DeepSeek 单题 HTTP 200，生成 145 token，最终算术值为 5，回答较冗长；没有重测其工具成功率，也不改写历史失败 |
| 默认 4B 初轮 | 算术、中文原样输出、错误模型 ID/输出上限拒绝通过。OpenCode 实际 read 后返回完整 `RK_MODEL_a502e6c9955f0ca7`，退出 0，完整文件任务通过 |
| 原生缓存 | 上述文件任务收尾 `cache_reset=false`、`kv_before=630`，新增 prefill 120 token、提交 269 字节；不是把已有 630 token 算作本轮新增量 |
| 独立 profile 切换 | 临时 `validation-alt-4b` 使用同一份真实 4B 权重，HTTP ID 为 `validation-4b-rkllm`、上下文 8192、缓存 off；配置与实际请求吻合。它不是另一个 8B 模型 |
| Mem0 实际模型路由 | 在该独立 ID 服务运行时，真实 `RKMemoryLLM.request()` 返回 `{"memory":[]}`，无旧 4B ID 错误。只验证适配器/NPU 路由，没有重新验收完整跨会话提取、压缩或召回质量 |
| 切换预检 | 指向不存在权重的临时 profile 返回 2，原 bridge PID 不变；错误在释放现有模型前被发现 |
| 最终状态 | 已恢复 `qwen35-4b`、16384、native、Runtime 1.3.0、协议 3，健康检查通过；临时 profile、对应 worker/stamp、测试窗口文件和自有活动租约已清理，原日志保留 |

**两次文件任务质量失败必须保留**：独立 8K/off profile 成功执行 read，但原始模型 action JSON 把 `RK_MODEL_1af5a0cc4cb279d3` 抄为 `RK_1af5a0cc4cb279d3`；最终 16K/native 复查同样把 `RK_MODEL_46c3087a7b8653d3` 抄为 `RK_46c3087a7b8653d3`。两次 OpenCode 退出码都是 0，验证器仍正确判失败；分别见 `capability-2/result.json`、`capability-final/result.json` 及对应事件。桥接输出与原始模型 JSON 一致。这是当前 4B 的逐字抄写可靠性限制，不能把读取成功或合法 JSON 等同于任务完成；没有删除失败或据此宣称通用 Agent 质量通过。

最后一轮采样的温度、worker RSS、完整 34 条单秒观察见 `resource-samples.json` 与 `summary.json`，没有触发 80℃策略。RSS 是进程采样，不能代替全部 NPU/系统内存或长期耐久性指标。源码回退保存在板端 `.runtime/model-profiles-backup-20261030-134153/`，构建旧文件在 `build/archive/`；不涉及权重或全局库替换。

Qwen 8B 目前只有 `qwen3-8b.example.json`，没有下载/上传权重或实机推理结论。普通 RK Agent 的接入方法见 [多模型说明](model-profiles/README.md)。外部 `D:\Coloop` 的登记/连接协议仍固定 4B，本次未扩权；受控插件现在从主机摘要登记过的配置固定模型，启动器遇到 live 模型/限制不符时拒绝，其他模型需该主机适配并重新登记。本次未重跑受控签名端到端或桌面 HID。

首次板端 CPU 测试发现未部署 `opencode-coloop-managed.json`，11 项测试准备失败；补齐模板后 72/72 通过。失败原文 `board-unit-tests.txt` 与修正结果分别保存。其余旧实验结论继续以各自固定目录、参数和原始证据为准。

## 2026-10-30：最终受控后端修订与分层结果

应用0.10.1完整native40批次：36/36支持题完成真实闸门（20签名读取/16拒绝），另4路由题未支持；20许可离线验签，审批P95 2702.595ms，最终任务34/36。原始目录 `logs/coloop-managed-native-final-20261030-040600/`。

最终core `f269f5bf...` / entry `bf3c981f...` 只把已批准结果在局部模型输入中展示为简洁原文，原JSON/字节/Hook不变。76项Node、当前core Linux fd27/27和策略127/128通过。失败2题首次定向复测2/2成功，但扩展22题回归仅21闸门/20任务通过，另有误抄与422；19个消费样本P95/max3547.726ms、缺1项，不满足原3500ms目标，未补造结果或放宽JSON。目录 `logs/coloop-managed-projection-regression-20261030-100700/`。

各轮模型请求metadata-only、worker新增0字节，Mem0状态未变；reviewer实际输入未含nonce/canary。primary wire及全Mem0存储观察不完整，strict仍未通过；不把计数相同当作全量存储/物理擦除证明。详见 [固定评测](../docs/19-coloop-managed-approval-evaluation.md)。

## 2026-10-30：Coloop 0.10 真实 RK 一次性读取

`logs/coloop-managed-read-1793302073936/summary.json`：生产受控 profile，非脚本化 Qwen primary 与真实 RK reviewer；实际 `coloop_read` 完成，原 pending 只回复一次并消耗，Ed25519 permit、来源/会话/任务绑定、双 SHA 及最终未知随机串全部核对通过。asked→consumed 2501.376ms，整任务41.937s，三次私密请求，worker新增0字节，Mem0计数不变，自有来源已回收。主机合成请求 observer 未发现文件 nonce 进入审批模型。单例不计为固定40题全部通过。

固定128题最终Linux CPU策略126/128，2题许可消费重放未由策略层支持；36个Hook与26个managed核心Node测试、73个Python测试（Windows3项Linux-only跳过）、Coloop173项测试通过。CPU测试不替代NPU或Linux文件内核验收。固定题集及后续批量真实记录见 [评测报告](../docs/19-coloop-managed-approval-evaluation.md)，入口/权限/记忆与软件信任边界见 [受控审批](../docs/20-coloop-managed-approvals.md)。

## 2026-10-30：Coloop 原生 Hook 与 RK 快审

固定OpenCode1.19.5的SDK进程内fetch与serve路径均已接入，插件36项、父应用144项及本仓库60项Python测试通过。原pending全摘要、单次回复与消费核验、隔离上下文、限额/取消/过期和记忆前台租约保持边界；Hook不写长期事实，正常聊天MemoryPlugin仍按原策略工作。

`logs/coloop-internal-hook-1793295194567/`：无受控源/阶段fixture的真实Qwen主Agent＋真实RK审批＋stock `--mini`，审批2957.743ms、整任务53.047s，工具完成、原请求消费和最终文本精确，无源TCP监听，3次模型调用metadata-only。

`logs/coloop-hooks-benchmark-1793296894702/`：源provider仅脚本化发题/回显真实结果，真实OpenCode/native pending、生产插件、RK判断及SDK消费保持真实；**不代表20次主模型开发成功率**。100事件P95 22.200ms、10规则拒绝P95 28.279ms、20审批20/20成功，P95 3008.326ms、最大3029.731ms；预热单列3124.880ms。21次RK请求均metadata-only、worker新增0字节，Mem0各计数未变。自有会话/进程/活动/连接清理通过，最终部署SHA与本地一致。

全NPU源端失败和单条非私密合成诊断保留；主模型括号错误被严格拒绝，没有补造工具调用。详细输入、源码/产物摘要与限制见父项目 [Hook报告](../docs/18-coloop-hooks.md)。模型、Runtime1.3.0、Header及权重未变。

## 2026-10-29：轻量方式移入真实 OpenCode

新增 `plugins/desktop-fast.mjs`（`chat.message` 初始观察钩子）、`agent/fast_desktop.py`（MCP 自动观察步骤），以及 `rk-desktop-fast` / `rk-testbench-fast` 两个 agent。日常入口为 `轻量桌面Agent.cmd`，testbench 默认改为 `opencode-fast`；独立 compact 和原 opencode 模式继续保留。

模型决策、权限校验、工具执行与会话保存均走真实 OpenCode。插件在用户任务中附加电脑助手实际返回的初始观察；模型随后三次调用 `rk_desktop_fast_step`，工具内部复用已验证的 HID 执行器并自动返回新观察。数据只保留模型需要的 ID、文字、类型、来源和焦点信息，完整坐标与图像摘要留在校验器和原始日志。测试 agent 使用固定业务阶段校验；日常 agent 保留记忆权限。

固定版本 [插件 Hooks](https://github.com/anomalyco/opencode/blob/v1.19.5/packages/plugin/src/index.ts) 没有“工具已验证成功，直接正常跳出当前会话循环”的公开接口。因此集成版保留一次真实模型最终回答，不修改 OpenCode 二进制、不生成假的模型响应、不把主动 abort 当正常结束。正常路径为 **三次动作决策＋一次收尾，共四次模型请求**。独立 Python 版仍为三次。

### 最终实机通过

目录：`logs/testbench-20261029-174233-8e95/`。OpenCode 会话 `ses_e7b1b11b6ffePo0Z1DYaL3JUEb` 的原始事件与 `opencode-export.json` 均保存；三个工具名均为真实 `rk_desktop_fast_step`，状态 completed、executed=true。输入 `02206873` 保留前导零，Apply 实际一次，观察 Applied 后 Alt+F4，窗口退出码 0，最后由模型输出合法 JSON，OpenCode 最终文本为 `Task completed.`，进程退出 0。三层验收（应用事件、工具 trace、OpenCode 原始事件）全部通过。

| 指标 | 实测 |
| --- | ---: |
| 完整 OpenCode 任务 | **64.92s** |
| 实际窗口关闭 | 60.55s |
| 模型请求 | 4 次，共 56.02s |
| 三次动作决策 | 22.384 / 14.504 / 15.182s |
| 最后回答 | 3.954s |
| 新增 prefill token | 729 / 367 / 347 / 124 |
| 复用 KV token | 0 / 770 / 1173 / 1559 |
| 原生 prefill / generate 合计 | 29.73 / 26.24s |
| 实时 OCR | 6 次，共 1.415s，中位数 181ms |
| USB 发报告 | 3 次，共 531ms |
| 准备 / 开窗 | 10.95s / 207ms，另计；其中模型启动 8.25s |

后续三个请求均原生 cache_reason=append。与此前原 OpenCode 10 轮、144.62s 样例相比，减少约 55.1%；与独立 compact 3 轮、45.87s 样例相比约多 19.05s。差异包含额外最终回答、上下文/工具结果长度和框架开销，不应全部归因于某一种机制，也不是纯轮数消融实验。聚焦与鼠标移出按钮在计时前完成，期间没有用电脑端脚本替模型完成输入/Apply/关闭。

### 失败与部署修复

- `logs/testbench-20261029-172115-dfd2/`：三个动作实际完成，但 OpenCode 新启用插件时等待 `@opencode-ai/plugin` 依赖安装，板端 npm DNS 失败；可选会话导出再次等待并超时，原测试记录保留 FAIL。后来取回真实 OpenCode 事件、工具 trace 与四次模型请求，保存为 recovered 文件，没有改写原验收结果。导出超时现单独记录，不再阻止其他证据落盘。
- `logs/testbench-20261029-173330-f331/`：离线依赖已解决；鼠标悬停/遮挡使 OCR 将 Apply 识别为 Apr。模型反复选择输入值文字框，被业务校验拒绝，没有发送这些点击。此次失败保留。测试台现在遇到工具错误或 API 错误会停止自身会话，避免持续空转；实际 input 已发送后不能自动重发。
- `logs/testbench-20261029-173850-4961/`：三次动作和窗口正常关闭均通过，但最后模型输出裸文本 `Task completed.`，桥接层严格拒绝并返回 422，OpenCode 退出 1；仍判 FAIL。随后在 fast agent 的系统提示中明确最终 `answer` JSON 格式，未放宽解析。

SDK 通过 npm 官方包与 `plugins/package-lock.json` 固定为 1.19.5。PC npm 曾受已有无效代理影响，本次只用命令级参数直连 registry；全局配置未改。`prepare-plugin-deps.ps1` 使用 `npm ci --ignore-scripts --omit=dev --omit=optional`，准备纯 JavaScript 依赖。部署脚本拒绝 Windows 原生模块并校验 SHA256，通过现有 SSH 上传到应用私有配置目录；实际发现可选 msgpackr Windows native 文件时曾拒绝复制，剔除可选依赖后才成功。后续启动/导出不再等待 npm。模型权重、系统运行库与 OpenCode 固定二进制均未替换。

主机、板端 **49 项 Python 单元测试通过**，主机 **2 项插件测试通过**；Ruff、JavaScript/Python/PowerShell/Bash 语法、C# 实际构建通过。启用插件后，普通 `rk-memory` 在电脑观察服务停止时完成两个独立会话的随机值写入/读取，来源仍为 agent、verified=false，测试值随后由 verifier 清理，见 `logs/memory-20261029-074458/`。这也验证了非 fast agent 不会触发桌面观察。结束后测试窗口、助手与本次模型服务均停止，输入会话解除。此次为固定流程的一次最终通过，不代表长期成功率。

---

## 2026-10-29：三次模型决策的轻量测试循环

新增板端 `agent/compact.py`、`scripts/bench-compact.py`，testbench 默认 `--runner compact`；`--runner opencode` 保留上一节的原始编排。compact 直接复用现有 HTTP 模型桥、原生 KV 缓存与 `DesktopTools`，是固定任务的轻量 Python 编排，并非 OpenCode 自身已自动压缩为三轮。

程序先获取真实窗口观察，再交给模型选择输入动作；`DesktopTools.step` 验证并执行一次动作，自动返回新的观察。后续模型只负责选择 Apply 和 Alt+F4。程序确认输入内容、Applied 结果、关闭标志后停止，不再请求最终回答。窗口关闭仍需本次实际见过的 fixture PID 与标题匹配，本机另验输入值、Apply 次数及进程退出码。三个动作和参数都来自保存的模型原始输出；程序没有编造调用或用验收侧期望值替模型输入。

### 调试与最终结果

| 目录 | 结果 | 原因/证据 |
| --- | --- | --- |
| `logs/testbench-20261029-163208-87cc/` | FAIL，32.17s / 2 轮 | 输入成功；新输入文字框导致原编号变化，模型在新观察中沿用旧 Apply ID。业务校验在发送点击前拒绝 |
| `logs/testbench-20261029-163456-7326/` | FAIL，18.80s / 1 轮 | 模型把待输入文字写进 keys 而非 text，未发送输入。随后明确工具说明中 type/text、click/target_id、hotkey/keys 的对应关系 |
| `logs/testbench-20261029-163805-4095/` | **PASS，45.87s / 3 轮** | 输入 `02206873`，Apply 恰好一次，观察确认 Applied，再关闭并正常退出；自动观察四次，HID 动作三次，最终结果由程序验收 |

同一可见目标现在按来源、类型、文字及相近矩形维持稳定 ID；OCR 插入/重排其他文字框不再导致 Apply 的 ID 偏移。消失或歧义目标重新分配 ID。观察 ID 仍每次更新，一次消费、过期、前台、窗口、焦点与实时目标匹配校验继续生效。动作已经发出而观察失败时保留 executed 状态并退出；效果暂未出现时只允许有限重读，不自动重发输入。

### 与上一轮样例比较

同一模型、运行库、16K 上下文、OCR-only、固定显示器和验证码 `02206873`。时间均排除准备、编译/开窗与等待聚焦。

| 指标 | 原 OpenCode 样例 | compact 最终样例 |
| --- | ---: | ---: |
| 模型请求数 | 10 | **3** |
| 整体任务 | 144.62s | **45.87s** |
| 实际窗口关闭 | 131.38s | 45.78s |
| 模型请求合计 | 134.35s | 41.38s |
| 原生预填充 / 生成 | 76.22s / 58.04s | 18.56s / 22.74s |
| 本轮新增输入 token 合计 | 3737 | 948 |
| 实时 OCR 合计 | 1.91s / 8 次 | 1.35s / 6 次 |
| USB 发报告 | 606ms / 4 动作 | 529ms / 3 动作 |

整体样例耗时减少约 **68.3%**、约 **3.15 倍**。这是减少观察/最终回答调用、精简发给模型的数据、稳定目标 ID 及避免原样例额外 Ready 点击的共同效果，不是只修改轮数的严格消融 A/B。原 OpenCode 输出预算为 256，compact 为 128；最终实际输出各 39/34/35 token，均未截断。测试窗口聚焦在计时前完成。

最终三轮分别约 17.89 / 11.59 / 11.90 秒；新增输入 517 / 220 / 211 token，复用 KV 0 / 556 / 810 token。第二、三轮均 cache_reason=append，没有重建缓存。首次 OCR 约 501ms，实时 OCR 中位数约 164ms，任务后热运行中位数约 122ms。准备约 10.94s（其中模型启动 8.18s），开窗约 211ms，均另记。

主机与板端 **45 项单元测试通过**，新增覆盖三次决策后停止、自动观察失败不重发、效果未出现时只重读、错目标/提前关闭拦截、可见目标稳定身份以及原始 trace 的业务顺序验收；Ruff、Python/PowerShell/Bash 语法与 C# 实际编译通过。已停止本次自有进程与模型服务并解除输入执行。此轮是在固定流程下的一次最终通过，调试失败保留，不据此推导长期成功率或通用桌面能力。

---

## 2026-10-29：OCR / 模型 / USB 桌面 testbench

新增 `testbench.py`、`bench_report.py`、`scripts/bench-agent.py` 和 `测试桌面Agent.cmd`。测试台打开独立 WinForms 窗口；模型从公开的 OCR 文字框读取随机 8 位验证码，经真实 USB 键盘输入、鼠标点击 Apply，观察业务结果后发送 Alt+F4，最后观察确认窗口关闭。UIA 仅在内部校验焦点/窗口。实际输入期望值没有传给板端或放入模型任务提示；本机验收文件单独保存。

固定环境沿用 Qwen3.5-4B W8A8、RKLLM 1.3.0、16K 上下文、OpenCode 1.19.5 和原生缓存；PC 使用既有 PP-OCRv5 mobile / ONNX Runtime CPU 环境。开窗由测试台完成，本次不验证模型自主启动任意应用。

### 实机记录

| 运行目录 | 结果 | 说明 |
| --- | --- | --- |
| `logs/testbench-20261029-154710-a6fe/` | FAIL，17.68s | 首次模型工具 JSON 多出一个 `}`，桥接层严格拒绝，尚未进入观察或输入。失败未算通过，未放宽解析 |
| `logs/testbench-20261029-155140-eb5f/` | PASS，130.31s，8 轮 | 缩短专用 agent 提示并提供合法格式示例后，实际输入 `16652376`、Apply 一次、观察验证、关闭且退出 0；7 个后续请求均追加 KV |
| `logs/testbench-20261029-155948-db05/` | PASS，144.62s，10 轮 | 最终源码：计时字段只写日志、不进入模型工具结果；输入 `02206873`，保留前导零，Apply 一次、关闭且退出 0；9 个后续请求均追加 KV |

最终运行中第一次观察没有识别到 Apply；模型额外点击了一次 Ready，重新观察后才点击实际 Apply。窗口业务事件仍为一次 Apply，但总计四次 HID 动作、九次工具调用。比前一轮多两次模型请求，因此两次总时间不是严格 A/B，不能把差异归因于计时字段优化或缓存变化。原始目标 ID、OCR 文本、调用顺序均保留。

### 最终运行耗时

| 阶段 | 耗时/次数 | 计量口径 |
| --- | ---: | --- |
| 准备 | 10.72s | SSH、模型启动、编译测试窗、PC 助手就绪，不含等待聚焦 |
| 其中模型启动 | 8.00s | 模型服务从不可用到就绪；与请求的预填充/生成分开 |
| 开窗 | 208ms | 启动测试程序到 ready 文件出现 |
| 开始任务到实际关闭窗口 | 131.38s | PC 单调时钟与自身子进程退出观察 |
| 完整 Agent 任务 | 144.62s | 含 OpenCode 启动、确认关闭和最终回答，不含准备/等待聚焦 |
| 模型 HTTP 请求 | 134.35s / 10 次 | 占完整任务约 92.9%；单轮 5.61～23.74s |
| 其中预填充 / 生成 | 76.22s / 58.04s | RKLLM 原生回调，不重复计算已有 KV token |
| 实时截图 | 总计 70ms / 8 次 | 物理像素窗口截图 |
| 实时 UIA | 总计 317ms / 8 次 | 内部焦点与窗口校验 |
| 实时 OCR | 总计 1.91s / 8 次 | 中位数 215ms；首次调用 482ms；含 observe 和动作前 validate |
| OCR 初始化 | 476ms | PC 进程内导入/构造 OCR 对象，不含整个进程启动 |
| OCR 热运行 | 中位数 151ms / 7 次 | 任务后在同一 OCR 实例重复第一张截图，不混入任务耗时 |
| HID 发报告 | 总计 606ms / 4 次 | 输入约 403ms；点击各约 76ms；关闭快捷键约 51ms |

阶段有包含关系，例如 PC 动作校验也执行截图/UIA/OCR，不能直接把所有行相加。PC 与板端墙钟不同，本测试只用各自单调时钟测时，通过 OpenCode 会话摘要、桌面会话 ID 和观察 ID 关联日志。

最终工具返回后的新增预填充降为约 135～144 token，计时字段留在 `hid-actions.jsonl`。新增观察仍有约 613～692 个 token，且动作 JSON 生成约需 8.6～10.6 秒；当前主要瓶颈是模型处理新增屏幕数据、生成动作和额外决策轮次。缓存命中不等于后续请求无需计算。

两端 36 项单元测试通过，覆盖关闭后拒绝动作、USB Alt+F4 编码、按真实调用顺序验证 Apply/关闭，以及工具结果不携带计时元数据。Ruff、Python/PowerShell/Bash 语法与 C# 实际编译通过。结束后自有测试程序、PC 助手和本次启动的模型服务均停止，电脑/板端执行会话解除，原有 USB 复合配置保留。单次任务验收与整体成功率分开，不将三次调试记录表述为正式成功率评测。

---

## 2026-10-29：原生多轮 KV 缓存优化

最终方案保留 Qwen3.5-4B 现有权重和 RKLLM 1.3.0，通过原生多轮 `keep_history=1` 与只提交新增消息来复用缓存。没有覆盖模型、切换默认运行库或改动 USB 执行器。HTTP 完整消息接口保持不变；默认 Qwen profile 为 `native`，可用环境变量或请求头关闭。

### 实际 A/B 与功能结果

正式服务记录：`logs/kv-cache-20261029-045725/`。两组使用相同的三个问题、相同模型/运行库/16K 上下文、最多 32 输出 token、关闭思考；只是缓存开关不同。所有回答正确。

| 轮次 | 每轮重算 | 原生增量 | 本轮处理的 token（原生） | 复用 token |
| --- | ---: | ---: | ---: | ---: |
| 首轮长输入 | 24.623s | 24.727s | 1339 | 0 |
| 追问原验证词 | 25.535s | 1.163s | 35 | 1340 |
| 更新验证词 | 25.729s | 1.168s | 35 | 1376 |
| 合计 | **75.887s** | **27.058s** | | |

三轮合计约 2.805 倍加速、耗时减少约 64.3%；后续单轮约 22 倍。这是固定短回答的模型对话基准，不代表所有任务加速比例。单独的新会话正确回答 NONE，`kv_before=0`、重置原因为 `session_changed`；在同一 ID 下改写历史正确返回 RED，原因为 `history_changed_or_retried`。

真实 OpenCode 随机文件读取再次通过，记录为 `logs/agent-20261029-045910-49913/`。首次预填充 557 token，工具读取后仅预填充 101 token、复用 579 token，第二轮约 6.288s。模型真实执行了 read，并准确返回文件内随机值。

跨会话 SQLite 记忆再次通过，记录为 `logs/memory-20261029-045936/`（以该次 `status.json` 所在实际目录为准）。写入会话与读取会话均在工具返回后复用本会话缓存；两个会话之间重置，读取的是 SQLite 持久值。相关模型请求中，工具返回后的新增预填充分别为 124、128 token，已有缓存分别为 482、441 token。

主机与板端 **34 项单元测试通过**，新增覆盖缓存的会话隔离、历史/工具/指令变化、过期、重试、无会话标识、旧代次提交、原生预算不足回退、工具参数规范化、增量输入内容、用量计数以及失败/截断输出不提交。失败时会在错误 HTTP 回复前失效缓存，避免清理时序晚于回复。Ruff、Bash 语法与匹配头文件/库的 C++ 编译通过。

### 探索记录与边界

- 单独删除清缓存调用并升级到 1.3.1 的自动前缀尝试未提速：原输入结构不能完整接续上次所有 token。1.3.0 和 1.3.1 都仍需约 23 秒处理同一 1233-token 输入。原始记录保留在 `logs/kv-probe-20261029-143607/`，不将“没有报错”算作缓存命中。
- 1.3.1 日志明确要求缓存 token 全前缀匹配，并且新输入长于已有缓存；当前全历史重包装不满足该条件。官方关于 Qwen3.5 缓存的讨论：[Issue #519](https://github.com/airockchip/rknn-llm/issues/519)。
- 改为原生对话后，1.3.0 的增量问题仅处理 27/25 token，约 1.079/1.067 秒且回答正确。记录在 `logs/kv-probe-20261029-143607-native/`；`inputs.json` 保留控制模式。最初 summary 将非零控制模式都显示为 reset=true，派生的 `summary-corrected.json` 按控制模式修正元数据，原文件保留。
- 通过 OpenCode 固定版本源码及实际请求确认了会话头，参见其 [request.ts](https://raw.githubusercontent.com/anomalyco/opencode/v1.19.5/packages/opencode/src/session/llm/request.ts)。缓存不依赖猜测会话，也不向模型伪造工具结果。
- 只有一份原生缓存；交错使用不同会话会触发重建。原生上下文与完整请求仍受预算检查，首次输入、大量新增屏幕数据和输出生成仍然耗时。本轮没有重新发送 USB 动作，也没有声称原来约五分钟的整个桌面任务已降至上述耗时。
- 新 C++ worker 使用版本 2 的长度分帧协议；构建保留旧二进制到 `build/archive/`，改动前源码保存在本机 `logs/kv-code-before-20261029-145308/`。测试结束停止模型服务，下一次启动默认启用原生缓存。

---

## 2026-10-29：Qwen 4B、持久记忆和 USB 桌面闭环

本轮继续使用现有 OpenCode v1.19.5，新增 Qwen3.5-4B profile 和本地 MCP 工具。板端 Qwen 使用原应用的 Runtime/Header 1.3.0，DeepSeek 历史 profile 保留 1.3.1；没有下载新模型、覆盖权重或重新烧录系统。Qwen 上下文后续与同工作区的 16K 更新合并，最终检查使用 16384。

### 已通过的实际任务

| 检查 | 实际证据与范围 |
| --- | --- |
| 文件工具闭环 | 最初 4096 配置下连续三次读取随机文件并准确返回；最终 16K、read + memory 权限配置下再次通过。最终目录 `logs/agent-20261029-040807-48084/` |
| 跨会话记忆 | 真实模型在会话 A 调用 MCP 写入随机值；会话 B 的请求只包含键名，实际调用 MCP 读取并返回相同值。直接检查 SQLite 内容和 `source=agent, verified=0`。4096 和最终 16K 配置各通过一轮，见 `logs/memory-20261029-033137/`、`logs/memory-20261029-040842/` |
| 电脑观察与计划 | 指定前台窗口的 UIA、OCR、物理像素坐标与目标 ID 可用；模型调用 observe、act 后返回 planned，没有发送输入。见 `logs/desktop-plan-20261029-034916/` |
| USB 设备枚举 | 板端原 RNDIS Gadget 加入 HID 键盘与绝对坐标鼠标。Windows PnP 同时报告键盘、鼠标、USB 复合设备和原 RNDIS 网卡，状态均 OK；SSH 恢复并取消定时回滚 |
| 真实桌面闭环 | OpenCode / NPU 从屏幕读取随机代码 `35470120`，调用 USB 键盘输入，再调用 USB 鼠标点击 Apply，随后调用 observe 读到 `Applied: 35470120`。共五次完成的桌面工具调用、两次输入动作，进程退出 0。见 `logs/desktop-hid-20261029-040011/` |
| 独立应用验证 | WinForms 测试程序写出 `value=35470120, clicks=1, code_matches=true`；电脑 UIA 与测试程序结果均核对一致。随机期望值只供验证器使用，没有放进模型任务提示 |
| 协议和边界 | 主机与板端 25 项单元测试通过。覆盖鉴权、跨域拒绝、忙状态、上下文预算、思考隔离、参数校验、记忆持久化/过期/来源、观察过期/一次性消费/窗口与焦点变化、默认计划模式和旧会话拒绝 |

### 修复与失败记录

- 首次 4B 启动遇到同板另一项 Qwen 测试占用，分配失败。新增 worker 已与原 4B 应用共用 `.qwen35-4b-inference.lock`，不停止其他任务的推理进程。
- 第一轮桌面计划因 Windows UIA 的 COM 接口跨请求线程复用而卡住。观察服务改为单线程并保留 COM apartment，连续三次观察/校验以及后续真实任务通过。被中止的记录保留在 `logs/desktop-plan-20261029-034403/`，不计为成功。
- 第一轮物理输入测试时窗口不在前台，观察请求被拒绝；停止了该测试，未发出输入。失败目录为 `logs/desktop-hid-20261029-035445/`，退出码为 -15。重新激活测试窗口后使用新会话完成上述成功测试。
- 后台窗口拦截、单元测试、设备枚举、报告发送和最终任务完成分别记录；不以 HTTP 200、退出码 0 或设备节点存在代替业务验证。

### 性能、资源和限制

本次桌面样例包含六轮模型推理（五次工具调用和最终回答），调用耗时合计约 311 秒，单轮约 15～91 秒，最终输入 4023 token。事件时间跨度约 299 秒；这两个口径不同，整体任务约五分钟。当前上下文携带多轮完整屏幕观察，延迟明显，下一阶段应优先压缩观察和历史；本次没有把它称为实时桌面助手或做严格性能基准。

本次 worker 的 VmHWM 为 7,240,232 kB（约 6.91 GiB），结束时 VmRSS 为 6,624,312 kB（约 6.32 GiB）、VmSwap 为 0。结束时各温度传感器中最高读数 43.461℃，不是全程温度峰值。记录见 `logs/agent-resource-status.json`；未单独测 OpenCode 或 PC OCR 开销。

当前限定单显示器、精确标题的前台窗口、已观察控件与 US 布局 ASCII 输入。实际验证了数字输入与点击；中文/输入法状态、跨窗口流程、拖拽、无文字图标和多模态读屏尚未接入。本轮是隔离测试应用的一次完整任务，不代表通用桌面成功率或长期稳定性。

USB 配置保留原 RNDIS 函数和属性备份，启用时先启动两分钟回滚计时器，再重新绑定；正常恢复 SSH 后确认。未做断连失败条件下的定时回滚故障注入。重启后可能恢复厂家的纯 RNDIS 配置，需重新启用 HID。Windows 助手默认只生成计划，`-ExecuteHID` 才允许当前会话发送报告；助手结束后解除执行并关闭隧道。重跑启用操作的幂等性已验证，不改变已有设备状态。电脑助手的启动/停止清理已验证；测试完已停止助手与模型服务，记忆文件保留。板端目录时间戳沿用板端时钟，本次未修改系统时间，不应直接与电脑时钟对齐。

下文保留旧 DeepSeek 部署和独立 16K 调整的历史记录。

---

2026-10-29 Qwen 上下文更新：Qwen3.5-4B profile、HTTP 服务和 OpenCode 模型声明统一默认 16384；健康检查核对实际 context，避免沿用旧 4096 服务。主机和板端的 HTTP 协议检查均通过，包含超过旧 4K 的输入与超出新预算的拒绝。本条不改变下文 DeepSeek 历史测试结论；详细原始记录见父项目 `logs/qwen35-context16k-20261029-132235/`。

常驻服务重启后 `/health` 确认实际 context=16384。真实 API 短题回答 `5`；长输入 13626 字节、实际预填充 3200 token，正确找回开头的 `BLUE`。该请求超过旧的保守字节预算，不代表输入超过 4096 token，也没有验证填满 16K 的准确率。六个 HTTP 协议用例在主机和板端均通过。

日期：2026-10-28。设备：USB SSH 连接的鲁班猫 4，Linux ARM64 / Ubuntu 22.04，16 GB RAM。

## 固定组件

- OpenCode：官方 `opencode-linux-arm64.tar.gz`，v1.19.5，下载文件按固定 SHA256 校验。
- RKLLM Runtime：1.3.1，复用现有 DeepSeek 应用目录；NPU 驱动 0.9.8。
- 模型：现有 `deepseek-r1-1.5B-rkllm1.1.4.rkllm`，没有重新转换或覆盖。
- 当前模型上下文：4096。8192 启动实测失败，Runtime 报模型最大上下文 4096，已恢复。

## 通过

- `bin/opencode --version` 返回 `1.19.5`。
- C++ worker 在开发板编译成功，RKLLM 模型初始化成功。
- 最终文件已部署；板端 shell 语法与主机 PowerShell 语法检查通过，服务启动、重复启动健康检查、停止后健康检查不可用均已实测。
- 本地健康检查、模型列表和实际 NPU 文本生成成功。
- OpenCode `rk-chat` 提问 `What is 2 + 3? Answer briefly.`，最终文本事件为 `The answer is 5.`。
  该次实际计数：输入 148 token，输出 182 token（含推理）；不能推导其他问题准确率。
- 12 个自动化用例通过：消息/工具数据转换、思考内容隔离、错误参数、必需工具、文本输入限制、R1 提示模板、HTTP 鉴权、跨域拒绝、JSON/SSE、忙状态、上下文拒绝、未结束推理拒绝。
  主机与板端均通过。HTTP 用例使用假 worker，仅验证协议，不冒充真实模型测试。

## 未通过：完整 Agent 任务

验收方式：在工作目录生成随机 `VERIFICATION_TOKEN`，要求 OpenCode 实际读取并在最终回答中返回同一值。
仅输出 JSON、仅退出码 0、或仅表示“已经读取”均不算通过。

多次集成试验出现以下情况：

1. 模型输出错误的路径或把 `arguments` 输出成字符串，动作验证失败。
2. 一次 OpenCode 的 `read` 真实完成并获得随机内容，但模型再次读取且把路径改错，没有完成回答。
3. 试过抑制推理前缀，模型快速编造文件内容，已撤销这个改动。
4. 最终改为官方建议的用户消息指令和开放 think 前缀后，模型仍把路径生成成
   `/home/cat/rk-opsencode/workspace/probe.txt`，OpenCode 权限层拒绝，后续历史超过保守输入预算。

最终该轮 `logs/agent-status.json`：

```json
{
  "read_tool_completed": false,
  "answer_contains_actual_token": false,
  "exit_code": 1,
  "passed": false
}
```

因此本次交付状态是 **框架已安装、推理链路已接通、纯聊天冒烟通过、可靠 Agent 能力未完成**。
不能由现有证据把原因全部归结为模型尺寸，也不能认定只是 Runtime 版本：旧模型转换版本、提示模板、工具训练、上下文预算均需进一步评估。

## 后续验收门槛

1. 使用与 Runtime 匹配的模型，先通过独立文本准确率测试。
2. 使用固定测试集与多次随机文件测试评估工具参数、结果复述、错误恢复。
3. 在更长上下文和不同文件路径上通过后，再开放新增工具。

原始日志保留在板端与主机的忽略目录 `logs/`。不要将包含本地文件内容的日志直接上传公共仓库。


## 2026-10-29：Mem0 OSS 接入与来源保留压缩

已实际部署并启用，非仅候选方案。使用 `mem0ai==2.2.1`、`fastembed==0.9.1`、`onnxruntime==1.23.2`，板端 Ubuntu/Python 3.10 ARM64 独立 `.venv-memory`。Mem0 SDK 和 Qdrant 未改源码；自定义嵌入/LLM provider、短提取提示、控制目录和摘要层由本项目实现。嵌入固定 `Qdrant/bge-small-zh-v1.5` 提交 `46fbe35fd4374a00fee7de77dfddaeb6dd6a2c59`，`model_optimized.onnx` 94781076 字节，512维，两线程CPU。源码策略参考 Mem0 提交 `26cdefb46600c0fa5953c4b5ee5003c125539fc4`；实际安装包以锁定的 PyPI 2.2.1 及运行记录为准。

证据在电脑 `logs/mem0-board-20261029/`，板端对应原始日志目录保留。板端时钟与电脑有偏差，未调整系统时间；目录时间戳不可直接混为同一时区时刻。

| 验证 | 实际结果与证据 |
| --- | --- |
| 原型迁移 | `memory-migration-20261029-104040/`，用 SQLite backup API 保存 `legacy-backup.sqlite3`，当前有效记录为0，原库未改写 |
| 真实语义与生命周期 | 最终 `mem0-validation-20261029-105214-318180/report.json` 的21项检查通过：中文改写Top1、项目隔离、同键去重、新偏好/旧版本、TTL不复活旧值、禁止自证、召回预算、删除取消旧队列、新原文重新引入、真实SDK提取/重复去重、来源、压缩/来源关系/原始保留/自动失效，以及故障输出拒绝 |
| 真实SDK提取 | `Memory.add(infer=True)` 实际调用RKLLM，提取“开发板/项目名称”和“中文回答偏好”两条事实，均 `source=user_message, verified=false`。重复输入再提取，不增加事实数。不是绕过SDK直接写入的假验证 |
| 压缩 | 八条重复规则1383→172 UTF-8字节，比率0.1244；保留 `D:\RK\agent-output`、`512`、完整“不要自动覆盖已有文件”。有八个源事实ID，源事实仍在，召回替换成带来源摘要后213字节。删除一个源事实，摘要失效 |
| 首次失败保留 | `mem0-validation-20261029-104105-544246/`：模型将完整否定条件改写为“不覆盖现有文件”，逐字保护拒绝；未激活。修正提示为逐字复制 protected_spans 后通过，不放宽保护规则 |
| 跨会话MCP | 真实OpenCode/NPU两独立会话完成随机值写入和读取，退出码均0，实际值/来源正确。`memory-20261029-104*/status.json`；临时事实已删除 |
| 自动召回 | `mem0-recall-20261029-105310/`：独立rk-local会话只问中文改写问题，不提供随机目录或键；插件召回后模型返回真实随机目录，0次工具调用，约20.32秒。会话导出包含实际注入内容。前一轮 `104830` 也通过 |
| 重启与鉴权 | `mem0-runtime-status.json`：停止/启动Mem0进程后读回同ID同随机值；无鉴权请求403；enabled=true、auto_maintain=true。最后NPU已停，无残留worker，CPU记忆服务健康 |
| 回归 | 电脑及板端51项Python单元测试通过，3项Node插件测试通过；Ruff、Bash语法通过。新增单测覆盖前台到来后停止后续记忆推理、前台门等待当前推理结束；插件测试覆盖原文排队、召回数据标记、idle释放和benchmark不自动记忆 |

最终小样本耗时：中文语义查询约15.84ms（嵌入已加载、三个候选事实），真实事实提取25.32秒，重复输入空提取约8.4秒，八条规则压缩18.74秒。自动召回20.32秒是包含OpenCode启动和一次真实模型回答的整体耗时，不是向量查询时间。这不是大记忆库吞吐或通用准确率/压缩率基准。21项验收中提取/压缩的正常输出来自真实NPU，故意丢字面量/新增数值的错误摘要由测试注入，用于验证拒绝规则。

前台仅CPU召回/排队；空闲120秒且模型已就绪时批量维护，每批最多两条原文，再按八条阈值尝试压缩。新任务设置活动状态并等待当前不可抢占的一次推理，后续整理让路。仍共享NPU和唯一原生KV槽，整理可能增加下一任务等待并使缓存重建，未做负载压力下的延迟上界测试。当前部署仅稠密语义检索，未安装可选spaCy/BM25；SDK启动日志的对应资源缺失告警与语义查询通过分别记录。原始数据/SDK历史/备份保留，删除/TTL不是物理安全擦除；自然语言冲突自动裁决未完成。

本轮没有修改模型权重、运行库或USB/HID；未重跑桌面窗口动作基准，原64.9秒样例仍属此前记录。新Mem0回归不能作为跨应用桌面成功率或新桌面耗时证明。

## 2026-10-29：Coloop 请求级隐私与本地协调

新增 `X-RK-Privacy: metadata-only`、健康能力及响应回执，私密审计仅存白名单元数据。默认 native stderr 送 DEVNULL，原日志不清除；`--worker-log-mode raw` 禁用私密能力并拒绝私密请求。普通 HTTP 聊天仍保留原日志行为。

电脑执行完整60项Python单元测试通过，其中9项新增隐私测试；语法和Ruff通过。实机仅备份并原子替换 `bridge/server.py`，正常重启已确认的服务进程，未构建或替换权重/库。预检约34.23℃、8.66GiB可用内存；Qwen4B/Runtime1.3.0/16384/protocol2/native/隐私能力就绪。

证据 `D:\RK\logs\coloop-coordination-20261029-225344/`：随机串真实NPU精确回显，HTTP200、私密回执正确，约4.686秒，57 prefill/17 completion/cached0。新 `requests.jsonl` 仅一条362字节元数据；验证串出现0次，worker/bridge日志新增0字节。保留输入/输出SHA与匹配结果，不保存秘密正文。

Coloop真实Electron/SSH/NPU安全选项测试亦通过，具体接口来源（模拟或真实OpenCode）、适配器消费和限制见父项目 [协调报告](../docs/17-coloop-coordination.md)。该能力不是通用DLP，也未接入Codex桌面原生审批。

## 2026-10-30：Windows 软件桌面 skill 原型

新增独立8093回环鉴权软件输入服务、MCP windows模式、短skill预载及专用入口。复用窗口观察，保持旧HID入口；此入口只登记前台租约，没有记忆召回/写入工具。打开文件限启动时显式列出的文档/图片，键鼠使用SendInput；fill复合操作点击、核实焦点、替换并精确读回UIA value。

11项新增Python测试、既有桌面/fast/观察14项回归和4项相关Node插件检查通过。Windows真实六操作约5.393秒，包含中文追加及 `-00123.4500` 原样保留，应用独立记录Apply一次。真实Qwen4B/OpenCode在已激活测试窗口完成fill/fill/click与最终随机码 `97f30e7d8f` 返回；四次模型请求合计96.697秒、首末模型请求跨度99.761秒。原始记录 `logs/windows-desktop-20261030-145240-8137/`，默认Notepad关联打开另见 `logs/windows-association-20261030-150113/`。

首次接线、JSON、前台和观察过期失败全部保留，未修补/代造模型动作。真实RK成功样例使用测试工具先打开文件和Computer Use显式激活窗口，不能描述为跨应用自主打开到提交全流程，不能将工具层5.393秒当作模型整体延迟。使用、全部失败目录及范围详见 [Windows桌面skill报告](../docs/23-windows-desktop-skill.md)。

2026-10-30 后续：Windows OCR/UIA链路新增紧凑数组、去重、窗口身份绑定的增量视图及fill_form。`logs/windows-desktop-20261030-171730-35b5/` 真实Qwen＋OCR两轮通过（一次批量填写/提交＋最终随机码回答）；中文与 `-00123.4500` 正确、Apply一次、最终码 `4d85cfdebb`。模型请求合计46.547秒，新增1397 token，两个请求输出92 token；初始窗口投影1247→315字节的独立Windows记录见 `171208-437e`。42项相关Python检查中41通过、1项Linux锁检查跳过，4项相关Node插件通过。旧反向转发5秒读取超时导致已执行但回执丢失的失败 `171350-0bba` 保留；修正后新会话通过，未重放输入。旧四轮96.697秒与新两轮46.547秒是不同配置的单样例对照，不是严格A/B。父项目OCR脚本、旧HID入口和原始历史结果保持各自范围；完整参数、失败和限制见上述专题报告。
