# RK OpenCode：鲁班猫 4 本地 Agent

2026-10-30 桌面主线新增原生 `RK桌面Agent.cmd`：RK端 `agent/hid_agent.py` 默认管理紧凑/增量观察、上下文预算、实际回执和业务核验，通过本地模型及函数执行USB HID，无MCP依赖。可见目标窗口的前台获取也由RK点击标题栏完成。现有轻量OpenCode入口默认复用同一HIDWorkflow投影/批填/失败策略，保留其记忆插件；原生入口不自动读写记忆内容。真实模型→HID→窗口值/最终回答的严格样例已通过，详见 [RK端侧桌面Agent](../docs/25-rk-desktop-agent.md)。

2026-10-30 私密凭据属于统一记忆系统：`scripts/setup-memory-management.py` 更新现有 Mem0 私密引用目录及本地管理接口，Coloop 在单一「记忆」页面共同搜索、分类、新建和删除普通／私密记忆，普通内容可编辑并保留历史。设备通过原有记忆 `search/get/recall` 或 `lookup_private` 查到记录编号、`rk-vault://` 位置与 Coloop 执行器。账号密码正文由 `rk-credential-vault.service` 在 root 权限密文库中保护，不进入模型、普通事实或摘要；MCP 未扩展本地管理操作。Coloop 专用窗口通过编号、目标校验、短心跳和一次性请求触发 HID；引用不授予执行许可。完整真实Agent查询及新版管理接口已分层验收，限制、桌面独立包与证据见父项目 [私密凭据](../docs/22-private-credentials.md)。

2026-10-30：模型差异集中到 `model-profiles/*.json`，普通 Agent、记忆和桌面入口共用模型描述。默认仍为已验证的 Qwen3.5-4B；新增模型只需独立描述和对应 RKLLM 资产，无需修改业务 Agent。接入步骤与本次验收见 [多模型接入](model-profiles/README.md)。Qwen 8B 目前只有配置示例，没有下载、部署或实机质量结论。

2026-10-30：Coloop 0.10 的受控入口为 `scripts/coloop-managed.sh`。真实本地 Qwen Agent → RK 审批 → 主机签名 → 原生单次许可 → 冻结文件快照 → 未知随机串精确返回已通过，审批约 2.50 秒。只允许该受控读取；固定本地 provider、私有 HOME/XDG、关闭长期记忆插件。普通旧入口的 read allow 边界仍保持。使用说明与真实/CPU 分层证据见 [受控审批](../docs/20-coloop-managed-approvals.md) 和 [固定评测](../docs/19-coloop-managed-approval-evaluation.md)。

沿用已安装的 OpenCode v1.19.5，在板端调用现有 Qwen3.5-4B / RKLLM 1.3.0，通过本地 MCP 工具接入 Mem0 记忆、电脑观察和 USB HID。电脑端运行窗口截图、UIA、OCR 小程序；模型推理和动作决策在板端。

2026-10-29：随机文件工具闭环、跨会话记忆与隔离窗口 USB 桌面闭环已通过真实 NPU 测试。testbench 默认 OpenCode 轻量集成版：三次动作决策加一次最终回答，最终一次实测约 64.9 秒。独立 Python compact 三次决策样例约 45.9 秒，原 OpenCode 样例约 130～145 秒；三种入口均保留。调试中的参数、OCR、输出格式和日志导出失败分别留档。详细结果见 [VALIDATION.md](VALIDATION.md)。

2026-10-30：增加 `plugins/coloop-hook.mjs` 与 `scripts/coloop-opencode.sh`，直接向 Coloop 上报原生消息、工具、状态及审批，使用源 SDK 进程内 transport 复查/回复 pending。连接 Coloop 后运行 `bash ~/rk-opencode/scripts/coloop-opencode.sh`；SSH 反向回环及私有连接文件由 Coloop 管理。Hook 短期上下文不写 Mem0；正常启动仍保留既有 MemoryPlugin。权限 allow 继续等待数据路径验收。完整参数、测试指标与边界见父项目 [Hook 专题](../docs/18-coloop-hooks.md)。

## 架构与 Linux 分层

