# RK USB HID 输入扩展与受控验收

日期：2026-10-30，Asia/Shanghai。目标为 LubanCat-4 经现有 USB 复合设备控制另一端 Windows。沿用现有 RNDIS、键盘 8 字节、绝对鼠标 6 字节描述符，没有重绑 USB、改内核或更换模型/运行库。

后续已在RK端侧Agent统一处理观察、上下文预算、回执及业务条件，并完成RK自身获取前台 → 真实模型规划 → USB HID → 独立窗口/回答核验的严格样例。新主入口 `RK桌面Agent.cmd`、固定日志、失败迭代与限制见 [RK端侧桌面Agent](25-rk-desktop-agent.md)。下文保留各阶段独立的执行器与观察A/B记录，不混算通用成功率。

## 紧凑观察与板端批量填写

2026-10-30 后续优化已接入直接HID主接口，源码为 `agent/hid_workflow.py`。完整OCR/UIA观察保存在板端权限600的 `.runtime/hid-view.json`，模型只接收控件数组或有明确base的增量；窗口身份、几何和完整控件仍用于实际校验。PC观察器新增不透明窗口/控件身份及客户区标记，输入仍全部由RK的 `/dev/hidg*` 发出。

板端调用：

```bash
python3 scripts/hid-act.py --capabilities --compact
python3 scripts/hid-act.py --observe --compact --reset-view
python3 scripts/hid-act.py --compact < form.json
# 上下文丢失或需要被过滤的控件时返回完整模型视图
python3 scripts/hid-act.py --observe --compact --detail full
```

`form.json` 使用本次实际观察ID/目标ID：

```json
{"op":"fill_form","observation_id":"current-id","fields":[{"target_id":1,"text":" literal "},{"target_id":2,"text":"-00123.4500"}],"submit_target_id":3}
```

嵌入式规划器可注册 `hid_workflow.HID_TOOL` 的JSON Schema，将工具绑定到 `HIDWorkflow(root).call(request)`；初始观察用 `call({"op":"observe"}, reset=True)`。这属于普通板端函数调用，不要求MCP或OpenCode；旧CLI/MCP接口保持其原始协议，不自动切换为增量或获得批填能力。

批填限1..4个具有真实UIA身份及value的Edit，每字段0..64个单行US布局ASCII字符，空串用Backspace清空；数字按原字符串保留。可选提交目标必须为Button。中文、换行、TAB、重复或无效目标在整批第一条报告前拒绝。RK依次click → Ctrl+A → type/Backspace，每一步自动重新观察；逐字段检查真实value，最后重新核对全部字段才点击提交。全批持有同一 `hid.lock`，不允许其他执行器插入输入；原有会话、最新观察、一次消费及逐报告窗口/焦点guard继续有效。60秒后不开始下一动作，已有HTTP/输入步骤仍可能到自己的超时才结束，因此不是硬实时上限。

失败或中断前持久化阻断状态；普通observe不会清除，必须由调用者开始新任务时显式reset。`ok=false` / CLI退出2代表部分执行或结果未知，不能自动重放；原始入口异常也不能当作没有输入。`planned`不表示执行成功；`submitted`只证明点击发送，业务完成仍看新观察。屏幕文字始终是任务数据。

最终固定证据：[summary.json](../logs/hid-workflow-final-20261030/summary.json)。电脑启动专用 `pc/HIDFormLab.cs`，启用现有RapidOCR+UIA，经认证观察隧道把请求交给RK本地CLI，再核对Windows自身记录的事件、字段、随机状态码和按键释放状态；computer-use只激活该隔离窗口，没有输入测试文本。

