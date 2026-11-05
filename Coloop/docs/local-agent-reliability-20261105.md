# 本地 Agent 中文编辑与性能修复

本轮在 r7 的基础闭环上继续修复中文编辑、工具封装及本地提示负载。仍使用官方 DeepSeek Harness 和 RK Qwen 4B；模型权重、运行库与云端测试额度未调整。

当前日常入口已切换为 r13，完整验收汇总见 `.qa/reliability-r13-release.json`。1195 项回归通过，1 项可选 Docling 跳过；类型、发布构建、资源哈希和隔离安装包 UI 检查通过。

| 真实模型任务                           | 构建                     | 结果                        | 请求数 | 耗时      |
| -------------------------------------- | ------------------------ | --------------------------- | ------ | --------- |
| 多行中文局部修改，保留其余正文与 emoji | r12，编辑实现与 r13 一致 | completed，完整正文核验通过 | 5      | 329.54 秒 |
| 复选框单击并核验                       | r13                      | completed，仅点击 1 次      | 4      | 210.20 秒 |
| 空白编辑器输入完整中文                 | r13                      | completed，完整正文核验通过 | 4      | 256.09 秒 |

上述三项均为真实发布包、模型与 RK USB 输入，CUA 关闭以隔离 RK 路径，协议重生成次数均为 0。r13 勾选比 r7 同目标单次实测缩短约 38%，空白中文比 r8 缩短约 18%；本地模型仍为分钟级延迟，这不是多次统计平均或任意业务的成功率保证。

## 定位结果

- 复放 r6 空白编辑器的首轮请求，真实模型再次输出多余 JSON 右括号，并把程序状态目录与目标窗口的路径差异当成缺少信息。一次只读推理用时 66.93 秒，未执行工具。原始证据：`.qa/rk-replay-first-turn.json`。
- r7 原生阶段的系统规则与工具目录合计 10,334 字节；其中仍保留文件工具和文件规则。r8 按当前工具组折叠后为 7,748 字节，减少约 25%。宿主完整参数校验、授权与观察快照保持独立。
- r8 空白中文输入的五轮模型请求中，预填充约 229.79 秒，生成约 61.58 秒。主要时间花在重复读取输入上下文；无 KV 命中。原始元数据见 `.qa/r8-blank-latency.json`，其中最后一条开始于任务完成之后，不纳入五轮统计。
- r8 多行局部修改未通过：实际 RichEdit 全选索引为 28，WM_GETTEXT 正文长度为 30，差异来自两个 CRLF。保护检查拒绝了粘贴，原文仍完整保留；不能把该失败解释为模型已经成功修改。
- r9 多行修改仍未通过：观察中的旧提示没有要求先精确读取，模型先传空 revision 被拒；读取后实际 RK `Ctrl+A` 又将隐藏末尾段落标记计入选区，出现正文长度 28、选区末尾 29。后一问题用真实 RK 按键独立复现；代码 `SelectAll()` 的组件测试没有复现，不能替代真实按键覆盖。该失败原文仍保留，356.60 秒后在原有 6 次请求上限停止。

## 实现

