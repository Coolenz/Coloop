# Agent 原生 Hook、上下文与快审协议

说明日期：2026-10-30。Coloop 0.9.0 已通过独立真实模型闭环和受控源下的 Hook＋真实 RK 审批性能验收；后者不代表主模型开发成功率。对应程序版本、部署摘要和最终结果见 [验收记录](verification.md) 及每次实验的 manifest。

**0.10 当前默认入口为 `coloop-managed.sh`。** 已增加经 RK 判断、主机 Ed25519 签名及来源二次验签的一次性文件快照读取，真实未知随机串闭环通过。受控配置只使用本地 RK、固定插件与私有 HOME/XDG，不加载 Mem0 插件；读取冻结扫描结果，避免内置 read 审批后重新读文件和附带读取其他内容。下面的 `coloop-opencode.sh` 与“所有 allow 等待”段落记录 0.9 普通配置行为，仍适用于旧版入口。新入口、签名/路径/截止点约束及证据见 [0.10 受控审批](../../RK/docs/20-coloop-managed-approvals.md) 和 [分层测试](../../RK/docs/19-coloop-managed-approval-evaluation.md)。

## 采用的开源接口

运行内容直接来自 OpenCode 的消息、工具和会话事件，不经过 OCR、终端画面识别或模拟审批窗口点击。集成固定使用 **OpenCode 1.19.5** 的接口，参考提交为 [`810c0eba1a7348036f8bdf61e6632d0c36c6876c`](https://github.com/anomalyco/opencode/tree/810c0eba1a7348036f8bdf61e6632d0c36c6876c)，许可证为 [MIT](https://github.com/anomalyco/opencode/blob/810c0eba1a7348036f8bdf61e6632d0c36c6876c/LICENSE)。

参考的另一项开源设计是 HumanLayer 的会话镜像与 outbox 思路，固定参考提交为 [`316e74ef9af0b7b3d64ac45b5eb93415b3ed2204`](https://github.com/humanlayer/humanlayer/tree/316e74ef9af0b7b3d64ac45b5eb93415b3ed2204)，许可证为 [Apache-2.0](https://github.com/humanlayer/humanlayer/blob/316e74ef9af0b7b3d64ac45b5eb93415b3ed2204/LICENSE)。其 [Riptide 插件说明](https://github.com/humanlayer/humanlayer/blob/316e74ef9af0b7b3d64ac45b5eb93415b3ed2204/apps/riptide-opencode-plugin/README.md) 面向 OpenCode 2.x，不能直接当作本项目 1.19.5 的兼容实现。本项目没有安装、打包或调用 HumanLayer 运行库，也没有引入它的守护进程或账户服务。

本项目插件只使用 Node 内置模块：`D:\RK\rk-opencode\plugins\coloop-hook.mjs`。原有固定版本 SDK 准备方式继续保留，不为 Hook 升级 OpenCode 或模型环境。

## 事件通知与真实审批等待

插件观察 `chat.message`、`tool.execute.before`、`tool.execute.after`，以及消息正文更新、`session.status`、`session.compacted`、删除/错误和原生 `permission.asked` / `question.asked` 事件。工具执行前目前提供工具名；工具执行后可提供净化的文本结果，不代表所有工具参数都已完整捕获。助手的 reasoning part 不作为普通正文上报。

OpenCode 的事件通知本身不是一个等待返回 `allow` 的审批钩子。固定版本的插件宿主不会把异步 `event` 回调当作阻塞审批闸门；本项目也没有声称接通类型声明中存在、但此运行路径未调用的旧 `permission.ask`。真正的等待由上游 [权限模块](https://github.com/anomalyco/opencode/blob/810c0eba1a7348036f8bdf61e6632d0c36c6876c/packages/opencode/src/permission/index.ts) 和 [问题模块](https://github.com/anomalyco/opencode/blob/810c0eba1a7348036f8bdf61e6632d0c36c6876c/packages/opencode/src/question/index.ts) 的 pending / Deferred 机制承担。

流程是：原生事件触发插件后台处理 → Coloop 接收结构化事件 → 规则筛选与 RK 判断 → 插件重新查询原 pending 并核对完整摘要 → 回复原 API → 再查询确认请求被消费。一次 HTTP 回写被接受和业务动作完成仍需分别验证。上游权限拒绝可能联动拒绝同会话的其他等待项，不能把“一次 reply”扩大解释成只有一项业务受影响。

源 pending 查询与回写使用固定版本插件输入中的 `client._client.request`，保留该 SDK 的同进程 custom fetch、鉴权头和目录上下文。默认 TUI 可以完全不监听 TCP；其 `serverUrl` 中的 localhost 地址可能只是占位，插件不会因此连接陌生的4096端口，也不会为观察而额外启动 OpenCode 服务。若缺少这一同进程 SDK 能力，插件保持不启用，而不是退回端口探测。Coloop 接收端仍使用独立的鉴权回环通道。

目前仅支持单题、单项、既有安全标签的选择，以及明确的权限拒绝。没有通用自动放行开关：所有权限 `allow` 仍保留 pending，原因 `UNVERIFIED_AGENT_DATA_ROUTE`。未知 metadata、多题、多选、含糊选项、变更请求和不支持的模型输出保留等待或明确拒绝；不编造新选项，不发送永久授权。Codex 桌面原生审批尚未接入。

## 连接方式

Coloop 启动本机随机端口的鉴权回环服务。连接 RK 后，上位机通过既有固定指纹 SSH 自动建立板端回环反向转发，上传应用私有插件、启动器和当前会话连接文件。板端连接文件位于选定服务目录的 `.runtime/coloop-hook/connection.json`，目录为 `0700`、文件为 `0600`；令牌不进入渲染进程、命令参数或普通任务历史。

板端默认目录的完整启动示例：

```bash
COLOOP_HOOK_CONNECTION="$HOME/rk-opencode/.runtime/coloop-hook/connection.json" \
  bash "$HOME/rk-opencode/scripts/coloop-opencode.sh"
```

服务目录可以在 Coloop 设备配置中更改，命令中的路径应随之调整。启动器只给现有应用附加原生插件和本地 `rkllm` 提供商的私密日志请求头，沿用现有 `opencode.sh` profile；不会下载权重、安装 HumanLayer 或改全局代理。常规启动将日志等级限制为 `ERROR`。

连接断开或应用退出时，Coloop 释放自己的前台租约和转发，并仅删除 sourceId 仍属于当前连接的远端连接文件。插件在进程初始化时读取配置，重新连接后需重新启动带 Hook 的 OpenCode 会话；不能假定旧进程会自动读取新令牌。现有独立 Agent 是否继续运行由它自身管理。

如果电脑上另有可用的 Windows OpenCode 1.19.5，可在它的项目配置中添加本地插件，保留已有其他配置：

```json
{
  "plugin": ["file:///D:/RK/rk-opencode/plugins/coloop-hook.mjs"]
}
```

```powershell
$env:COLOOP_HOOK_CONNECTION = Join-Path $env:APPDATA 'coloop/agent-coordinator/connection.json'
# 再按该 Windows OpenCode 安装原有方式启动项目。
```

该变量只在当前终端生效。默认本机连接文件由 Coloop 建立当前 Windows 用户专属 ACL；需要指定 `workspace` 或 `sourceId` 时，应使用同样受保护的私有连接文件，不把令牌提交到项目配置。源码支持本机插件入口不等于已经验证另一台电脑的 OpenCode 安装。

## 接收协议与身份绑定

复用协调服务的 Bearer 鉴权、数字回环监听、拒绝浏览器 Origin / Sec-Fetch 请求和 **32KiB** JSON 请求上限。新增接口：

| 接口                    | 用途                                         |
| ----------------------- | -------------------------------------------- |
| `POST /v1/hooks`        | 接收普通消息、工具和状态事件，不等待模型判断 |
| `POST /v1/hooks/review` | 接收真实待处理审批，返回绑定的评审结果       |

事件信封示例仅含合成数据：

```json
{
  "version": 1,
  "source": "opencode",
  "sourceId": "example-source",
  "instanceId": "example-process-epoch",
  "sessionId": "ses-example",
  "taskId": "msg-example-task",
  "sequence": 1,
  "eventId": "example-event-1",
  "kind": "message",
  "workspace": "D:\\RK",
  "payload": {
    "text": "检查源码并运行本地测试。",
    "role": "user",
    "messageId": "msg-example-task",
    "partId": "part-example"
  }
}
```

`source` 固定为 `opencode`。sourceId、instanceId、sessionId、taskId、eventId 为长度不超过128的受限标识；sequence 为大于等于1的安全整数。kind 为 `message`、`tool.before`、`tool.after`、`status`、`compacted`、`closed` 或 `approval`。未知字段拒绝，不把任意原生对象直接透传。

隔离键包含 **source + sourceId + instanceId + sessionId + taskId**。新进程的 instanceId 和新用户消息的 taskId 防止把旧任务正文重新贴到新任务下；同 messageId / partId 的完整正文更新按角色覆盖旧项。sequence 必须递增，相同 eventId 的完全相同信封可幂等接收，内容冲突、乱序或旧序号拒绝。工作区需存在且通过主进程可信根校验，来源不能用自述路径扩充权限。

审批 payload 的 `approval` 包含 `kind`、原 `id`、`sessionId`、`originalDigest`，以及相应 `tool/patterns/command` 或 `question/choices`。originalDigest 为原生 pending **完整对象**的规范 JSON SHA256；规范 JSON 按对象键排序、紧凑序列化、UTF-8 编码。它与缩减给模型的内容是不同数据。审批 sessionId 必须和信封 sessionId 一致。

Coloop 响应包含原 sourceId、instanceId、eventId、sequence、originalDigest、标准 reviewEvent、decision 和分段 metrics。decision 的 requestHash 绑定完整 reviewEvent；插件还逐项核对原始操作字段，不能仅凭模型返回一个标签就执行回写。原 pending 被再次读取、完整对象摘要一致且决定仍在有效期内，才向原请求提交一次响应；网络结果有歧义时不盲目重发 POST。

## 时钟、寿命与短期上下文

`emittedAt` 可作为观测字段，但不作为到期依据。板端和 Windows 的时钟可能不同步，不能拿它们的 wall clock 相减。**Coloop 在首次收到审批时赋 createdAt，期限固定180秒。**重复信封或同原审批的新通知复用同一 reviewEvent，不刷新寿命。

每个审批建立不可变的 `contextRef`，绑定来源隔离键、上下文代次、当前事件和创建时间。Coordinator 的 Hook 账本包含该引用，避免两个来源复用相同 session/request 标识时串用决定。只有完整 reviewEvent 摘要、scope 和代次都匹配时，引用才能解析。后续新正文不改写已经提交的审批快照；`compacted`、`closed`、过期或服务重建会让旧引用失效，在途的迟到结果也不能恢复为可用选择。

| 限制             | 当前实现                                       |
| ---------------- | ---------------------------------------------- |
| 活跃任务上下文   | 最多32个隔离 scope                             |
| 单个 scope       | 最多16条、8KiB UTF-8                           |
| 全局内容预算     | 256KiB，包含保留的审批数据和不可变上下文快照   |
| RK 即时投影      | 最多192 UTF-8字节、近期最多4项概况             |
| 快审 user prompt | 最多1536 UTF-8字节，另加固定短 system          |
| 空闲上下文寿命   | 五分钟；释放本 scope 的前台租约                |
| 原审批记录       | 活跃与过期标识合计最多1000个，满后明确拒绝接收 |

源插件先做有界合并和已知敏感内容过滤，源文本最多约2KiB，超出时标记截断；这不是完整工具审计。上位机再次净化已知凭据和个人信息，本机短期观察仍可保留16条/8KiB，界面只展示不超过200字符的净化摘要。

源插件的数据队列把待发和在途项目一起计数，全插件最多128条/256KiB、单 scope 最多64KiB；跨 flush 的同一正文 part 可覆盖尚未发送的旧快照。超限清除待发正文、取消本 scope 的在审工作并记录固定原因码，不能用缺失上下文继续审批。退役的固定关闭通知另限64条。源会话最多64个，容量满时仅回收没有待发/在途/审批的空闲 LRU 会话；全部忙碌时明确报告容量原因，不静默自动审批。已回收会话不能在同一插件实例中重新接入，需新会话或重启来源。

RK 收到的是另一层最多192字节的即时投影：kind、tool、state 概况由接收时已校验的结构字段构造，不从任意 JSON 正文提取“事实”。正文不超过64 UTF-8字节且整体预算足够时可以原样整条保留；长正文或预算不足时只放该项元信息和 `[body omitted]`，不截断路径或否定条件。投影最多选择近期4项，明确作为 untrusted context。contextRef 同时绑定本次审批、隔离 scope、代次和该不可变投影；`metrics.contextBytes` 记录实际送 RK 的投影字节数，与界面的本机内容计数不同。

`compacted` 清空旧观察并使旧审批失效，之后可以接收新的上下文。`closed` 关闭该任务；同一关闭任务不能靠更高 sequence 复活。空闲过期后更高序号可冷建上下文，但过期原审批仍不能重审续期。过期审批正文和快照被释放，只留有界的原标识/摘要 tombstone；达到容量时 fail closed，不为腾空间丢掉防重放边界。此状态属于当前 Hook 服务生命周期，不是长期事实记忆。

四类暂时失败 `MODEL_BUSY`、`REQUEST_IN_PROGRESS`、`REVIEW_UNAVAILABLE`、`REVIEW_TIMEOUT` 可在同一信封和原期限内重试。确定性拒绝、选择和非暂时性等待复用原结果；原摘要改变报冲突，到期原审批报 `HOOK_APPROVAL_EXPIRED`，不会用新通知重开180秒窗口。

## RK 快审与记忆调度

当前规则先检查本次请求，历史只作为未验证观察，不能扩大权限。可直接判断的拒绝不激活或等待 NPU 前台租约。只有规则候选且 contextRef 有效时，Coordinator 调用 `beforeGenerate`，由 Hook 服务重新验证引用、激活并等待自己的前台租约，再进入 RK；生成后再次检查上下文和期限。

Hook 候选走短英文提示和严格整数输出，上限 **16 output token**。问题只接受当前安全候选列表的索引，短例子明确 offline 位于不同索引时的选择；非空候选提示不提供 `-1` 选项，但模型真实输出 `-1` 仍保留等待，不能由程序改成选择。权限映射为 `0=deny`、`1=allow`、`2=defer`。超范围整数、解释、Markdown 或其他格式均不作为动作。索引映射回本次真实 choiceId，不新增候选。没有 contextRef 的原协调 API 继续使用既有 JSON 决定格式。

审批请求继续带 `X-RK-Privacy: metadata-only`，并核对板端隐私能力与响应回执。Hook 快审固定关闭模型缓存：滚动窗口、压缩和多来源切换不满足原生缓存要求的“同会话严格追加”。原 Agent 与审批共享一个 worker/KV槽，独立审批还可能令主 Agent 下一轮冷建，不能把缓存 token 当作新增计算量，也不能宣称完全没有主任务成本。

普通 Hook 到达只更新有界内存，不触发 NPU 摘要或嵌入。Hook 的 Mem0 接入仅用于自己的前台活动租约：忙碌来源约每30秒心跳，普通接收不等待维护排空，需要模型的候选才等待。idle、关闭、过期、断开和正常退出释放自己的占用。保留既有120秒空闲维护与不可抢占的一次整理；已经开始的整理可能增加延迟，不能保证繁忙时仍满足热服务指标。

**Hook 路径不调用 Mem0 的 recall、enqueue 或 set。**工具结果、通知、审批JSON和模型自述不会被它升级为长期事实或已核实用户要求。但是，常规 `coloop-opencode.sh` 仍沿用已有 `opencode.sh` 和 MemoryPlugin：适用的正常 user 消息仍按原策略召回、排队及空闲提取。附加 Hook 不等于关闭普通聊天记忆，也不能把 Hook 的“不写长期记忆”扩大为整场 Agent 会话完全不保存用户文本。基准模式隔离这些插件，正式测量不自动写长期记忆。

## 日志与信任边界

Hook 上位机不把普通正文写入任务历史或审批审计；常规审计只保留绑定摘要、类别、结果、原因码和耗时，短期摘要留内存。模式识别和净化规则不能证明任意文本完全不含秘密，摘要也不是匿名化。原始审批只作为当前决策的临时输入，不作为授权来源。

OpenCode 自身的会话库、工具日志、错误信息和其他插件可能仍保存工具输入、选项和回答。启动日志等级 `ERROR` 只减少一般运行日志，不保证错误或源会话记录完全脱敏。上位机的 metadata-only 和 RK 请求级日志保护不能替代源 Agent 的日志策略，也不会清理历史备份。性能验收使用合成数据，源日志检查与上位机日志检查分别记录。

鉴权令牌和连接文件的保护范围是当前 Windows 用户、既有板端账户与固定指纹 SSH 会话。持有当前用户令牌的进程可以提交来源标识；这些标识用于隔离和绑定，不是独立硬件证明。恶意同用户进程、板端账户完全失陷或上游把安全标签解释为其他动作，不在此软件隔离保证内。选择“离线”只代表回复原标签，是否真的离线仍需原执行器的业务验证。

## 测试指标与复现

目标按不同环节计时，不能把 HTTP200、合法整数或快速拒绝当成完整审批成功：

| 指标                            | 正式目标    | 样本口径                  |
| ------------------------------- | ----------- | ------------------------- |
| 普通原生事件到 Coloop 回执      | P95 ≤100ms  | 至少100条                 |
| 明确规则拒绝完整往返            | P95 ≤150ms  | 独立规则样例，至少10条    |
| 原生审批产生到原 pending 被消费 | P95 ≤3500ms | 1次预热单列，之后至少20条 |

百分位采用 nearest rank，另报 P50、最大值、失败数、实际完成数和请求参数。完整闭环从源插件观察审批开始，由**同一进程的 performance.now()**记录收到评审、重新核对、提交和确认消费；Coloop 内部分段单独测量。source `payload.metrics` 只允许有限、非负的 `hookToConsumedMs`、`reviewMs`、`sourceConsumeMs`，它们是观测数据，不参与授权。

失败、超时、保留等待、未消费或样本不足都必须保留并导致相应正式验收失败；不能只取成功项或在事后降低阈值。冷启动、模型忙碌、记忆维护占用与断线恢复分别标注，不能把热服务结论外推为任何负载下的延迟上界。少量 `--pilot` 样本只检查功能，不能作为性能达标证据。

当前保留两条独立证据。生产入口的私密 question-only 配置使用 stock `--mini`、真实 Qwen primary 和真实 RK reviewer，在 [功能实测记录](D:/RK/logs/coloop-internal-hook-1793295194567/summary.json) 中完成一次原生问题审批、SDK 消费和最终回答精确匹配；没有 source fixture、额外源 TCP listener、OCR 或 Python 代回审批。该次 asked→consumed 为 **2957.742672ms**，整项任务为 **53.047s**；三次模型调用均记录为 private/metadata-only。这证明一次实际模型闭环可用，不构成20条样本的 P95 性能验收。

另一条是受控源性能测试 `tools/bench_coloop_hook_transport.py`，报告明确标记 **`source_model_scripted`**：真实 OpenCode 1.19.5 的源 OpenAI 兼容测试服务只依据本次 user 参数确定性发出工具调用，再原样回显真实 tool result 中的选择标签；它不回复审批、不注入 expected offline、不代替 RK 判断。审批仍由真实 RK、原生 pending、完整原摘要校验和 SDK 回写/消费组成。[正式结果](D:/RK/logs/coloop-hooks-benchmark-1793296894702/summary.json) 为100条事件接收 P95 **22.200ms**、10条规则拒绝 P95 **28.279ms**、20条原生审批 P95 **3008.326ms**（最大3029.731ms），20/20成功、0失败；另列预热3124.880ms。21次真实RK调用全部metadata-only，42次受控源请求只发题/回显，长期记忆计数未变。这证明本次热服务下 Hook/RK 传输和审批性能达标，不能称为20次真实模型开发任务成功率。

界面统计最近已消费回执，包括预热，因此该次界面为21条/P95约3.03秒；正式benchmark单独排除预热，以20条计算上述3.008秒。普通事件的100条是结构化信封在本机回环的接收往返，不冒充完整源网络采集延迟。

原 all-NPU-source 测试的失败保留在 [1793295293416](D:/RK/logs/coloop-hooks-benchmark-1793295293416/summary.json) 和 [1793295660254](D:/RK/logs/coloop-hooks-benchmark-1793295660254/summary.json)：primary 在产生审批前返回422，未形成可消费的审批样本，不是一次成功快审。[单次原始输出诊断 1793296283889](D:/RK/logs/coloop-source-json-diagnostic-1793296283889/summary.json) 确认嵌套 question JSON 的括号错序；严格拒绝正确，不自动修补模型输出。该诊断仅对一条固定合成消息显式移除了 metadata-only 请求头，记录为非私密诊断，不能据其他私密运行的结果宣称所有日志都只含元数据。

代码级检查：

```powershell
Set-Location D:\Coloop
npm.cmd run typecheck
npx.cmd vitest run tests/agent-hooks.test.ts tests/coordinator.test.ts
node tests/hooks-e2e.mjs
```

受控源性能基准需要已连接的 Coloop 和当前会话的私有连接文件，开发板密码仅通过当前进程 `RK_BOARD_PASSWORD` 提供，不写入命令参数或报告：

```powershell
Set-Location D:\RK
$experimentDir = 'logs/coloop-hook-transport-' + (Get-Date -Format yyyyMMdd-HHmmss)
.\.venv\Scripts\python.exe tools/bench_coloop_hook_transport.py `
  --connection "$env:APPDATA\coloop\agent-coordinator\connection.json" `
  --output-dir $experimentDir --hook-samples 100 --samples 20 --warmup 1
```

原 `tools/bench_coloop_hooks.py` 保留相同连接和采样参数，作为 source primary 的工具 JSON 质量与真实模型端到端选项；它的生成失败不能被受控源样本覆盖或改记为成功。

隔离 Electron 测试使用自己的连接文件，需将 `--connection` 指向那个文件。`tests/hooks-e2e.mjs` 也可通过进程环境选择真实板端或试跑；未设置硬件测试变量的运行仅证明本机接收和界面行为。每次基准保留 source/plugin/模型版本与输入摘要、全部样本、原生 pending/消费证据、日志检查、资源状态和清理结果。

关键源码为 Coloop 的 `src/shared/hooks.ts`、`src/main/services/agent-hooks.ts`、`src/main/services/coordinator.ts`、`src/main/infrastructure/board.ts`，以及 `D:\RK` 工作区的 `rk-opencode/plugins/coloop-hook.mjs`、`rk-opencode/scripts/coloop-opencode.sh`、`tools/bench_coloop_hook_transport.py` 和 `tools/bench_coloop_hooks.py`。原有通用协议见 [协调开发说明](agent-coordination.md)。