```text
Windows：指定窗口 → UIA / OCR → 本地观察服务
                                  │ USB 网络上的 SSH 回环隧道
鲁班猫 Ubuntu 用户空间：           ↓
  OpenCode：会话、工具调用和任务循环
     ├─ 本地模型 HTTP 适配层 → C++ 常驻 worker → RKLLM → NPU
     ├─ memory MCP / 记忆插件 → Mem0 服务 → 本地向量事实库 + 压缩摘要
     └─ desktop MCP → 校验最新观察 → /dev/hidgX → 电脑键鼠输入
Linux 内核：已有 RKNPU 驱动、USB Gadget / HID 驱动
硬件：RK3588S NPU、USB OTG
```

这些是现有 Ubuntu 上的应用开发和 USB 功能配置，无需重新烧录系统或编写新的内核驱动。模型提出工具调用，OpenCode 执行工具并把真实结果交回模型；桥接层不会补造工具调用或替模型猜路径。

源码在 `D:\RK\rk-opencode`，板端在 `/home/cat/rk-opencode`。这是独立 Git 仓库，父仓库通过 `.git/info/exclude` 排除它。模型、运行库、二进制、密钥、记忆和运行日志不进入 Git。模型继续复用 `/home/cat/rk-edge-ai/qwen35-4b`，不会覆盖权重或替换原运行库。

## 日常使用

| 入口 | 功能 |
| --- | --- |
| `RK桌面Agent.cmd` | 原生RK桌面Agent主入口：默认紧凑观察、上下文预算、USB HID获取前台/操作、实际回读；需先启动指定窗口的电脑观察助手 |
| `运行OpenCode.cmd` | 默认 Qwen 4B，允许读取文件和调用持久记忆；其他模型用启动器的 `-Profile` |
| `本地纯聊天.cmd` | 不执行工具的聊天 |
| `记忆Agent.cmd` | 仅使用持久记忆工具 |
| `桌面Agent.cmd` | 使用电脑观察/动作工具和记忆；需先启动电脑助手 |
| `轻量桌面Agent.cmd` | 可选OpenCode入口：默认紧凑/增量观察及板端批填，保留原记忆工具；其上下文管理仍由OpenCode负责 |
| `Windows软件桌面Agent.cmd` | 独立软件输入原型：打开允许的文件、填写中文/数字、点击控件；先启动 `scripts/windows-desktop.ps1`，详见 [桌面 skill](../docs/23-windows-desktop-skill.md) |
| `测试桌面Agent.cmd` | 打开隔离测试窗口，实测 OCR、模型决策、USB 输入/Apply/关闭 |
| `停止本地模型服务.cmd` | 释放常驻模型、内存和推理锁 |

记忆测试示例：在“记忆Agent”中输入“记住，默认保存目录是 D:\RK\agent-output”。退出这个会话，重新打开后询问默认保存目录。启用 Mem0 后，持久数据位于板端 `.runtime/mem0-v2/`。备份时停止记忆服务再复制整个目录；旧 `.runtime/memory.sqlite3` 及迁移备份保留，Git 不包含记忆。

默认 Qwen profile 为 16384 token，短输出 256 token，关闭思考。16K 配置的依据和独立验证见父项目 [上下文说明](../docs/16-qwen35-context.md)。当前仍按 UTF-8 字节数保守限制输入，不声称已经实现精确 token 预算或满 16K 的质量验证。旧 DeepSeek profile 保留在 `opencode.json`，其完整工具任务历史未通过，见验证记录。

模型在关闭 OpenCode 界面后仍可能驻留。使用原 Qwen 聊天或评测前先停止本服务；4B worker 与原 4B 应用共用推理锁。没有配置开机自启动，也没有启用云模型或付费 API。

## 原生会话 KV 缓存（2026-10-29）

Qwen profile 现在默认启用 `native` 缓存，继续使用原有 Runtime/Header 1.3.0。HTTP 客户端仍提交完整 `messages`；桥接层核对会话和历史，首次提交完整提示，后续只把新增用户消息或工具结果交给 worker。worker 使用原生 `keep_history=1` 保留对话，不再每轮清空缓存或重新处理全部历史。

OpenCode v1.19.5 自带 `x-opencode-session-id` 请求头，已在真实文件和记忆工具回路中验证复用。其他客户端可使用 `X-RK-Session-ID`；没有会话标识的请求仍按独立请求处理。

只保留一个活动会话的缓存。切换会话、修改指令/工具定义/已有历史、重试旧请求、上次输出失败或截断、超出原生缓存预算时，下一请求从完整历史冷重建。默认空闲超过 300 秒不再复用。请求并发或旧请求延迟提交时，通过代次编号拒绝过期的缓存提交；不会把错误输出当成已接受的历史。