1. 本地原生、文件等工具组按当前需要展示参数与规则；工具仍由宿主再次检查，不通过模型可见性扩大授权。程序状态目录明确不用于判断目标窗口。
2. 新增 `coloop_read_editor`，只读最新观察绑定的聚焦编辑器，返回精确原文、Unicode 字符分页、UTF-16 选区和正文 revision。相同范围与版本的重复读取不重复计进展。它不是完成证明。
3. `coloop_patch_text` 可带 `expected_revision`，在输入前拒绝并发变化。全选后、最终粘贴前的最后一次原生读取都必须匹配原正文与完整选区；不忽略已经检测到的变化。当前不支持通过此补丁清空整个编辑器，空结果在任何输入之前拒绝。
4. RichEdit 文本统一到实际选区索引单位：用系统消息核对最后一行的起始与长度，仅在 CRLF 转换后严格匹配原生长度时采用单 CR；普通 Edit 保留原文换行。该原生路径只接受 Unicode 控件，不将 ANSI/DBCS 索引当成 UTF-16。不能匹配的结构拒绝处理，不猜测偏移。微软对 Rich Edit 段落符和索引的说明见 [Rich Edit 控件](https://learn.microsoft.com/en-us/windows/win32/controls/about-rich-edit-controls) 与 [EM_GETSEL](https://learn.microsoft.com/en-us/windows/win32/controls/em-getsel)。没有发送跨进程 WM_USER 指针消息。
5. 本地非法工具封装先整体解析、返回固定 400 错误；任何部分都不会派发。仅可信 local 路由最多重新生成一次，经过同一任务请求预算、无进展限制、取消信号和单飞检查。远端输出、工具执行失败与未知输入不会由此重发；不替模型补造写入参数。
6. 统一观察结果与 patch 描述：已有正文先读取，再使用真实 revision，不能传空字符串。Unicode RichEdit 仅当选区末尾恰好比已核对的正文长 1、起点在正文范围内时，映射隐藏末尾段落标记；不裁剪其他越界选区。该标记见微软 [Rich Edit 文本模式说明](https://learn.microsoft.com/en-us/windows/win32/controls/em-settextmode)。真实 RK `Ctrl+A` 的独立组件回归见 `tests/native-editor-selectall-live.mjs`，明确不使用模型，OCR 为空桩，原生窗口、读取与 RK 输入为真实实现。
7. 本地修改工具按前置条件开放：只有成功读取当前观察绑定的编辑器后，才显示 `coloop_patch_text`。宿主执行时再次核对 observation、target 和读取返回的 revision，阻止保留的旧工具引用绕过前置条件。重新观察或输入使读取凭据失效。此约束由代码保证，模型提示不承担执行授权。
8. 原生观察作为基础只读工具开放；成功观察后展开 native 组，失败不切组，文件任务可显式切回文件组。当前窗口任务省去单独启用 native 的推理往返。控件名称比较也统一 CRLF/CR，避免将同一篇正文误当成 RichEdit 的标签。
9. 最近一次已确认的 click 后，只有相同窗口、进程、runtime_id 的 checked/selected 布尔状态真实变化才记一次进展；重复观察、重复状态及后续核验不会重复计数。未知/未发送回执、其他窗口/进程/控件、不可读或未变化状态不计进展。该进展不等于完成，仍须独立 `coloop_verify`，避免在真实变化后、核验前误触发无进展停止。

## 已完成的验证

- r12 多行局部修改通过：`.qa/harness-live-rk-rk-partial_editor-1793881295582/report.json`。真实发布包 → Harness → RK Qwen → RK USB，5 次推理，329.54 秒；observe → read_editor → patch_text → verify → 最终报告，任务 completed。正文只将“状态：待处理”改为“状态：已完成”，项目、备注、换行和 emoji 完整保留；原生核验 verified=true，零协议重生成。
- r13 复选框通过：`.qa/harness-live-rk-rk-checkbox-1793882332374/report.json`。4 次推理，210.20 秒，observe → execute → verify → 最终报告，单击/按下/释放各 1 次，checked=true，win32 核验 verified/observable 均为 true，零协议重生成。相较 r7 同目标 339.71 秒，单次实测缩短约 38%；不是统计平均或所有任务的速度承诺。
- r13 空白中文输入通过：`.qa/harness-live-rk-rk-blank_editor-1793882576098/report.json`，4 次推理、256.09 秒，完整正文精确匹配，effect_verified、release_confirmed=true，独立 win32 verified=true，任务 completed。隔离安装包 UI 检查见 `.qa/proactive-package-1793882930399/report.json`，使用隔离离线配置，不调用模型、RK 或 HID。
- r12 复选框失败样本：`.qa/harness-live-rk-rk-checkbox-1793881694598`，192.22 秒。模型首个 target_id 拼写错在输入前被拒，重新观察后实际单击一次且 checked=true，但因未计入控件状态变化，在第 4 次模型请求后被无进展上限停止，未完成独立核验与收尾。该样本不计成功；r13 修复上述进展计数。
- r8 空白中文输入：真实发布包 → Harness → RK Qwen → RK USB → 原生完整正文核验，任务 completed，311.88 秒，无协议重生成。证据 `.qa/harness-live-rk-rk-blank_editor-1793877342338/report.json` 与 `tool-proof.json`。
- r8 多行修改失败样本：`.qa/harness-live-rk-rk-partial_editor-1793878085020`，原文未改，失败保留。
- r9 多行修改失败样本：`.qa/harness-live-rk-rk-partial_editor-1793879307715`。隐藏段落标记修复后，实际 RK 按键组件通过：`.qa/native-editor-selectall-1793880143304/report.json`。
- r10 多行修改未通过：`.qa/harness-live-rk-rk-partial_editor-1793880233782`。模型仍先编造 revision，被格式校验拒绝；此外，测试窗口在 12:05:43 UTC 发生正文变化，而该任务检查点 commands 为空，不能归因于 Agent 已派发输入。后续精确读取被绑定保护拒绝，任务按无进展上限停止。此样本不计成功，也不据此声称模型完成了修改。
- r11 多行修改实际正文与独立 win32 核验成功，但首个全选粘贴被保护拒绝，后续读取、patch、verify 消耗了第 4–6 次请求，缺少最终收尾，整项任务仍按 6 次上限失败。证据 `.qa/harness-live-rk-rk-partial_editor-1793880739022/tool-proof.json`，367.88 秒；没有为得到通过结果提高预算。
- 控件标签修复后的 RK `Ctrl+A` 组件通过：`.qa/native-editor-selectall-1793881256815/report.json`。此前一次组件运行在全选后发生正文变为空格，观察阶段拒绝，失败证据 `.qa/native-editor-selectall-1793881173125/report.json` 保留，不计通过。
- 最终修复后原生编辑器组件 10 项通过：`.qa/native-editor-state-1793879088520/verification.json`，覆盖 Edit/RichEdit 的全选、局部选区、光标、自动折行、空正文，以及中文、尾换行与 emoji。复选框 9 项回归通过：`.qa/native-checkbox-state-1793879090069/verification.json`。
- r12 全量 Vitest 66 个文件、1188 项通过、1 项可选 Docling 跳过。TypeScript、完整生产构建与目录包构建通过；29,229 个包内构建/资源文件逐项哈希一致，main bundle SHA256 为 `FEEC0CC97ABC704F70EA67FDDE56C375A6B3F3088D9DC3C1303825D8F6B514F1`。
- r13 全量 Vitest 66 个文件、1195 项通过、1 项可选 Docling 跳过，类型检查、生产构建、目录包与 29,229 个构建/资源文件哈希核对通过。main bundle SHA256：`14B504E23C9154F65C93C38A44B41F96AD3E2AD73FCBB04EED5A43F7819DCF3C`。r12→r13 主程序 diff 只涉及 click 状态变化与 control_state 核验的进展计数，中文编辑实现一致，见 `.qa/reliability-r12-r13-main.diff`；局部编辑实机证据明确来自 r12。
- 最终粘贴检查覆盖正文并发变化、选区缩小与空结果；协议检查覆盖整体拒绝、最多一次重新生成、请求上限、远端禁止重新生成及取消后不进入第二次请求。

真实模型验收与组件测试分别记录；单个任务成功不代表任意复杂任务都可靠。全部旧失败证据、TARS/OpenCode 兼容入口与 r7 回退包保留。

r8–r12 的主 bundle 已归档并核对哈希，约 16.17 GB 中间目录包的删除被自动审批拒绝（`blocked by policy`，未给出更具体原因），原文件仍保留。五个包已完成可逆 NTFS 压缩，按 Windows 压缩大小统计，存储量降至约 11.07 GB，减少约 5.10 GB；文件数量、逻辑大小及主 bundle/归档哈希均通过复核。r13 默认版和 r7 回退版未压缩，三个默认启动器仍指向 r13。本次仅处理存储占用，未修改推理实现或新增性能验收。待清理清单及实际状态见 `.qa/reliability-r13-cleanup-candidates.json` 和 `.qa/reliability-r13-cleanup-result.json`，压缩证据见 `.qa/retired-build-compression-20261105.json`。
