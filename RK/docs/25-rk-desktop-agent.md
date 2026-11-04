# RK 端侧桌面 Agent（2026-10-30）

本轮把观察压缩、上下文管理和执行闭环放到RK端侧Agent，主入口为 `rk-opencode/RK桌面Agent.cmd`。实际链路：电脑只观察/校验 → RK Agent整理模型输入 → 本地Qwen决策 → RK本地函数 → USB HID → 电脑重新观察。MCP/OpenCode不是该原生入口的依赖，Windows软件键鼠、剪贴板、文件关联API和computer-use不参与验收动作。

## 入口与代码

先用现有 `rk-opencode/scripts/desktop.ps1 -WindowTitle '精确标题' -OCR -ExecuteHID` 启动指定窗口的电脑观察助手，再启动 `RK桌面Agent.cmd`。板端等价入口：

```bash
# 日常交互；沿用现有start.sh检查/按需启动匹配模型
bash ~/rk-opencode/scripts/hid-agent.sh
# 已有模型服务时自动任务，不重启服务；任务内容通过UTF-8文件传递
python3 ~/rk-opencode/scripts/hid-agent.py --prompt-file task.txt
# 可选：独立业务条件，不注入模型提示
python3 ~/rk-opencode/scripts/hid-agent.py --prompt-file task.txt --verify-file checks.json
```

原生交互中每条输入是一个新任务，`exit` / `quit` / EOF结束；不自动拼入上一任务的聊天历史或长期记忆。同一个任务的观察和工具历史由Agent按下述预算管理。需要原有连续OpenCode会话/记忆行为时，保留的兼容入口继续使用其原规则。

原生Agent仅绑定hid工具，无Shell、任意文件读取或其他应用权限。已有 `桌面Agent.cmd` / `轻量桌面Agent.cmd` 继续作为可选OpenCode入口；轻量入口默认调用同一 `HIDWorkflow` 获取紧凑/增量观察、批量填写和失败阻断，不需用户手动加 `--compact`，模型prompt改为短引用 `skills/rk-hid-desktop/references/agent.md`。普通OpenCode的MemoryPlugin与权限保持；原生桌面入口只登记自己的前台租约，不召回、排队或写入记忆内容。

| 文件 | 责任 |
| --- | --- |
| `agent/hid_agent.py` | 默认观察表示、原始任务、动作事实、提示预算、模型循环、真实工具派发、业务检查 |
| `agent/hid_workflow.py` | 完整观察缓存、模型投影、逐字段校验的批填、跨进程失败阻断 |
| `agent/desktop.py` / `hid.py` | RK获取前台、会话与逐报告校验、共享输入锁及实际 `/dev/hidg*` 报告 |
| `pc/observer.py` / `observations.py` | 只读窗口/UIA/OCR、标题栏命中测试、一次性reservation和实时guard |
| `scripts/hid-agent.py` | 本地CLI、独占任务锁、240秒/80℃保护、前台租约、真实请求及SDK指标留档 |
| `scripts/smoke-hid-workflow.py --agent` | 被动测试窗口 → 真实RK Agent/NPU → HID → 独立Windows结果验收 |

## 模型输入由端侧 Agent 管理

默认首帧紧凑控件表，后续工具结果用带base的增量；完整OCR/UIA数据留在RK给校验器使用，模型不处理矩形、DPI、截图摘要、运行时身份等执行细节。原始任务不截断，数值、空格和否定条件不通过模型摘要改写。这里只减少模型处理数据，未减少OCR本身计算或电脑到RK的完整观察传输。

`AgentContext` 在每次推理前用实际桥接 `prepare()` 计算包含system、任务、工具schema与历史的保守提示字节预算：默认10000 UTF-8字节，且不超过当前服务的上下文保守边界；这不是10000 token。超预算时用原始任务、真实动作回执和当前完整模型视图重建上下文，并启用新的原生KV会话。旧屏幕不再累积，也不会保留缺失base的delta或悬空tool消息；连重建结果都放不下则拒绝继续，不能悄悄删用户条件。该rebase分支已做边界单测，尚未做长对话NPU耐久验收。

模型侧采用浅层JSON工具schema和明确的调用/最终回答合同；`HIDWorkflow` 仍执行各操作的完整条件校验。模型参数不被补齐或改写。默认最多6次模型调用、单任务240秒、80℃中止；普通推理用严格追加的原生会话缓存。出错、输入未知或plan-only后停止，不自动重放。观察在模型规划后已太旧时，先返回“未执行”和新观察，再让模型重新决策，不把旧参数换个ID直接执行。

