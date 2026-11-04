# Windows 软件桌面 skill 原型（2026-10-30）

本专题记录已完成的Windows软件通道实验：板端RK负责理解任务，Windows常驻执行器完成打开文件、点击控件、文本与数字输入。模型、Runtime和既有HID入口保持各自配置；软件输入使用独立回环端口 `8093`、鉴权密钥、会话和停止信号。

## 后续统一方向：RK直接USB HID

2026-10-30 用户明确要求按下位机HID路线统一：电脑侧负责截图、OCR/UIA观察和结果校验；RK侧根据观察调用板端本地执行器，经 `/dev/hidg*` 发送键鼠报告。统一HID skill说明操作方法，本地CLI/函数为直接调用入口，MCP保留为可选兼容适配。

```text
电脑截图 / OCR / UIA → RK决策 → 板端本地执行器 → USB HID → Windows应用
        ↑                                                    │
        └──────────────── 再观察与结果校验 ────────────────────┘
```

首次对齐时的状态（后续硬件优化另列如下）：

- `agent/observation_view.py` 的控件去重、紧凑数组与增量投影已经在下文软件通道验收，可供HID观察链路复用；尚未据此完成HID入口的接线和实机验收。
- 本专题 `fill_form` 仍由 `pc/windows_service.py` 执行，实际输入为Windows SendInput。HID侧可复用批量编排思路，仍需接入板端执行器、逐步观察及失败停止，单独验收。
- `os.startfile` 文件关联打开、Unicode中文填写及下文46.547秒结果属于软件通道证据。它们不证明硬件HID具备对应能力，也不作为HID速度或任务成功率。
- HID源码已有 `scripts/hid-act.py → agent/desktop.py:DesktopTools → agent/hid.py:HIDController` 的直接入口。当前普通HID文本范围为1..64个US布局ASCII字符；中文/输入法与通过界面打开文件需要各自的硬件任务验收。不会自动改走剪贴板、SendInput或文件关联打开。