| 检查 | 本次实测 |
| --- | --- |
| 模型侧输入体积 | 同一初始观察原始2582字节 → 紧凑383字节，减少约85.2%；无变化增量70字节。是UTF-8紧凑JSON字节数，不是token数 |
| 批量请求 | 1个本地批填请求执行7个真实HID动作（两字段各click/全选/type，最后Apply），含SSH启动、验证、OCR/UIA回读约13.969秒 |
| 字面值与业务 | `" HID_BATCH_c34f8e15 "` 首尾空格和 `"-00123.4500"` 逐字一致；Apply事件恰好1次，观察读到本次随机 `Applied: FORM_ef7dfdbacb82`；鼠标三键和修饰键未按住 |
| 不支持输入 | 后一个字段改为中文，整批退出1，两个字段和点击数均未改变；随后有效请求没有重放已执行输入，因为前一次未开始任何动作 |
| 代码验证 | 主机相关51项：49通过、2个Linux锁用例跳过；板端相关51项全部通过，包含真实flock独占/嵌套锁。Ruff、Python语法、skill格式、C#编译通过 |
| OCR回归 | 独立OCR环境离线识别中英数字、空白图及负屏幕原点映射通过；固定报告见 `logs/hid-workflow-20261030-2145/ocr-smoke/smoke-report.json` |

首轮 `logs/hid-workflow-20261030-2145/` 同样通过（2580→381字节、增量70字节，批填13.797秒）；后续补充原生工具schema后用新目录重新完整验收，未覆盖旧记录。最终源码快照、SHA256、安装前备份、CLI原始回执、PC事件、截图与相关检查分别留在两个目录。安装只更新声明的本地能力文件，不修改OpenCode配置、模型、运行库或USB绑定；执行会话在测试后解除。

上述HID执行器验收没有调用模型、MCP、OpenCode或Mem0，不代表模型已经自主正确选字段/生成参数，也未在该次测试测量NPU prefill。减少的是交给模型的观察体积和需要模型编排的动作数，PC内部仍保留每步验证与观察。后续真实模型处理量A/B单独记录如下。范围仍为单屏、精确前台窗口、UIA标准控件和US布局ASCII；中文OCR可读不等于纯HID可输入中文。

## 真实模型处理量 A/B

2026-10-30 新增 `scripts/bench-hid-observation.py`，把同一批观察以原始JSON和 `ObservationView` 紧凑/增量表示分别送到真实板端Qwen3.5-4B。模型直接接收更少文字与字段，完整校验数据留在执行器；这次测的是模型实际input token和SDK prefill耗时，不是压缩包或网络字节数。

固定输入来自上一节真实硬件测试的 `initial.raw.json` 与 `final.raw.json`。六题为：生成两个字段的填写参数、选择Apply、逐字读数字、保留首尾空格读文本、忽略禁用的同名按钮、结合初始与增量观察核对结果。其中禁用按钮题明确向原快照加入合成重复项；其余题使用已记录窗口数据。每题两种表示的任务/system提示、模型和160输出token上限相同，只切换观察数据；按题交替raw/compact先后，每次独立请求并强制关闭KV缓存。没有tools注册、MCP、OpenCode或HID动作执行，也不把模型输出转换成实际输入。

本次实际调用沿用常驻Qwen3.5-4B W8A8 / RKLLM 1.3.0 / 16384上下文与关闭思考的应用配置，没有重启服务或改权重。鉴权回环HTTP使用 `X-RK-Privacy: metadata-only`，只登记自己的前台活动租约并等待已有维护结束，不召回/排队/写入记忆内容。12个请求均 `cached_tokens=0`，按响应ID精确关联本次SDK计时；最高温度56.384℃，退出后租约已解除。

固定证据：[report.json](../logs/hid-observation-ab-20261030-221053/report.json)、[verification.json](../logs/hid-observation-ab-20261030-221053/verification.json)。原始请求、响应、题集/答案/快照、来源SHA256、实际runner副本与独立metadata计时全部留在同一新目录，未修改旧测试记录。

| 六题合计 | 原始观察 | 紧凑/增量观察 |
| --- | ---: | ---: |
| 实际模型input token，含相同system和任务提示 | 9156 | 2244 |
| SDK prefill，即输入处理时间 | 168.088秒 | 41.082秒 |
| output token | 200 | 149 |
| HTTP全程时间 | 212.649秒 | 72.860秒 |
| 严格JSON与逐字段内容均通过 | 2/6 | 6/6 |

input token减少 **75.49%**，prefill减少 **75.56%**。HTTP全程还包含不同长度的输出及传输，不能把其差异全归因于输入压缩。