## 前台获取与键鼠都由 RK 执行

按用户新增要求，后续验收不再通过computer-use或Windows软件输入激活窗口。Agent启动时读取已配置窗口的可见标题栏元数据，经USB HID点击标题栏，再核对真实前台身份；电脑仅通过 `WM_NCHITTEST` 等查询证明该点是标题栏，没有调用SetForegroundWindow或输入API。

`/activation` / `/activate` 只绑定精确标题、HWND/PID、单屏/DPI/几何和未遮挡的标准标题栏。reservation只消费一次；每报告guard仍检查绑定窗口、坐标及命中类型，不能用于任意桌面坐标、键盘输入或其他窗口。普通动作的前台/焦点检查不放宽。最小化、隐藏、标题栏被遮挡或自绘标题栏无法证明命中时拒绝获取前台；没有通用Alt+Tab或跨应用切换能力。

测试窗口由主机作为测试环境预置启动，使用 `--no-activate` 被动显示模式；窗口预置不属于模型操作任务。之后获取前台、填写、提交全部为RK USB HID。该证据不证明RK已能独立启动Windows应用或打开任意文件。

## 完成与成功分开

`model_finished` 只表示模型收尾，`task_verified` 仅表示调用者提供的业务条件是否通过；未提供条件时为null，不能叫“已程序验证成功”。例如：

```json
{"fields":{"Text":" literal ","Number":"-00123.4500"},"labels":["Applied: expected-code"],"answer_contains":["expected-code"," literal ","-00123.4500"]}
```

这些条件只进入本地检查器，不进入模型输入；模型仍须从实际观察读值。最终回答后重新观察，字段名需唯一、真实value/标签与最终回答字面值分别核对。条件失败时最多给一次只读收尾澄清，让模型基于原始任务和当前观察重新回答；禁止再次键鼠输入/提交，仍失败则返回未验证结果。它是明确条件的核验，不是对任意自然语言任务的完整正确性证明。

## 处理加速与当前瓶颈（2026-10-31 整理）

**已验证同任务的模型输入处理加速。** 以下复核2026-10-30原始记录，2026-10-31仅补充文档分析，没有重新运行板端模型或改变历史参数。

六题固定观察A/B采用同一Qwen3.5-4B、相同任务提示与输出上限，12次请求均关闭KV缓存。结果来自 [原始报告](../logs/hid-observation-ab-20261030-221053/report.json)：

| 六题合计 | 原始观察 | 紧凑/增量观察 | 变化 |
| --- | ---: | ---: | ---: |
| 模型实际输入token，含固定提示与任务 | 9156 | 2244 | 减少75.49% |
| SDK prefill，即模型输入处理 | 168.088秒 | 41.082秒 | 耗时减少75.56%，约4.09倍有效加速 |