后续优化已在 `agent/hid_workflow.py` 接入紧凑/增量观察与RK本地HID批填，并完成真实USB隔离表单验收；现有RapidOCR+UIA初始观察2582→383字节，增量70字节，一条请求执行7个HID动作且逐字段核对。该次没有调用模型，也没有把软件中文/文件关联能力迁入HID。统一HID实现、直接入口及固定日志见 [HID优化验收](24-rk-hid-input.md#紧凑观察与板端批量填写)。下文仍保留原软件通道实验的配置与耗时。

## 已完成的软件实验实现

- skill 来源：`rk-opencode/skills/rk-windows-desktop/SKILL.md`。
- Windows 执行器：`rk-opencode/pc/windows_service.py`、`windows_input.py`，复用既有窗口 UIA/OCR 观察。
- RK MCP：`rk-opencode/agent/windows_desktop.py`、`mcp_server.py --mode windows`。
- 专用 OpenCode 入口：`rk-opencode/scripts/windows-agent.sh`，由 `agent/windows_config.py` 从当前模型 profile 生成独立配置，将 skill 正文预载为 agent 提示，省去一次单独加载 skill 的模型往返。并未声称已验收 OpenCode 原生按需 skill 自动选择。
- 每次用户消息由 `plugins/windows-desktop.mjs` 补充最新窗口上下文。只调用记忆服务的前台活动/让路接口，不召回、入队或写入 Mem0；此入口没有记忆工具。

不写Mem0不代表不留日志：观察服务沿用本地窗口截图记录，普通模型桥接日志可能保留输入/输出。该入口没有接入云端，也未增加通用脱敏能力。

`fill` 是复合操作：检查最新观察与控件 → 点击 Edit → 确认真实焦点 → Ctrl+A 和 Unicode 软件键盘输入 → 读取 UIA value 精确比较。`value_verified=true` 只证明该输入框值匹配。按钮是否提交成功仍以动作后应用状态判断。

数字通过字符串传递，保留 `00123`、`-00123.4500` 等原始格式。支持最多512个单行字符，包含中文；不把数值自动转为浮点数，不把换行或 Tab 混入文本。`type` 追加到当前已观察 Edit，`hotkey` 单独发送 Enter/Tab 或 CTRL、SHIFT、ALT 组合。

## 使用软件实验入口

从 `D:\RK` 执行。首次安装本能力时使用 `-Install`，只复制专用客户端、MCP入口、插件、启动脚本及skill，不运行整包部署或模型编译；已有远端文件发生变化时先保存到 `.runtime/windows-backup-<时间>/`，上传后核对SHA256。

```powershell
# 密码通过当前进程 RK_BOARD_PASSWORD 提供；不写入脚本或日志。
# 精确窗口标题应替换成实际应用标题；文件列表是本次会话允许打开的文件。
powershell -ExecutionPolicy Bypass -File rk-opencode/scripts/windows-desktop.ps1 `
  -WindowTitle '实际窗口标题' -AllowFile 'D:\RK\agent-output\报告.txt' -Execute -Install

# 保持电脑助手运行，再从另一个窗口启动交互 agent。
powershell -ExecutionPolicy Bypass -File rk-opencode/scripts/windows-agent.ps1
# 也可双击 rk-opencode/Windows软件桌面Agent.cmd。

# 结束电脑助手和 SSH 回环隧道：
powershell -ExecutionPolicy Bypass -File rk-opencode/scripts/stop-windows-desktop.ps1
```

没有 `-Execute` 时只生成计划。`open_file` 只接受启动时显式列出的绝对文件路径，限文档/图片扩展名；通过 Windows 文件关联直接打开，不经过命令行、运行对话框或资源管理器逐级导航。测试工具额外可固定 `--file-app`，将合成文本交给专用隔离程序，不更改系统文件关联。

模型工具名为 `rk_windows_desktop`，操作名放在 `op` 中。例如：

```json
{"tool":"rk_windows_desktop","arguments":{"op":"fill","observation_id":"本轮观察ID","target_id":1,"text":"-00123.4500"}}
```

动作自动返回新观察，下一次使用新的 `observation_id`。窗口移位、前台/焦点变化、控件遮挡、过期/已消费观察会拒绝动作。动作前消费凭据；部分输入或网络结果不明时停止，不能自动重放。`input_sent`、`open_requested` 与最终业务完成分开记录。SendInput 前台检查与系统输入队列不是原子事务，仍须在会话期间避免用户和其他自动化同时操作同一桌面。

## 验证记录

专用 WinForms `WindowsDesktopLab.cs` 从生成的 `.txt` 文件读取未知随机码，提供 Text、Number 和 Apply。测试程序独立记录实际文本、数字、点击次数和进程ID，不能仅凭HTTP成功或模型自述判定任务成功。

- Windows 真实软件输入：`rk-opencode/logs/windows-desktop-20261030-143201-6d58/`。六次操作（打开、替换文本、追加中文、替换数字、Tab、点击）共5.393秒，含动作前校验和动作后观察，不含编译/助手启动或模型推理。应用记录及UIA/截图核对：中文完整，数字为 `-00123.4500`，Apply恰好一次，显示正确随机码。各工具耗时约0.565～1.359秒。`fill` 的约0.35～0.37秒 input_ms 包含点击后的焦点观察，不是单次 SendInput API 耗时。
- 未鉴权真实HTTP请求返回403。11项新增单元测试验证计划模式、文本类型、UTF-16、文件范围、单次消费、焦点变化、验证失败及新用户消息前阻止重放；既有桌面/fast/观察相关14项回归通过。另有4项相关Node插件测试通过。语法、Ruff、PowerShell和skill格式检查通过。
- `windows-desktop-20261030-143024-97e6`：本机空闲端口连接探测发生超时，首版只捕获拒绝连接，修正为捕获套接字错误，最终监听仍由bind确认。
- `windows-desktop-20261030-143047-e77c`：打开成功，填写动作发出后前台窗口变化，后续观察失败，未点击Apply，保留为失败。
- `windows-desktop-20261030-143245-91fe`：首版测试启动器没有等待setsid子进程，日志过早结束；实际首轮模型还将open_file错用为工具名，被桥接层拒绝。增加明确工具名与调用示例，不修补或代造模型输出。
- `windows-desktop-20261030-143350-45a6`：SSH输入没有EOF，OpenCode停在初始化；只终止本次记录的进程组，补充关闭SSH写入端。该次没有计为模型任务成功。

真实 RK / OpenCode：`rk-opencode/logs/windows-desktop-20261030-145240-8137/`。测试工具先打开生成文件，通过 Computer Use 显式激活隔离窗口后发出新用户任务。真实Qwen4B依次生成两次fill、一次click和最终回答，应用记录为中文 `窗口文本测试 RK-97f3`、数字 `-00123.4500`、Apply恰好一次；最终文本准确返回未知文件码 `97f30e7d8f`。四次模型请求合计96.697秒，首请求开始至末请求结束跨度99.761秒（包含其间工具动作，未计之前的打开文件、人工前台准备和OpenCode启动）。首次1354 prefill token，后续586/593/597，原生缓存复用；这仍是单个合成样例，不能代表通用成功率或SLA。

该次历史 `status.json` 的 `task_seconds=289.657` 包含84.855秒NPU就绪等待和前台准备，不能当作纯模型任务耗时。核实后的计时/最终回答见 `verification-summary.json`，原始模型输出见 `model-requests.jsonl`、`opencode.jsonl`；运行源码快照逐一匹配manifest SHA256。后续测试脚本已把准备阶段移出计时，并只检查最终text事件中的随机码，避免把工具回传中的码当成模型最终回答。

另保留以下失败：`144157-39a9` 未取得前台；`144248-22d6` 首轮多了JSON右括号；`144517-6e7e` 默认agent未显式传入消息hook，未注入初始观察，模型编造观察号，被校验拒绝；`144821-3cdb` 已修正hook，但等待前一次NPU调用结束时观察过期，校验拒绝。最终入口显式选择rk-windows；测试先等NPU就绪，抓新观察后再推理；错误锁定阻止同一用户轮次后续输入，未修补模型输出或扩大前台权限。

默认文件关联路径也实际调用并验收：`rk-opencode/logs/windows-association-20261030-150113/`。`os.startfile` 将合成 `.txt` 交给系统 Notepad，Computer Use独立读到随机码 `fd69665a64` 和中文 `中文文件打开验证`，随后只关闭本次新增标签。配置使用“记事本”后缀，实际标题为“Notepad”，所以执行器如实返回open_requested及观察标题不匹配；文件打开与后续窗口观察分开判断。前一目录 `150009` 在发送HTTP前发现Windows默认GBK解码UTF-8会话文件失败，已修正为显式UTF-8，并有中文会话文件回归。

## 2026-10-30 OCR/UI输入压缩与批量填写

优化接入复用 `ScreenOCR` 的Windows桌面Agent后处理，不替换RapidOCR模型、不升级环境。`-OCR` 开启原有OCR与UIA混合观察；不加该参数时，UIA结果也使用同一投影。父项目单次OCR脚本未改成批量执行器，HID入口保持独立。

`agent/observation_view.py` 在客户端生成模型视图，Windows执行器仍保存完整原始观察：

- 首次返回 `view=full`，`targets` 为 `[id,type,name,value]` 数组，未提供value的行可只有前三项；焦点独立为 `focus`，禁用控件放在 `disabled`。去掉窗口非客户区按钮及与标准控件重复的静态标签，保留有意义的OCR文字和结果状态。
- 后续动作返回 `view=delta`、`base`、新的 `observation_id`，`set` 替换有变化的整行，`remove` 删除旧ID。未变化内容沿用已缓存基线。会话/用户轮次不一致、窗口句柄或进程身份改变、基线不匹配、前次不完整，或增量不比完整视图小，均回到完整视图。
- 默认投影预算4096 UTF-8字节。预算不足会标 `incomplete`，不能据此断言目标不存在。`{"op":"observe","detail":"full"}` 可取消投影筛选并提高预算；它仍受原始收集器的控件数量上限约束，不代表扫描了任意大窗口的所有控件。
- 模型视图及基线保存在当前私有 `.runtime/windows-desktop-view.json`，跨初始消息hook和MCP进程保持一致。初始消息更新用户轮次，失败仍锁定本轮输入。新增缓存同样可能包含窗口文字，不是脱敏存储。

`fill_form` 将最多四个明确输入框和一个可选提交目标合成一次调用：

```json
{"tool":"rk_windows_desktop","arguments":{"op":"fill_form","observation_id":"最新观察ID","fields":[{"target_id":1,"text":"中文文本"},{"target_id":2,"text":"-00123.4500"}],"submit":3}}
```

先验证全部参数和目标，再逐个使用原有fill/click流程。每次仍重查前台、焦点、控件身份、位置和真实value；后续目标改变、验证失败、超出批次时间预算即停止。批次不是事务：此前输入可能已发生，禁止重放。`batch_complete` 表示声明动作执行完，最终业务结果仍看返回的应用状态；未接入额外审批、Shell或其他应用权限。

参考机制来自 [mcp-windows的增量快照](https://github.com/sbroenne/mcp-windows/blob/75aced99e633e7fba3f88be8c552abe00b1b66af/src/Sbroenne.WindowsMcp/Automation/SnapshotDiffEngine.cs)、[批量步骤](https://github.com/sbroenne/mcp-windows/blob/75aced99e633e7fba3f88be8c552abe00b1b66af/src/Sbroenne.WindowsMcp/Automation/Tools/UIBatchTool.cs)及 [desk-mcp紧凑输出](https://github.com/DigitalDog1/desk-mcp/blob/e6d42fce832b439685535ad31e8a9c0d5c68ad74/server.mjs)。本次针对现有Python链路独立实现，未安装这些完整服务或引入其云端决策器。

### 本次证据

- `logs/ocr-projection-check-20261030-171219/`：专用OCR环境真实离线识别，中英文数字、空白图、负屏幕origin坐标检查均通过，输出保存到新目录。
- `rk-opencode/logs/windows-desktop-20261030-171208-437e/`：真实OCR/UIA＋软件输入一次fill_form完成两框和Apply，批次约4.485秒；应用独立记录中文、`-00123.4500`及恰好一次点击，截图/UIA复核一致。初始观察1247→315字节、14→5个模型控件；动作后观察1445→286字节。这是UTF-8传输大小，未冒充Qwen token数。
- `rk-opencode/logs/windows-desktop-20261030-171730-35b5/`：真实RK/OpenCode＋OCR完整通过。RK一次生成fill_form，执行器约4.407秒完成两次填写和一次点击；第二轮最终回答准确返回随机码 `4d85cfdebb`。两次模型请求合计46.547秒，首末请求跨度51.620秒；从前台准备后计入OpenCode启动的任务耗时56.994秒。新增prefill为1131＋266=1397 token，输出77＋15=92 token，最高记录温度57.307℃。全部运行源码快照匹配manifest SHA256。
- 旧参考样例为同类合成表单，4次模型请求96.697秒、新增3130 token；本次2次请求46.547秒、新增1397 token。两次随机码不同、旧样例未开启OCR，且本次同时改变投影、skill和批量调用，属于样例对照，不是严格A/B或普遍加速比。两次均由测试工具先打开文件并显式激活窗口，未证明跨应用自主流程。
- 相关Python检查42项，41通过、1项Linux文件锁检查在Windows跳过；相关Node插件4项通过。新增投影测试覆盖增量还原、删除/焦点/禁用状态、窗口替换、预算不完整及完整视图恢复；批量测试覆盖全量预检、失败停止和不重放。Ruff、语法和skill格式检查通过。

失败记录不覆盖：`170904-773a` 打开后未取得前台；`171019-df6f` 测试脚本误将直接observe返回当作动作封装，尚未执行批次；`171350-0bba` 真实RK生成了正确批次，应用已完成，但旧反向转发socket的5秒读取超时丢失回执，未计成功。现将5秒仅用于建立本地连接，持续读取由HTTP动作超时约束；未重放该批次，使用新会话验证最终成功。

## 当前范围

单会话、单显示器、精确标题前台窗口、可见UIA控件为主；可选OCR补充文字目标。暂未验收任意图标区域、跨应用完整工作流、多行文档编辑、拖拽、混合DPI多屏或UAC安全桌面。文件打开不保证Windows授予前台；必要时由用户切换目标窗口，再发送新任务。Unicode机制并不保证所有自绘控件/特殊编辑器均支持。模型默认输出预算也可能限制长文本工具参数，需检查截断，不能把512字符工具上限理解成模型必定能一次生成的长度。

Windows API依据：[SendInput](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput)、[Unicode KEYBDINPUT](https://learn.microsoft.com/en-us/windows/win32/api/winuser/ns-winuser-keybdinput)、[文件关联打开](https://learn.microsoft.com/en-us/windows/win32/shell/launch)。软件输入受进程完整性级别限制；本次以普通权限隔离程序验收。