首次长输入仍要全量计算。已验证三轮模型对话总耗时从 **75.887 秒降至 27.058 秒（约 2.80 倍）**，第二轮从 **25.535 秒降至 1.163 秒**，新增预填充仅 35 token，已有缓存 1340 token。这个数字是模型对话基准，完整桌面任务的缓存版耗时尚未复测。

可在板端临时回到每轮独立推理：

```bash
cd ~/rk-opencode
RK_AGENT_CACHE_MODE=off bash scripts/start.sh
# 恢复默认原生缓存：
RK_AGENT_CACHE_MODE=native bash scripts/start.sh
```

单个 HTTP 请求也可加 `X-RK-Cache: off`。当前 `/health` 返回 `cache_mode`、`profile_fingerprint` 和 `worker_protocol=3`；启动器核对实际配置与源码，旧 worker 或不匹配的头文件/运行库需要重建。历史协议 2 的测试记录保持原口径。DeepSeek profile 继续默认关闭缓存。

`logs/requests.jsonl` 的 `input_tokens` 是 SDK 本轮实际预填充 token；复用时只计新增处理部分。`inference` 记录预填充/生成毫秒数、`kv_before`、`kv_after`、提交字节数和重置原因；HTTP `usage.prompt_tokens` 包含已缓存与新增 token，并单列 `prompt_tokens_details.cached_tokens`。

运行模型 A/B 验证：`python3 scripts/benchmark-cache.py`。输入快照、原始结果及会话隔离检查保存在新的 `logs/kv-cache-*/` 目录；具体记录见 [VALIDATION.md](VALIDATION.md)。

## 电脑观察与 USB 输入

HID 的主入口是 **RK 板端本地 Python API / JSON CLI**，说明见 [rk-hid-desktop skill](skills/rk-hid-desktop/SKILL.md)。实际链路为 `RK 决策 → DesktopTools → HIDController → /dev/hidg* → USB → Windows`，不要求 MCP 或 OpenCode 运行。电脑助手只提供截图、OCR/UIA、校验和结果回读，不发送键鼠输入。

板端可用 `python3 ~/rk-opencode/scripts/hid-act.py --capabilities` 查看能力与 schema，用 `--observe` 获取当前观察；默认从 stdin 接收 JSON 动作，`--step < action.json` 在输入后自动回读。嵌入式调用使用 `DesktopTools(root).call(...)` / `.step(...)`，是本地函数调用。能力查询明确返回 `mcp_required=false`，不连接电脑助手或打开 HID，也不证明设备已就绪。