2026-10-31文档复核：这是减少模型处理工作量带来的同任务输入阶段加速，约4.09倍；两组每token输入处理速率基本相同，不代表NPU硬件提速。独立全RK任务66.548秒的模型/操作耗时拆分见 [处理加速与当前瓶颈](25-rk-desktop-agent.md#处理加速与当前瓶颈2026-10-31-整理)。本次只补记录，未重跑硬件测试。

单题记录：

| 题目 | input token：原始→紧凑 | 严格输出：原始/紧凑 |
| --- | --- | --- |
| form-plan | 1343→365 | 失败/通过 |
| choose-apply | 1295→317 | 通过/通过 |
| read-number | 1327→356 | 通过/通过 |
| read-literal-text | 1334→363 | 失败/通过 |
| disabled-decoy | 1344→319 | 失败/通过 |
| verify-delta | 2513→524 | 失败/通过 |

计分先要求finish_reason=stop，再对模型原始content直接 `json.loads`，对象键顺序不计、字符串/类型/列表顺序及所有字段严格匹配；不剥离Markdown、不补JSON、不重试。原始观察的form-plan、disabled-decoy、verify-delta三题内容正确但包了Markdown围栏，因此违反本次纯JSON合同；read-literal-text返回不完整JSON（结束原因stop，未达到160输出上限）。既有工具适配器有自己的围栏处理规则，本表不能外推为其工具成功率，更不能把2/6称为通用模型准确率。

结论仅限这六个固定观察任务、每种表示每题一次：已验证模型确实少处理约四分之三输入，紧凑表示没有在本组丢失任务所需字面值/禁用状态/增量关系。尚未验证新输入表示下的真实模型→HID→跨应用业务端到端成功率、大窗口/漏识别/多屏或长期多轮质量；该结果不是硬件执行器验收的替代。

复现入口（从 `D:\RK`，需要匹配的现有板端服务已就绪）：

```powershell
.\.venv\Scripts\python.exe rk-opencode/scripts/bench-hid-observation.py --snapshot-dir logs/hid-workflow-final-20261030
```

默认生成新的 `logs/hid-observation-ab-<时间戳>/`；只上传本次runner和题集到板端同名日志目录，不安装依赖、更新生产执行器或启动模型。新增评分/答案隔离两个主机单测、Ruff和Python语法检查通过；板端实际12次HTTP/NPU消费和lease释放分别由原始记录核对。

## 统一 skill 包装与调用入口

用户明确要求以**下位机直接 USB HID**为主线。主接口是 `skills/rk-hid-desktop/SKILL.md` 说明的板端本地函数/CLI：`RK决策 → DesktopTools.call/step → HIDController → /dev/hidg* → USB → Windows`。MCP只是既有OpenCode调用适配，不是执行后端，也不是必需依赖。电脑侧只提供截图/OCR/UIA、目标/焦点校验及结果回读；实际报告始终由RK发送。私密凭据服务保留独立特权入口，不经普通skill暴露正文或消费权限；Windows软件输入仍是另一通道。

直接入口示例（在板端工程根目录）：

```bash
python3 scripts/hid-act.py --capabilities
python3 scripts/hid-act.py --observe
# action.json是数据，不作为Shell代码解释；必须包含最新观察ID和已授权动作。
python3 scripts/hid-act.py --step < action.json
```

嵌入RK规划器时可直接导入 `agent/desktop.py` 的 `DesktopTools(root)`，调用 `.call({"op":"observe"})` 和 `.step({"op":"act", ...})`，无MCP dispatch。能力声明新增 `mcp_required=false` 和 `entrypoints.primary=board_local_python_or_cli`。

两个日常 OpenCode agent 的 prompt 使用 `{file:{env:RK_AGENT_ROOT}/skills/rk-hid-desktop/SKILL.md}` 加各自工具绑定说明。采用固定版本支持的[配置变量展开](https://github.com/anomalyco/opencode/blob/v1.19.5/packages/opencode/src/config/variable.ts)：先展开环境变量，再读取文件。真实 `bin/opencode debug config` 已确认 `rk-desktop` 与 `rk-desktop-fast` 都包含完整 skill。属于原生文件引用预载，不声称已经验收原生 skill 工具的按需自动发现；无需给 Agent 新增 Shell、read 或 skill 工具权限。固定题目的 testbench agent 保留原提示，避免改写历史协议。

能力声明由 `agent/hid.py:hid_capabilities()` 生成，schema 的动作列表、PC health、CLI 与普通 MCP 共用同一声明。文本、滚轮、拖拽边界也使用执行器中的同一常量；支持列表不代表动作已授权或硬件可用。新的 `capabilities` 操作无副作用，明确返回 `readiness: not_checked`。

| 使用者 | 入口 | 动作后观察 |
| --- | --- | --- |
| RK规划器（主接口） | 本地 `DesktopTools.call/step` | `.step` 自动回读，无MCP |
| 板端脚本（主接口） | `python3 scripts/hid-act.py`，stdin JSON | 默认保留旧行为；`--step` 自动回读 |
| OpenCode普通（可选兼容） | `rk_desktop_desktop`，`op=observe/act/capabilities` | 执行后再 observe，保留旧接口 |
| OpenCode轻量（可选兼容） | `rk_desktop_fast_step`，直接传 action 等字段 | 自动返回新观察，仍复用同一执行器 |
| 能力查询 | 同一 CLI 加 `--capabilities`；或普通 MCP `op=capabilities` | 不发报告、不要求助手存在 |

轻量观察现在保留来自真实 UIA 的 Edit `value`，不再仅返回控件名。没有实际 `value` 时不生成替代值；无OCR文字或value就不能宣称核对输入值成功。几何仍不进入compact观察，坐标动作必须使用真实可见映射。观察中的文本/value会进入本地模型上下文，不是全局脱敏能力。

`scripts/setup-hid-skill.py --install --output-dir <新目录>` 是专项安装器：活动 HID 会话存在时拒绝；默认仅复制声明的 HID 代码、CLI、skill 与安装器，不读取/修改OpenCode配置，不要求MCP。只有显式加 `--opencode-compat` 才合并远端两个既有HID agent prompt，保留其他配置与权限。备份到 `.runtime/hid-skill-backup-*`，先校验全部上传再逐文件原子替换；多文件替换并非事务，失败可按manifest和备份恢复。不会运行整包部署、启动模型、重启凭据服务或重新配置USB。`host.py` 日后完整打包也纳入 `skills/`，避免漏部署。

本轮证据集中于 `logs/hid-skill-20261030-164656/`。`install-final-2/manifest.json` 保存最终能力文件的备份与摘要；主机最终全套141项（9项平台跳过）、板端当时已部署101项通过，包含实际value透传、capabilities无副作用、CLI/MCP一致性和安装不扩权；分别见 `host-tests-final.txt`、`board-tests-final.txt`。主机同期有其他任务新增测试，两个用例集合不同，按各自记录计数。Ruff、Python语法、skill验证器与C#实际编译通过。验证器使用现成OCR环境中的PyYAML，没有安装或升级环境。板端首次新测试因安装器提前导入主机专用Paramiko失败（97项含1错误），改成执行安装时才导入后101项通过，失败见 `board-tests.txt`。`final-checks.json` 确认能力文件SHA256一致、两HID prompt一致、其他配置与首次安装前相同、执行会话关闭且原worker PID97505仍在。

真实模型测试使用既有Qwen4B服务、无记忆工具/插件的独立临时配置，避免把合成样例写入长期记忆；普通日常入口的记忆权限保持原样。独立前台租约只协调记忆维护，不授予额外桌面权限。

`model/` 首轮模型生成了正确调用，但动作前窗口失去前台，被校验拒绝；未发送输入，失败保留。`model-2/` 真实输入及最终随机串通过当时验收（约55.94秒），但当时compact工具结果尚未包含Edit实值，不能据此证明模型消费了实际输入值。随后补回value并加强三层核对：`model-3/` 因模型在type多带target_id被严格拒绝，skill补充明确示例，未放宽验证器；`model-4/` 初始观察失去前台（OpenCode表现为UnknownError，原始PC记录给出实际原因）；`model-5/` 正确调用在执行前失去前台；`model-6/` 正确调用在执行前发现两个同名窗口，被唯一性检查拒绝。均未自动重放输入。最终严格的模型完整任务复验未通过，不能标记模型端到端质量验收成功。

`protocol-final/` 直接测试真实MCP/USB和value回读，明确 `model_used=false`：原生OpenCode文件引用仍先验证，真实观察→`MCPServer desktop-fast/step`→板端HID→Windows输入随机串→精简观察实值全部核对通过。对应 `protocol.json` 和 `summary.json` 确认MCP返回值与应用实际值一致，没有伪造模型调用。测试窗标题加入运行目录避免不同批次名称重复；测试准备仅用computer-use激活这一隔离窗口，没有通过电脑端输入工具键入文字，也没有在输入过程中强制抢回前台。

专项复验命令使用同一个 `scripts/smoke-hid-input.py`：`--execute --protocol --wait-start --output-dir <新目录>` 验收协议/USB/回读，`--execute --model --wait-start --output-dir <新目录>` 验收真实OpenCode/NPU。窗口激活后在该目录创建 `start.signal` 才开始。模型路径240秒/80℃停止，不自动启动或切换模型，错误后只停止本次进程组。普通不带这两个参数的16动作硬件测试保留。协议通过与模型完整任务失败分别记录，不把前者充当后者。

## 直接 HID 定位修正与另一聊天对齐

用户指出“MCP执行器”的称呼容易混淆输入方式。此前使用MCP是为了对接OpenCode工具调用；本聊天的实际输入始终由板端USB HID报告完成。现在skill以本地函数/CLI为主，MCP仅在明确使用旧OpenCode入口时作为可选适配。默认安装不再要求OpenCode配置文件，不启动MCP服务；明确 `--opencode-compat` 才处理兼容prompt。

与聊天「为 RK 添加 Windows 操控 Skill」已双向同步进度：该聊天完成的控件筛选、紧凑/增量观察和fill_form属于软件通道；后续可复用观察与编排思路，输入改接本地HID后另验。它已更新 `docs/23-windows-desktop-skill.md` 和OCR说明，明确Windows中文输入、文件关联打开、46.547秒样例不是HID证据。本轮没有把这些优化迁入HID，也未修改其软件执行器。

本次固定证据：`logs/hid-direct-priority-20261030-174233/`。

- `direct/summary.json`：`mcp_used=false`、`model_used=false`、`input_backend=rk_usb_hid`；本地CLI `hid-act.py --step` 实际输入随机串，Windows控件与动作后返回的真实value一致。没有调用MCPServer、OpenCode、NPU、SendInput或os.startfile。computer-use只负责测试准备的窗口激活。
- `install/manifest.json`：`mcp_required=false`，`opencode_compat_updated=false`；上传后SHA256核对。`final-checks.json` 确认全部能力文件与本地一致、未改OpenCode配置，测试结束执行会话已关闭。
- 主机全套143项（9平台跳过）、板端当时已部署102项通过；相关Ruff/Python语法与skill验证通过。新增测试在屏蔽MCP导入的独立Python进程中运行直接CLI能力查询。完整模型规划质量结论仍沿用上节边界，没有以本次直接硬件样例升级为通用任务成功率。

直接复验使用 `scripts/smoke-hid-input.py --execute --direct --wait-start --output-dir <新目录>`。这是直接CLI/USB/回读测试，不会进入现有 `--protocol` MCP兼容测试或 `--model` OpenCode模型测试。

## 首轮动作扩展：源码与接口

可维护入口：`rk-opencode/agent/hid.py` 编码与完整动作编排；`agent/desktop.py` 会话、输入锁和逐报告检查；`pc/observations.py` 一次性观察/目标校验；`pc/observer.py` 截图/UIA 与认证 HTTP。普通 MCP `desktop`、自动观察 `desktop_step/step` 共用动作 schema。新增 `scripts/hid-act.py` 可从 stdin 接收一个 JSON 请求，仍须由已启动助手授权执行，不能自行开启会话。

动作外层保留 `op: "act"`、最新 `observation_id`，旧 `click/hotkey/type` 调用保持兼容。

| action | 参数及行为 |
| --- | --- |
| `move` / `hover` | `target_id`；移动到目标中心，悬停结果由调用者重新观察 |
| `click` / `double_click` | `target_id`；可选 `button: left/right/middle`，默认 left；双击是完整两次按下/释放 |
| `drag` | `target_id` + `end_target_id`；可选 `button`、`duration_ms: 100..3000`（默认500）；整条插值路径按住，最后释放 |
| `scroll` | `target_id` + `steps`；有符号1..32刻度，正数向上、负数向下；分成每报告最多8刻度，Windows决定每刻度行数/页数 |
| `hotkey` | `keys`；CTRL/SHIFT/ALT/WIN（GUI别名）及普通键；最多6个非修饰键；增加 PageUp/PageDown、Delete、Insert、锁定键、菜单键等明确 usage |
| `type` | `text`；1..64字符，US布局ASCII，保留首尾空格、LF、TAB；CR、其他控制字符、中文等整体拒绝，不裁剪、不忽略未知字符 |

未知键、重复键、超过报告容量的组合、无效按钮、水平滚轮及独立 `press/release` 整体拒绝，拒绝发生在消耗观察/打开设备前。首版不开放跨调用保持按键状态。

可选 `point`、`end_point` 为 `[x,y]` **原始窗口截图像素**，不是0..1000网格、DIP或HID坐标；即使显式给坐标，也必须给相应目标ID，点必须位于对应目标矩形内。`end_point` 只用于拖拽。

```json
{"op":"act","observation_id":"本次观察ID","action":"drag","target_id":1,"end_target_id":2,"duration_ms":500}
```

## 坐标与执行边界

观察新增 `image_origin`、`image_size`、`dpi`、`coordinate_space: desktop_physical_pixels`。截图像素加 `image_origin` 得桌面物理像素，再按屏幕原点及宽高映射：

```text
hid_x = round((desktop_x - screen_left) * 32767 / (screen_width - 1))
hid_y = round((desktop_y - screen_top)  * 32767 / (screen_height - 1))
```

合法零坐标与最后一个像素可用；NaN/Inf、布尔坐标、越界与屏幕/DPI/进程/窗口变更拒绝。仍限定单显示器、精确标题的前台窗口。初始动作重新核对目标文字/类型/矩形/来源、可用时的UIA runtime identity、启用与遮挡状态；拖拽起终点都检查。

执行前一次消费观察，取得最长12秒的内部 reservation；整条复合动作持有与凭据执行器相同的 `hid.lock`。每个会产生输入的非释放报告前，板端检查本地会话并通过认证 `/guard` 核对绑定 HWND/PID、精确标题、前台、几何、DPI、单屏、当前位置遮挡；键盘还核对焦点。新观察会撤销旧 reservation。guard 使用已绑定句柄，不在每报告重新遍历全部窗口或做OCR。HTTP guard 超时1秒，设备可写等待最多2秒，释放尝试最多1秒；这些是等待上限，不是跨进程停止SLA。

释放报告不受焦点校验阻挡，防止 Tab/关闭窗口后无法松键。异常、中断、停止、观察通道失联或 SIGTERM/SIGHUP 退出时，鼠标在最后已尝试的位置释放，不跳到计划终点。尚未发送报告时的取消不额外移动鼠标。释放失败明确报告状态未知。SIGKILL、断电、USB断开时不能保证释放送达，仍需恢复连接后重新观察，不能自动重放原动作。窗口检查与硬件报告之间仍有竞态，不构成系统级输入隔离。

路径按25ms间隔计算最多40报告/秒，点数取决于期望时长，不随像素距离增长。`duration_ms` 是名义路径采样预算；逐报告SSH/HTTP往返与主机消费会延长实际时长，不能当硬实时承诺。双击间隔也受这些延迟及Windows设置影响；本次测试窗识别通过不代表所有主机阈值。

## 首轮动作扩展：验证与证据

新增 `pc/HIDLab.cs` 只记录自身文本、键盘、鼠标、滚轮事件及按键状态；没有软件输入或剪贴板代码。`scripts/smoke-hid-input.py` 编译独立测试窗、启动精确窗口助手、通过USB SSH把动作交给板端实际执行器，再核对Windows事件和状态。动作由测试程序构造，**没有测试新动作的模型自主规划质量**，没有复用旧NPU质量记录。

固定最终实测：`logs/hid-input-hardware-20261030-6/summary.json`，16次动作（15次完整输入成功、1次预期停止）；`events.jsonl`、逐次 `observation-*.json`、截图、PC guard耗时与源码SHA256全部保存。`deployment-final.json` 核对本次板端源码与本地一致；`board-final-status.txt` 确认 `rndis.gs0` 与两HID仍存在、执行会话已解除。

| 分层 | 本次结果 |
| --- | --- |
| 离线编码/协议/边界 | 主机相关50项测试：49通过、Linux输入锁1项跳过；板端全套当时已部署96项通过，包含实际 flock 独占、信号取消释放测试。Ruff与Python语法检查通过，C#实际编译通过 |
| 真实板端报告 | 真实 `/dev/hidg*` 写入，主机认证观察→一次消费→逐报告guard→USB报告，无软件注入；原有常驻模型与凭据服务保持运行 |
| Windows效果 | 移动/悬停光标位置、三键单击、系统双击事件、完整按住拖拽、+2/-3刻度分别收到+240/-360 WM_MOUSEWHEEL；Ctrl+Home/End、PageUp/Down、Delete实际键事件通过 |
| 文本 | 输入 `" A1\nB2 "`，Windows Edit读回 `" A1\r\nB2 "`，首尾空格与换行语义保留；不宣称逐字节换行表示相同 |
| 停止释放 | 真实拖拽按下后写本次停止标志；约167ms后在pad相对x=72释放，未到x=630终点；最终鼠标三键与修饰键均未按住，动作退出1并记录outcome_unknown，测试按预期通过 |
| 坐标/DPI | 单屏2560×1440、观察窗口DPI120（125%）与截图物理像素映射，实际pad点击位置吻合；零边界、负屏幕原点、DPI变更拒绝另由离线测试覆盖，没有改变系统缩放做多配置实测 |

本轮guard共57次，中位数约1.31ms、最大约21.46ms（PC处理耗时，不含SSH往返）。名义500ms拖拽在Windows按下到松开约1165ms，整次动作含校验、SSH启动及回读约2031ms。主机与板端时钟不同，不跨端相减时间戳。WIN/GUI及多普通键组合完成编码测试，未在Windows发送会触发系统行为的Win快捷键。

失败保留：`...-1` 是测试误用Python3.11才有的 `enterContext`（已换成3.10兼容ExitStack）；`...-2` 功能通过但旧guard枚举窗口导致拖拽约7.7秒；`...-3` 在最后停止验收读状态文件遇Windows临时共享冲突，仍判失败（只给读回增加重试）；`...-4` 优化版通过；`...-5` 新增断言读带中文目标的观察文件误用系统GBK，判失败（显式UTF-8修正）；`...-6` 最终通过。没有重写失败日志或自动重放输入。

工作区其他任务在同期修改记忆功能。最后一次主机全套测试记录在 `logs/hid-extension-20261030-162152/host-all-tests.txt`：126项中 `test_private_memory.test_ordinary_revision_keeps_history_and_anonymous_fact_binding` 报 `sqlite3.OperationalError: no such table: jobs`，9项平台跳过。该失败在本次HID范围外，未修改对应源码；相关50项回归另存 `host-focused-tests.txt`。板端96项的源码/用例集合与同期主机不同，不能把板端全过代替主机全套全过。

## 操作与回退

从 `D:\RK` 运行（需本任务范围已授权的设备/窗口测试）：

```powershell
$runDir = 'logs/hid-input-' + (Get-Date -Format yyyyMMdd-HHmmss)
.\.venv\Scripts\python.exe rk-opencode/scripts/smoke-hid-input.py --execute --deploy --output-dir $runDir
```

`--deploy` 只备份并上传所列执行器/测试源码，逐文件SHA256核对后原子替换，不安装依赖、不启动模型、不调用 `hid-enable`。设备没准备好则失败；已有8091观察会话时拒绝覆盖。结束只停止本次测试窗/助手，保留其他任务。日常助手与Agent入口沿用子仓库README。

最初板端回退副本：`/home/cat/rk-opencode/.runtime/hid-backup-20261030-162841-6912/`；最终轮更新前副本见该轮 `summary.json` 的 `board_backup`。需要回退时先停止本次输入会话，按清单恢复相应源码；PC端也需同步匹配的旧observer/observations/desktop接口。不要重绑USB或回退其他任务。最早完整本地修改前副本与本次差异留在 `logs/hid-extension-20261030-162152/baseline/`。

能力范围仍为单窗口、单屏、US布局的执行器。未实现水平滚轮、纯HID Unicode、跨应用/多屏或模型通用桌面成功率；不会用Windows软件输入通道的中文能力充当USB HID证据。