加速来自模型需要处理的token减少。两组输入处理速率都约54.5 token/秒，没有证据表明模型每token计算或NPU硬件本身变快。该A/B不执行HID，不能把4.09倍直接作为完整桌面任务的加速倍数；输出token也有差异，HTTP全程时间不作为纯输入加速指标。六题逐题输出、严格计分与失败类型见 [观察A/B协议](24-rk-hid-input.md#真实模型处理量-ab)。

独立的全RK真实操作样例 `e2e-5` 总耗时66.548秒。按 [模型SDK记录](../logs/hid-agent-layer-20261030-224152/e2e-5/agent/model-metrics.json) 与 [任务总计时](../logs/hid-agent-layer-20261030-224152/e2e-5/agent/status.json) 拆分：

| 环节 | 耗时 | 占总时间 |
| --- | ---: | ---: |
| 模型生成动作JSON与最终回答 | 28.575秒 | 42.94% |
| 模型处理输入 | 22.486秒 | 33.79% |
| 观察、校验、HID执行、通信及其余流程 | 15.487秒 | 23.27% |
| 合计 | 66.548秒 | 100% |

模型两阶段合计51.061秒，占76.73%，是当前主要耗时。PC侧 `/observe` 与 `/validate` 相对耗时合计约9.120秒，其中OCR本体约3.580秒；这些都是上述其余流程的子项，不能重复相加。PC日志 `/guard` 的snapshot可能沿用上次观察，不将其重复算作新OCR。计时只汇总各端相对耗时，不跨端相减墙钟时间戳。

后续优先精简固定system/工具描述及动作、收尾输出，再评估减少重复全量观察；保留完整参数、字面值、失败状态和业务核验。66.548秒是一次成功任务实测，并无相同完整任务的优化前后严格A/B，不能据此宣称通用端到端加速或操作成功率。

## 本次证据

固定目录：`logs/hid-agent-layer-20261030-224152/`。`e2e-5/summary.json` 为最终严格全RK样例，保存完整源码快照/SHA256、输入任务、独立检查条件、模型原始请求/响应、Agent trace、PC事件和窗口结果。测试直接调用已就绪的常驻模型，没有运行新模型启动/部署或更换权重、Runtime、USB绑定。

| 分层 | 最终结果 |
| --- | --- |
| 实际前台与执行 | `rk_foreground_acquired=true`；RK点击已授权窗口标题栏 → Qwen生成一次fill_form → RK发送7个字段/提交动作；所有派发参数与模型输出一致 |
| Windows业务 | Text为 `" HID_AGENT_e0281f4b "`，Number为 `"-00123.4500"`；Apply恰好1次，状态为 `Applied: FORM_55e32cd4c4b7`；三键和修饰键均释放 |
| 模型最终回答 | `Text=" HID_AGENT_e0281f4b "; Number="-00123.4500"; Code="FORM_55e32cd4c4b7"`，三个字面值均核对 |
| 实际模型循环 | 2次真实HTTP/NPU请求，无MCP；约66.548秒，最高53.615℃，本次未触发上下文rebase或只读收尾澄清 |
| 新增prefill | 第一轮980 token、17.997秒；第二轮新增218 token、4.489秒，`kv_before=1061`、`kv_after=1329`。第二轮的1061缓存token不当作新增计算 |
| 代码回归 | 主机相关73项：71通过、2项Linux锁检查跳过；板端73项全过。Ruff、Python语法、Bash语法、PowerShell解析、skill格式及C#实际编译分别检查 |
| 兼容入口 | 真实OpenCode debug config确认短引用已展开、HID和记忆权限仍allow；未做本轮完整OpenCode业务验收，不能替代原生Agent样例 |
| 部署与退出 | `verification-final.json` 核对安装清单全部SHA256一致；前台租约释放，execute_hid=false；原模型服务保持运行 |

失败和不同范围样例全部保留：

- `e2e-1`：初版模型工具输出被HTTP422拒绝，未改动字段/提交；其后改为浅层schema和明确合同，没有修补该次输出。
- `e2e-2`：用户停止computer-use，未发开始信号而超时，未运行模型/输入；之后增加RK自身标题栏获取前台，停止使用computer-use。
- `e2e-3`：全RK前台/模型/输入/业务状态通过，约59.171秒；当时收尾条件只核验证码，模型漏报字段值，不能当作后续严格全条件通过。
- `e2e-4`：模型生成参数后，测试state.json原子替换遇Windows短暂共享冲突，PC校验失败，字段和点击均未变。仅对只读fixture文件增加最多4次、间隔10ms的读取重试，不重放输入。
- `e2e-5`：上述最终严格任务通过。不同版本、条件和一次用户中止不能汇总为通用成功率。

相关入口：源能力/六题观察A/B见 [HID专题](24-rk-hid-input.md)。本轮只证明单窗口、单屏、标准UIA表单及US布局ASCII的真实Agent闭环；纯HID中文、应用启动/任意文件打开、跨应用与大规模操作成功率仍未验收。


## 2026-11-01 设备重连与恢复

本轮通过固定SSH指纹重新连接实机。Windows RNDIS接口为15，本机备用IPv6作用域由%41更新为%15；随后原IPv4也已实际SSH登录成功。此前IPv4超时的根因未确定，不据此归因于接口编号。板端时钟仍停留在10月31日，本轮目录按用户时区日期11月1日命名，不跨端比较墙钟。

检查发现USB只有rndis.gs0，未创建hidg节点，模型和Mem0服务未启动。使用现有host.py hid-enable及120秒回退/重连确认恢复键鼠；start.sh与start-memory.sh恢复原有服务，没有更新模型、运行库、内核或依赖。HID仍为运行期配置，未新增开机自启。

原生scripts/hid-agent.sh补充start-memory.sh前置检查，与既有OpenCode入口一致，防止已启用记忆配置时前台租约接口未启动导致任务直接失败。板端原文件备份为scripts/hid-agent.sh.backup-recovery-20261101，上传后SHA256一致，bash -n与服务健康检查通过；新摘要f492a711a989907448ef7d95611734817829ed55879cbdbc37e17f5fef6ec8a9。

- logs/desktop-recovery-20261101-agent/及agent-ready/：前台租约依赖未就绪，连接拒绝；保留失败，不计成功。测试汇总还暴露缺失agent-trace时的后续错误，未在本轮扩大修改。
- logs/desktop-recovery-20261101-all-services/：真实模型调用并执行HID，模型任务结束但task_verified=false。要求尾部一个空格，实际模型参数及字段尾部两个空格，最终回答尾部三个空格；参数未被主机修补。提交一次、数字与随机状态码正确，仍按严格条件失败，约85.882秒。
- logs/desktop-recovery-20261101-direct/summary.json：不使用模型的真实HID批填、OCR/UIA回读、字面值、一次提交、释放状态与不支持字符拒绝全部通过。原始观察2691字节、紧凑417、无变化增量70。
- logs/desktop-recovery-20261101-observer/status.json：测试结束后另启动隔离窗口观察助手与SSH回环隧道，health通过，execute_hid=false。不绑定用户其他应用，不代表已授权对其输入；使用完可通过scripts/stop-desktop.ps1停止。

本轮恢复了当前运行期的基础链路，未证明模型严格字面值任务可靠，也未改变单窗口、单屏、ASCII和跨应用未验收的边界。


## 2026-11-01 输入前字面值空格保护

原生Agent的agent/hid_agent.py增加输入前检查：只从用户任务中解析合法JSON双引号字符串，给模型列出原值、长度及首尾ASCII空格数。fill_form或act/type的文本若与某个明确字面值仅首尾ASCII空格不同，且不等于任何原字面值，则在调用HIDWorkflow之前拒绝整次输入。回执明确not_executed_literal_mismatch并重新观察，允许模型重新决策一次；第二次同类错误停止。原模型参数逐字留在trace，不裁剪、不填补、不静默修正，不改变底层HID schema。只有已证明完全未派发的该分支可继续，实际输入异常、未知结果及收尾核验失败仍遵循原禁止重放规则。

该保护不推断字段语义，不检查其他字符错误，不把屏幕文字、普通引号之外的自然语言或独立验收预期值转成输入；任务本身不是授权边界，仍受既有窗口/动作授权约束。未提供合法双引号字面值时保持原行为。计算所得文本或两种写法都在任务中的情形不会据此修改。重复字面值表同样计入上下文预算，超预算仍拒绝，不截断用户任务。

部署清单及源码快照见logs/desktop-literal-guard-20261101/manifest.json。仅更新agent/hid_agent.py与相关测试，旧文件位于板端.runtime/literal-guard-backup-20261101/；没有替换模型、运行库或OpenCode配置。主机相关41项与板端相关39项通过，Ruff、Python语法通过。新增用例覆盖先拒绝后真实新决策、连续错误无输入、转义引号、非推断值、允许的不同空格字面值和畸形fields。

真实HTTP/NPU/HID样例见同目录e2e/summary.json：task_verified=true，原参数未改写，Text精确保留首尾各一个空格，Number为-00123.4500，Apply一次，实际状态/随机码和按键释放核对，约65.391秒。最终Code字符串含Applied:前缀，现有answer_contains检查仅核包含随机码，不据此声称最终格式完全严格匹配。完整passed仍为false，因为acquire_foreground返回already_foreground/executed=false，未发生测试要求的RK标题栏点击；保留原判定，未放宽验收。本次模型首轮直接生成正确空格，未触发新增拒绝/重规划分支；该分支本次只有单元测试证据。不能把上一轮失败与本轮一次业务通过当成功率或速度A/B。

## 2026-11-01 独立云端转达模式

新增 [云端规划与 RK USB 转达试验](27-cloud-hid-relay.md)。它通过Coloop的独立入口处理固定Chrome/Bilibili任务，使用新窗口句柄和Run框专用许可；不放宽上文原生单窗口模式的授权，也不将新样例升级为通用跨应用质量结论。