优化入口：新任务用 `--observe --compact --reset-view`，随后 `--compact < request.json` 返回紧凑/增量观察；`--capabilities --compact` 发布包含 `fill_form` 的原生schema。嵌入式使用 `hid_workflow.HID_TOOL` / `HIDWorkflow.call`，不要求MCP。`fill_form` 可在RK一次编排1..4个UIA字段并逐项回读，失败停止；可选提交后仍需验证业务结果。真实USB表单已通过，初始2582→383字节、增量70字节，7个HID动作约13.969秒；本轮未验收模型自主规划，纯HID仍限US布局ASCII。详见 [优化调用与固定证据](../docs/24-rk-hid-input.md#紧凑观察与板端批量填写)。

真实模型观察A/B另用 `scripts/bench-hid-observation.py`：同一六题快照各调用Qwen4B两次，关闭KV缓存。紧凑/增量表示把实际input token从9156降至2244，SDK输入处理168.088→41.082秒；严格JSON/内容核对为原始2/6、紧凑6/6（原始含三题围栏格式失败）。这是观察理解/规划JSON的小样本，未执行新一轮模型HID业务。完整题集、响应及复现入口见 [模型处理量A/B](../docs/24-rk-hid-input.md#真实模型处理量-ab)。

安装/更新统一 skill：从 `D:\RK` 执行 `.\.venv\Scripts\python.exe rk-opencode/scripts/setup-hid-skill.py --install --output-dir logs/hid-skill-install-新时间戳`。默认只上传直接 HID 能力文件，备份并核对 SHA256，不读取或修改 OpenCode/MCP 配置，不重启模型或重配 USB。仅需要旧 OpenCode 兼容时额外加 `--opencode-compat`，才合并两个现有 HID agent 的 prompt；权限仍不扩大。`桌面Agent.cmd` / `轻量桌面Agent.cmd` 保留为这些可选适配，不是硬件输入的必经入口。完整记录见 [HID 专题](../docs/24-rk-hid-input.md#统一-skill-包装与调用入口)。

第一版限定一个显示器、一个精确标题的前台窗口。助手只读取该窗口，实际键鼠报告由板端发出。截图和 UIA 坐标统一为桌面物理像素。

从 `D:\RK` 的 PowerShell 执行：

```powershell
# 配置键盘 + 绝对坐标鼠标，保留现有 USB 网卡；需要板端 sudo。
# USB 会短暂重连；未恢复确认时，板端两分钟后自动回滚。
.\.venv\Scripts\python.exe rk-opencode/host.py hid-enable

# 默认只观察、生成动作计划。将标题替换为实际窗口的精确标题。
powershell -ExecutionPolicy Bypass -File rk-opencode/scripts/desktop.ps1 -WindowTitle 'RK Agent Lab' -OCR

# 明确开启这个会话的硬件输入：
powershell -ExecutionPolicy Bypass -File rk-opencode/scripts/desktop.ps1 -WindowTitle 'RK Agent Lab' -OCR -ExecuteHID
```

保持助手进程运行，再打开 `桌面Agent.cmd` 下达任务，并把目标窗口切到前台。若窗口切到后台、位置变化、目标失效或观察过期，动作校验会拒绝输入。电脑助手进程退出后自动解除执行标记；关闭 OpenCode 界面不会自动关闭电脑助手。可用 `scripts/stop-desktop.ps1` 停止它。

动作工具支持 `observe` 和 `act`。2026-10-30 已扩展 `act`：移动/悬停、左/右/中键单击与双击、完整拖拽、垂直滚轮，以及 Win/GUI、PageUp/PageDown、Delete 等组合键编码。指针动作仍必须引用观察中的 `target_id`；拖拽另需 `end_target_id`。可选 `point/end_point` 是截图像素，必须落在对应目标内。滚轮 `steps` 为有符号刻度（正上、负下，1..32），不是像素。不提供水平滚轮或跨调用按住/释放。详见 [HID 协议与本次实测](../docs/24-rk-hid-input.md)。

`type` 输入最多 64 个 US 键盘布局 ASCII 字符，保留首尾空格、LF 换行与制表符，遇到未知字符整次拒绝。纯 HID 仍受 Windows 布局/输入法约束；中文需独立的电脑助手协作能力。多屏、视觉无文字图标定位尚未接入。桥接本轮只接收文本，没有将截图送给多模态模型。

动作前重新检查前台、窗口范围、控件身份/状态、遮挡、屏幕/DPI 和键盘焦点；发送前消耗观察凭据，避免对同一观察重复执行。整个复合动作持有共享 `hid.lock`，每个非释放报告前通过会话与 `/guard` 核对窗口、路径遮挡或键盘焦点。停止、断连、SIGTERM/SIGHUP 或异常会尝试原位释放；USB 已断开时释放无法保证送达。`planned` 表示仅生成计划；`input_sent` 只表示报告已发出，应用是否完成仍需重新观察；失败/中断记为 `outcome_unknown`，不得自动重放。

本次 HID 配置在当前系统运行期有效。重启后若厂家服务恢复为纯 RNDIS，重新执行 `hid-enable`。查看或恢复原 USB 配置：

```powershell
.\.venv\Scripts\python.exe rk-opencode/host.py hid-status
.\.venv\Scripts\python.exe rk-opencode/host.py hid-rollback
```

## Mem0 与记忆压缩

采用真正的 [Mem0 OSS](https://github.com/mem0ai/mem0)，固定 `mem0ai==2.2.1`，由独立 `.venv-memory` 进程提供本机鉴权 HTTP 服务。MCP 和 OpenCode 插件只使用标准库/内置模块访问它。嵌入模型为 `BAAI/bge-small-zh-v1.5`，512 维、约 95MB ONNX、CPU 两线程；文件版本和 SHA-256 记录在模型 manifest。向量库为嵌入式 Qdrant，无需单独部署数据库服务器；控制 SQLite 只保存任务队列、键版本和摘要来源关系。

上游依据是单次提取、追加事实、近邻检索和文本哈希去重（参考提交 `26cdefb46600c0fa5953c4b5ee5003c125539fc4`，实际运行依赖固定为 PyPI 2.2.1）。本项目调用 SDK 的 `Memory.add(infer=True)` 和 `Memory.search()`，不把手写 CRUD 改名为 Mem0。为适应板端上下文，用自定义 provider 的短提取提示替代上游约 33831 字节提示；仍运行真实 SDK 的提取、嵌入、去重和历史流程。2.2.1 的工厂支持注册 provider，但配置白名单未同步扩展，本项目显式构造两个 provider 配置包装，其余配置照常校验，不修改 SDK 源文件。

采用三层保存和压缩：

1. **原始层**：仅把普通/桌面 agent 的用户原文排队保存，单条最多 6000 UTF-8 字节。不会把自动附加的 OCR、召回文本或模型自述作为用户事实输入提取器。
2. **事实层**：空闲维护时，每批最多两条原文，每条使用一次本地 Qwen 推理提取最多四条稳定事实；由 Mem0 语义检索关联已有记忆并作文本哈希去重。显式键更新保留旧版本，当前查询只取新值。自动提取的自然语言冲突保留来源与历史，尚未实现可靠的自动裁决，不声称能完全识别所有偏好变化。
3. **摘要层**：当前事实达到八条时，取最近最多八条生成带源事实 ID 的压缩摘要。摘要必须更短，且路径、数值、标识及否定条件检查通过；否则拒绝保存。保留源事实，摘要一律标为派生、未验证。源事实过期、删除或同键更新后，关联摘要失效。规则检查无法证明语义完全等价，摘要不能替代原始事实审计。

召回先做真实语义搜索；摘要只有在其全部源事实都属于本次候选集时才替代它们。按完整条目装入默认 **1200 UTF-8 字节**预算，避免截断路径或句子。`rk-local`、`rk-desktop`、`rk-desktop-fast` 在用户消息 hook 自动召回和排队；记忆专用 agent 手动用工具，聊天与 benchmark 不自动保留/召回。基准仍禁止记忆工具。

模型主动写入为 `source=agent, verified=false`，自动提取为 `source=user_message, verified=false`；模型不能自行升级为已核实事实。按 user/project 隔离。删除同时保守取消本项目尚未提取的旧队列，防止原文异步重建被删事实；用户再次明确输入可以重新引入。删除和 TTL 阻止继续召回，SDK 审计历史、原始队列及迁移备份仍可能保留原文，不等于安全擦除。桌面任务恢复必须重新观察，不能重放记忆里的旧点击。

为控制开销，前台只做 CPU 召回/排队，空闲至少 120 秒且主模型已就绪时才维护，不会为整理自行启动 NPU 模型。新任务到来会暂停后续整理，等待当前不可抢占的一轮结束。共享一个 NPU/KV 槽，整理可能让下一次对话冷建缓存，不能保证完全没有前台延迟。模型关闭时队列保留，等待下次就绪。当前只启用中文稠密语义召回；未安装上游可选 spaCy/BM25 资源，不能声称已经启用完整混合检索。

板端操作：

```bash
cd ~/rk-opencode
python3 scripts/memoryctl.py status
python3 scripts/memoryctl.py search '输出结果应该放在哪个文件夹'
python3 scripts/memoryctl.py set save_dir 'D:\RK\agent-output' --kind preference
python3 scripts/memoryctl.py get save_dir
# 主模型运行且无前台任务时，手动处理队列并尝试压缩：
python3 scripts/memoryctl.py maintain
```

首次部署：调用方提供会话级联网代理后运行 `bash scripts/install-memory.sh`；电脑执行 `scripts/prepare-memory-model.py` 下载并锁定文件，再用已有 `RK_BOARD_PASSWORD` 执行 `scripts/setup-memory.py`，先备份迁移到禁用自动维护的 staging。主模型启动后执行 `scripts/setup-memory.py --activate`，只有真实嵌入/NPU 验收通过才切换。旧 SQLite 不覆盖。 CPU 记忆服务会继续常驻（本次约 240MB RSS）；停止本地模型入口只停止 NPU。备份前可运行 `bash scripts/stop-memory.sh` 等当前整理结束并停止服务，复制整个 `.runtime/mem0-v2/` 后，用 `bash scripts/start-memory.sh` 恢复。回退旧原型时将 `.runtime/memory-config.json` 的 `enabled`、`auto_maintain` 置为 false，再停止记忆服务；旧记忆文件仍可用，新写入不会自动反向迁移。`scripts/validate-memory.py --local` 只验证真实 CPU 嵌入及模拟提取/压缩保护，不能激活板端服务。具体实测结果见 VALIDATION。

## 源码位置

| 路径 | 职责 |
| --- | --- |
| `bridge/`、`src/worker.cpp` | 消息/动作格式、HTTP 鉴权、RKLLM 常驻推理 |
| `agent/mcp_server.py`、`agent/memory_client.py` | 标准库 MCP 与记忆服务客户端 |
| `agent/mem0_engine.py`、`agent/mem0_adapters.py`、`agent/memory_service.py` | Mem0、本地嵌入、压缩、来源及空闲维护 |
| `plugins/memory.mjs` | OpenCode 自动召回、原文排队、前台优先 |
| `agent/memory.py` | 旧 SQLite 原型及迁移兼容 |
| `agent/desktop.py`、`agent/hid.py` | 桌面工具、会话校验、USB 报告 |
| `pc/observer.py`、`pc/observations.py` | 截图/UIA/OCR、观察有效性与一次性消费 |
| `desktop_host.py` | 启动 PC 助手、建立 SSH 回环隧道 |
| `testbench.py`、`bench_report.py`、`scripts/bench-*.py` | 双端性能测试、实际结果验收与逐轮报告 |
| `agent/compact.py` | 固定测试任务的三次决策循环，自动观察、业务校验和停止 |
| `plugins/desktop-fast.mjs`、`agent/fast_desktop.py` | OpenCode 初始观察注入与自动观察 MCP 工具 |
| `scripts/usb-hid.py` | 复合 USB 配置、备份、确认与定时回滚 |
| `model_profiles.py`、`model-profiles/` | 模型资产、上下文/模板/缓存能力、构建校验与 OpenCode 配置生成 |
| `opencode-qwen.json`、`opencode.json` | 权限、MCP、插件和 Agent 提示模板；启动时只替换模型路由及限制 |
| `tests/`、`scripts/smoke-*.py` | 协议测试与真实任务验收 |

模型服务只监听板端 `127.0.0.1:8088`；电脑观察服务只监听本机 `127.0.0.1:8091`，通过严格校验主机指纹的 SSH 转发到板端回环地址。两个服务均需本地密钥，并拒绝浏览器跨域请求。日志和截图保存在本机忽略目录。

## Coloop 审批分析的日志保护（2026-10-29）

模型 HTTP 接受 `X-RK-Privacy: metadata-only`，该类请求的 `requests.jsonl` 只保留数值、固定枚举和服务生成 ID，不保存原始模型输出、回答、工具名或错误反射。私密响应确认同名头；`/health` 的 `privacy_metadata_only` 表示当前服务支持此路径。Coloop 先核对能力与回执，旧服务不会被当作已支持保护。

worker 默认 `--worker-log-mode metadata-only`，厂商诊断 stderr 丢弃，协议 stdout 仍由桥接层读取；已有 `worker.log` 不清理。显式 `raw` 可用于非私密调试，但健康能力为 false，私密请求被拒绝。普通聊天 HTTP 记录保持原行为，不能据此声称所有日志均脱敏。

本次只备份更新桥接源码并正常重启，模型与运行库未变。真实 NPU 随机串及日志检查见 [VALIDATION.md](VALIDATION.md)。协调协议与权限边界见父项目 [协调说明](../docs/17-coloop-coordination.md)。当前适配器自动拒绝权限或回复安全单项选择；读取放行等待主 Agent 数据路径验收。

## 部署与复现

无需重新下载 OpenCode 或模型。主机使用父项目的 Python / Paramiko，电脑 OCR 继续复用已有专用环境；板端新增模块使用 Python 3.10 标准库。

```powershell
# 从 D:\RK 执行；密码使用进程 RK_BOARD_PASSWORD 或交互输入，不写日志。
.\.venv\Scripts\python.exe rk-opencode/host.py deploy
.\.venv\Scripts\python.exe -m unittest discover -s rk-opencode/tests -v

# 打开隔离的 WinForms 测试窗口，不操作个人应用：
powershell -ExecutionPolicy Bypass -File rk-opencode/scripts/lab.ps1
```

板端：

```bash
cd ~/rk-opencode
python3 -m unittest discover -s tests -v
bash scripts/start.sh
python3 scripts/smoke-api.py
bash scripts/smoke-agent.sh
python3 scripts/smoke-memory.py
# PC 助手连接并保持测试窗口前台时：
python3 scripts/smoke-desktop.py
# 真实 HID 测试还需 --hid --expected <测试窗口本次实际代码>；该值不进入模型提示。
bash scripts/stop-model.sh
```

单元测试使用假 worker 验证协议；真实任务测试分别检查进程退出、工具执行和实际结果。新 worker 构建先生成临时文件，成功后保留旧二进制到 `build/archive/` 再替换。原始记录和限制见 [VALIDATION.md](VALIDATION.md)。

## 桌面速度 testbench

从 `D:\RK` 运行。首次启用本地插件时准备固定 SDK 的离线依赖，再部署对应源码；本机已完成这些步骤：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File rk-opencode/scripts/prepare-plugin-deps.ps1
# 后续 host.py deploy 会复用并上传本机已准备好的 SDK 缓存。
powershell -NoProfile -ExecutionPolicy Bypass -File rk-opencode/scripts/testbench.ps1 -EnableHid
# 不经过 OpenCode 的独立三次决策循环：
powershell -NoProfile -ExecutionPolicy Bypass -File rk-opencode/scripts/testbench.ps1 -Runner compact
# 保留原 OpenCode 多轮编排作对照：
powershell -NoProfile -ExecutionPolicy Bypass -File rk-opencode/scripts/testbench.ps1 -Runner opencode
# 比较现有 UIA + OCR 混合观察模式：
powershell -NoProfile -ExecutionPolicy Bypass -File rk-opencode/scripts/testbench.ps1 -Perception hybrid
```

测试台编译并打开独立 WinForms 窗口，生成新的 8 位随机数字。默认 `opencode-fast` 使用真实 OpenCode 会话：本地插件在收到任务时自动获取初始观察；模型调用 `rk_desktop_fast_step`，MCP 工具执行一次动作后返回精简的新观察。输入、Apply、关闭由模型作三次决策，OpenCode 再调用模型生成合法的最终回答并正常结束，共四次请求。会话、工具权限、调用记录及记忆工具仍由原框架承载；测试 agent 禁止记忆以保持计时口径，日常 `rk-desktop-fast` 允许记忆。

`-Runner compact` 是独立 Python 循环，确认关闭后由程序结束，正常路径三次模型调用；`-Runner opencode` 是原 `rk-testbench` agent 编排，观察操作也需模型决定。此版本插件没有任务已完成后直接正常终止当前模型循环的公开接口，集成版保留真实最终回答，没有在模型服务里合成收尾响应。

三个动作及其参数必须来自真实模型输出；程序检查任务阶段和业务结果，禁止提前关闭或把 Ready 当 Apply。输入已经发出后只允许重读观察，不能自动重发输入。期望验证码由本机验收文件保存，不直接传给板端；模型初始提示中的验证码来自实际 OCR/UIA 观察。`-Code 02206873` 可固定测试窗口数据用于对比，该参数仍只供测试窗口/本机验证器使用。开窗由测试台完成，尚不测试模型自主启动任意应用。

默认 `ocr` 模式只向模型提供 OCR 文字框，UIA 用于输入焦点校验；`hybrid` 向模型提供两者。两种轻量方式只向模型提供观察 ID、目标 ID/名字/类型/来源和焦点状态，坐标、屏幕尺寸、截图摘要留给校验器与日志。同位置、同文字的可见目标使用稳定 ID；动作仍需最新观察 ID，并重新校验窗口/焦点/坐标。保持唯一测试窗口在前台、单显示器、英文键盘/ASCII 输入，开始前将鼠标放在输入框空白处，避免遮挡或悬停改变按钮文字。窗口离开前台会失败并保留证据，不自动切换到其他应用。`-WaitStart` 等待日志目录内 `start.signal` 文件，便于调试；等待时间不计入任务耗时。

每次保存到独立 `logs/testbench-<时间>-<随机值>/`：

- `report.md`、`summary.json`：任务验收、阶段总耗时/中位数、每轮模型预填充/生成、新增 token、KV 复用量。
- `observer/observations.jsonl`：每次 observe 和动作校验的截图、UIA、OCR 引擎/整体、图片保存耗时；`first.png` 和 `latest.png` 保存截图。
- `model-requests.jsonl`、`hid-actions.jsonl`：真实推理与 USB 操作记录；通过会话 ID 关联，不相减两端墙钟。compact 另存 `agent-trace.jsonl`、每轮 `request-*.json` / `response-*.json`；OpenCode 保存真实 `opencode.jsonl`，集成版还保存原始工具 trace 和 `opencode-export.json`。
- `fixture-events.jsonl`、`fixture-state.json`：窗口实际 ready/Apply/closed 事件；退出码和功能验收分别记录。
- `ocr-warm.json`：任务完成后，用第一张截图在同一 OCR 实例上重复 7 次；不混进实时任务耗时。
- `manifest.json`：输入、源码摘要、观察模式、启动/开窗时间、失败原因和清理状态。

OCR 首次调用、OCR 初始化、模型冷启动和实时任务分开计量。表中存在包含关系（动作校验也会截图并 OCR），不能把所有阶段直接相加。只有随机输入正确、Apply 恰好一次、模型观察了结果、实际关闭且正常退出等检查全部通过，报告才为 PASS。单次结果不是通用 Agent 成功率。测试台只停止自身启动的进程与模型服务；已运行的健康模型服务会被复用并保留。

插件只处理 `rk-desktop-fast` / `rk-testbench-fast` 的消息；普通聊天、读文件、记忆 agent 不触发读屏。实际 API 以固定版本的 [插件 Hooks](https://github.com/anomalyco/opencode/blob/v1.19.5/packages/plugin/src/index.ts) 和 [会话循环](https://github.com/anomalyco/opencode/blob/v1.19.5/packages/opencode/src/session/prompt.ts) 为依据。SDK 依赖由 `plugins/package-lock.json` 固定，禁用安装脚本和可选原生模块，通过 USB SSH 部署到应用私有 `.runtime/config/opencode/node_modules`。本地插件本身仅导入 Node 内置模块；离线 SDK 缓存用于满足 OpenCode 初始化依赖检查，避免每次启动访问 npm。没有修改系统 npm 代理或模型运行库。

## Coloop tag 目录与按需记忆（2026-11-03）

Mem0 本机 `/call` 新增 `catalog(tags?,query?,limit<=5)` 与 `get_many(ids)`；目录只返回普通当前事实的编号、标签、摘要和来源，不包含正文。正文读取最多五个唯一 ID，每次重新校验项目、TTL、逻辑键最新版本及删除状态，不混入 `private_refs`。多个 tag 使用 AND 匹配；可结合现有 CPU 语义搜索排名。旧数据保持空标签、空目录摘要。

`set` 新增可选 `tags`（最多八个、每个64字）、`summary`（160字）、`source_task_id`（128字），继续使用真实 Mem0 `infer=False`；来源为 agent、未核实。省略元数据时继承同键当前值，`revise` 支持标签和摘要，原有调用兼容。增量 sidecar 表保存在既有控制 SQLite 中，不重建向量库。健康接口声明 `tag_catalog_v1`。后台维护忙或查询锁等待超过50ms时，目录/正文查询返回 `deferred=true`，调用者可本轮不使用记忆；不会启动第二个 NPU 推理。

`scripts/validate-memory-catalog.py --local` 使用本机缓存嵌入，省略 `--local` 则使用板端缓存；均在新建隔离数据目录验证真实 Mem0/BGE/Qdrant、重开持久 ID、旧版本不可读和删除失效，不调用 NPU/云端/HID。`scripts/deploy-memory-catalog.py` 按固定指纹连接，在没有前台任务或维护时短时停止记忆服务，备份整个存储、配置和旧源码，仅更新两个服务文件后恢复，再运行隔离验收；失败恢复旧服务源码，不改模型与凭据服务。部署清单、源码摘要及备份位置见各次 `logs/memory-catalog-deploy-*/report.json`。

2026-11-03 源码、20项相关 Python 测试、本机及真实板端 CPU 存储验收通过；板端生产服务已公布新能力。固定报告为 `logs/memory-catalog-deploy-20261102-180828-105152/report.json`。目录名采用执行主机 UTC 时钟，板端墙钟另有偏差，不据此计算跨端延迟。本次没有测试端到端云任务、NPU 或 USB 输入。

## 上游

- [OpenCode v1.19.5](https://github.com/anomalyco/opencode/releases/tag/v1.19.5)，[MIT 许可证](https://github.com/anomalyco/opencode/blob/v1.19.5/LICENSE)。固定 ARM64 下载 SHA256：`fae5be262d693b7c5e562856cc473e59e741772936db0c0600ac0d5ed5bd088b`。
- [OpenCode MCP 配置](https://docs.opencode.ai/docs/mcp-servers/)。
- [Rockchip RKLLM](https://github.com/airockchip/rknn-llm)；模型固定来源及摘要沿用父项目 `docs/11-qwen35-4b.md`。
- [Linux HID Gadget](https://docs.kernel.org/usb/gadget_hid.html)。
