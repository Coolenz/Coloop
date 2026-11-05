# Coloop 的 Cua Driver 接入

本批次与 RK 校时、服务维护和 Harness 修复并行，集成固定版本 `trycua/cua` 的 Windows Cua Driver 0.38.0。它是本机执行与观察组件，不替换 DeepSeek Harness、RK 模型或 Mem0。安装与上游依据见 [cua-setup.md](cua-setup.md)。

当前默认版本为 `release/harness-cua-0.14.0-20261105-r13/win-unpacked/Coloop.exe`。`start.cmd`、`start-desktop.cmd`、`start-proactive.cmd` 已统一指向 r13，r7 回退包保留。下文按实际版本区分模型自主任务、原生组件测试和早期失败证据。

## 当前版本验收

r13 完整构建和 TypeScript 检查通过；66 个测试文件、1195 项 Vitest 通过，1 项可选 Docling 测试跳过（`.qa/reliability-r13-vitest.log`）。发布包与构建的 29229 个文件哈希一致（`.qa/reliability-r13-integrity.log`），隔离安装包 UI smoke 通过（`.qa/proactive-package-1793882930399/report.json`）。主程序 bundle SHA256 为 `14B504E23C9154F65C93C38A44B41F96AD3E2AD73FCBB04EED5A43F7819DCF3C`；发布汇总为 `.qa/reliability-r13-release.json`。

同批实机使用真实 RK 模型、RK USB 输入和独立 WinForms 测试窗口。以下三项任务均为 `completed`，协议重生成均为 0；成功结论同时包含宿主核验和测试窗口读回：

| 实测版本与任务         | 本地模型请求 | 总耗时      | 结果与证据                                                                                                                                                         |
| ---------------------- | ------------ | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| r13 复选框             | 4 次         | 210.1981 秒 | 真实单击 1 次，checked=true，独立 Win32 核验 verified=true；`.qa/harness-live-rk-rk-checkbox-1793882332374/report.json`、`.qa/reliability-r13-checkbox-proof.json` |
| r13 空白编辑器中文输入 | 4 次         | 256.0905 秒 | 完整中文正文读回一致，Win32 核验 verified=true；`.qa/harness-live-rk-rk-blank_editor-1793882576098/report.json`、`.qa/reliability-r13-blank-proof.json`            |
| r12 多行正文局部修改   | 5 次         | 329.5430 秒 | 先 read_editor，再 patch，保留其他行及 emoji，完整正文核验通过；`.qa/harness-live-rk-rk-partial_editor-1793881295582/report.json`、同目录 `tool-proof.json`        |

局部编辑的真实成功版本是 **r12**。r12→r13 的主 bundle 差异仅涉及控件状态进展计数，编辑器实现未变（`.qa/reliability-r12-r13-main.diff`）；这提供实现连续性证据，不等于在 r13 重新跑过该案例。上述 RK 任务也不能替代 Cua 鼠标验收；Cua 的 r5 模型自主单击与源码组件单击、双击、滚动证据仍单独保留在下文。

本轮补齐编辑器原文读取与 revision 绑定、粘贴前最后一次正文/选区校验，以及 Unicode RichEdit 换行索引和隐含终段标记处理；不支持的空正文补丁在改变选区前拒绝。本地 patch 须先读取正文，成功观察会展开所需 native 工具以减少推理轮次。r13 仅把已确认 click 后、同 HWND/PID/runtime_id 的真实布尔状态变化计为进展，并去重；这不能替代独立完成核验。格式重生成仅限可信本地路由且最多一次，每次调用仍受请求计量、取消和无进展限制。

最终云台账仍为 12 次请求、100178 tokenUnits，无新增、无重复请求编号、无未结算请求（`.qa/reliability-r13-cloud-usage-audit.json`）。这是固定测试 profile 的用量；tokenUnits 含保守预留，不是精确账单 token。达到日请求上限后未清账本或换 profile 继续云测试。早期未完成的模型任务继续保留失败结论与证据，后续成功不覆盖历史失败。三个简单实机任务仍需约 3.5–5.5 分钟，不能据此声称复杂业务或所有桌面环境均已稳定。

r8–r12 中间包的逻辑大小共 16,169,918,778 字节，主 bundle 已归档至 `.qa/retired-candidate-bundles-20261105`，但删除被自动审批策略拒绝（`blocked by policy`，未给出更具体原因），已停止删除尝试。五个包仍保留，已完成可逆 NTFS 压缩：按 Windows 压缩大小统计，存储量降至 11,065,347,151 字节，减少约 5.10 GB；文件数量、逻辑大小及主 bundle/归档哈希均通过复核。清单为 `.qa/reliability-r13-cleanup-candidates.json`，只读预检为 `.qa/reliability-r13-cleanup-preflight.json`，压缩证据为 `.qa/retired-build-compression-20261105.json`。r7、原兼容/回退包及全部验收证据保留，r13 默认版和 r7 未压缩，默认入口和验收结果不受影响。

## 从代码学习这次接入

先理解三种职责：模型决定下一步，观察器提供当前窗口证据，执行器校验并执行一次输入。Cua 在这里负责补充观察和执行鼠标；不创建第二个云模型代理循环。

推荐按以下顺序阅读：

1. `scripts/setup-cua.mjs`：为什么固定版本、校验下载摘要和签名，并将运行时放入应用资源。
2. `src/main/infrastructure/cua-driver.ts`：私有 MCP stdio 握手、工具白名单、一次调用与超时/取消边界。`dispatched` 表示可能到达 Driver，不等于已经产生输入效果。
3. `src/main/infrastructure/cua-desktop.ts`：同一窗口的 UIA 树如何合并进 `targets`，哪些字段只留本机，以及 token 路径与截图坐标路径如何分别定位。
4. `src/main/infrastructure/cua-execution.ts`：为何先持久化 dispatch 再输入，如何按命令 ID 去重，以及 unknown 回执为什么不能自动换通道重试。
5. `src/main/services/tars-agent.ts` 与 `src/main/infrastructure/observation-context.ts`：完整宿主观察和模型可见摘要的区别；输入后为何还需要新的观察与独立核验。
6. `src/main/infrastructure/rk-tars-model.ts`：如何按当前剩余上下文预算生成最终模型请求，以及为什么某些 HTTP 错误码会触发 SDK 额外推理。
7. `tests/cua-native-live.mjs`：将单元测试推进到真实进程、真实截图/OCR、真实输入与独立效果读回；留意它与模型自主完成任务的证据区别。

上游 Cua 仓库包含多个层次。本接入只采用固定 release 的 Windows Driver，不将整个上游 agent 运行循环搬入 Coloop，因此原来的 Harness/RK 调度、隐私策略、Mem0和云预算仍由 Coloop 管理。

## 实际调用路径

```text
coloop_observe
  → Windows 截图 / OCR / UIA
  → Cua get_window_state：同一 HWND + PID 的有界 UIA 树
  → 前台身份复核 → 合并有名称、有可见边界的控件 targets

coloop_execute
  → 任务/观察时效/前台目标校验
  → click、double_click、scroll：CuaExecution 持久化 dispatch
      → 控件 token 或 Cua 原生尺寸截图坐标
      → 再次守卫 → Cua Driver → 持久化回执
  → move、hotkey、paste：原有 RK USB HID 执行器
  → 任务服务获取新观察，独立验证最终结果
```

只增强主动任务的观察；被动 OCR 建议轮询不额外启动 Cua UIA 遍历。已有 `ocr_text` 和 `ocr_items` 保持原语义；新增 targets 标记 `source: cua`，观察中的 `cua.status` 区分 ready/unavailable，`cua.truncated` 表示树被截断。控件 token 仅留在主进程，不交由模型构造。Cua 的原始控件 value、窗口标题和截图不写入本接入日志；截图只用于本机像素坐标绑定，不能据此认定整个应用不上传既有 OCR 内容。

优先通过 Cua snapshot token 点击匹配控件；OCR 目标使用新的 Cua 截图核对物理尺寸后转为窗口局部坐标。Cua 的树坐标与 Coloop 一样是屏幕物理坐标。所有路径仍受当前前台窗口、PID、矩形、点位控件和凭据保护约束，不开放后台任意应用控制或通用 Cua 工具给模型。

0.38.0 的截图不能直接套用 Win32 `GetWindowRect` 原点。Driver 的 `window_bounds` 优先采用 DWM 可见框，PNG 再从该框四边各裁掉 1 个物理像素；因此原生截图必须满足 `PNG.width = bounds.width - 2`、`PNG.height = bounds.height - 2`，坐标公式是 `x = screenX - (bounds.x + 1)`、`y = screenY - (bounds.y + 1)`。DWM 框必须完全位于本次 Win32 观察窗口内，目标点也必须落入裁后的 PNG；声明尺寸和实际 PNG IHDR 必须相等。DWM 不可用时，上游回退到完整 `GetWindowRect` 图像及原点，此时仅接受 bounds 与观察矩形完全一致、PNG 尺寸等于完整窗口的路径。不推测任意比例缩放或其它裁边。

固定 tag 依据：[DWM 窗口边界及 Win32 回退](https://github.com/trycua/cua/blob/cua-driver-rs-v0.38.0/libs/cua-driver/rust/crates/platform-windows/src/win32/windows.rs#L378-L399)、[截图裁边](https://github.com/trycua/cua/blob/cua-driver-rs-v0.38.0/libs/cua-driver/rust/crates/platform-windows/src/capture.rs#L61-L79)、[像素到屏幕转换及回退](https://github.com/trycua/cua/blob/cua-driver-rs-v0.38.0/libs/cua-driver/rust/crates/platform-windows/src/tools/impl_.rs#L228-L280)、[capture_id 的尺寸和身份绑定](https://github.com/trycua/cua/blob/cua-driver-rs-v0.38.0/libs/cua-driver/rust/crates/platform-windows/src/capture_admission.rs#L109-L172)。`click` 继续携带 capture_id；0.38.0 的 `double_click` 与 `scroll` 没有该参数，使用同一连接的新截图状态并保留派发前窗口、目标守卫，不能声称有独立 capture_id 消费保证。

## 启用与回退

开发环境先执行 `npm run setup:cua`，再启动 Coloop。主程序检测 `.cache/cua-driver/cua-driver.exe`，安装存在时自动增强观察并启用上述 Cua 鼠标路由。发布包使用 `resources/runtime/cua-driver`；`prepare:runtime` 包含 Cua 安装验证，`extraResources` 携带运行时。

- `COLOOP_CUA=off`：完整停用 Cua，沿用原观察与 RK 输入。
- `COLOOP_MOUSE_BACKEND=rk`：保留 Cua 观察增强，鼠标全部使用原 RK 路径。
- `COLOOP_CUA_DRIVER_PATH`：开发时指定本地可执行文件绝对路径，须使用兼容的固定 0.38.0 版本。

这些环境变量在启动时读取。缺少运行时则保留原能力。Cua 观察失败退回已有观察并返回 unavailable；**已选择 Cua 的输入失败不会自动转为 RK 重放**。私有 MCP 进程超时/取消后不会原地自动重启，重启应用之前必须核对未确认输入。

观察失败只输出固定白名单错误码，不反射原始异常、树或响应文本。30 秒读取冷却按 PID + HWND 分开保留，最多记住 64 个失败窗口；切换到新窗口可立即读取，来回切换最近失败窗口不能绕过各自冷却。终止性的 Driver 超时、取消或协议错误锁定当前实例，不因窗口切换或冷却到期重新调用。隐私撤销和取消仍直接抛出，即便命中缓存也先检查。

## 回执与限制

`cua-input-journal` 位于 Coloop 资料目录，仅保存命令摘要与 `channel: cua_driver` 回执。写入 dispatch 并 fsync 成功后才调用鼠标。相同 command ID 不重复派发；缺失结果的已派发命令按 unknown 处理，未确认释放时阻止后续输入。Cua 返回成功仅记 `input_sent`，不能替代 Coloop 的结果回读成为 `effect_verified`。

0.38.0 窗口模式 `move_cursor` 只移动提示光标，因此 `move` 保持 RK。滚动方向沿用 Coloop 的 steps 约定（正数向上、负数向下），仍须观察实际滚动结果。独立 Cua 控件不伪造 Windows runtime ID；需要编辑器文字或 checked/selected 核验时仍使用原生 UIA/Win32 证据。窗口布局变化、不可验证尺寸、失效 token 均不得猜测点击。

本轮源码测试和只读 Cua 握手不能替代真实 GUI 验收。最终同批验收须分别记录 Cua 鼠标、RK USB 键盘和模型自主任务的结果，且应覆盖混合 DPI、窗口切换、取消、未知回执和真实点击/滚动。构建、打包和桌面业务验收由“评估 Coloop 流程改进方案”统一安排，避免两个会话同时控制桌面。

2026-11-05 初始接入阶段：TypeScript 两套配置通过；6 个测试文件共 232 项通过（Cua transport 16、desktop 42、execution 17，另含 foreground / Tars / RK bridge 回归）。真实 Cua 0.38.0 私有 MCP 握手、工具发现、窗口枚举、窗口树及原尺寸 PNG 获取通过。该阶段仅做只读检查；后续输入实测和默认版本切换记录如下。

## 后续迭代与实际验证

RK 模型的上限按 `UTF8(system + messages.content.join('\n')) + 1152` 计算，共 16384 字节。原始密集观察会超过该上限：早期实测基础观察为13018字节，新增50个控件为19618，200个控件为39418。现采用两层模型投影，宿主观察及执行绑定保持完整：

1. 本地工具返回进入 SDK 之前先投影至6000字节，避免巨大的原始工具结果提前触发 SDK 自动摘要。焦点和同窗仍存在的最近操作目标必须保留；其余目标的省略数量明确报告。
2. RK transport 再扣除最终 system、全部其它历史、结果包装和1152输出预留，按剩余 UTF-8 字节投影最新观察。旧观察仅保留失效标记；新窗口不强制保留已消失的旧目标。
3. `coloop_observe({observation_id,query})` 从宿主当前完整快照查询控件名称，不重新截图或改变观察号。参数必须成对，旧观察号、输入后尚未更新的观察、取消状态均拒绝。查询仍使先前完成证明失效，最终必须再独立核验。查询和再次裁剪保留累计遗漏信息，不能把局部结果表示为完整屏幕。
4. 必需数据放不下时本地返回400专用错误码，不发起 RK 请求。没有采用413/context_length_exceeded，因为真实 Harness SDK 测试发现它会自动调用模型摘要。大源数据测试保留200控件及约180KB内容，两种实际 SDK 配合假模型均四轮完成，无额外摘要请求。

此轮回归：Tars 143项；RK模型/真实SDK与Harness预算38项；观察投影11项；Cua transport/desktop/execution106项。Node TypeScript检查通过。这些测试不调用真实模型或桌面。

历史 r7 包位于 `release/harness-cua-0.14.0-20261105-r7/win-unpacked`，完整构建/打包、UI smoke及29229个文件哈希核对通过；当时全量回归66个测试文件、1173项通过、1项可选依赖测试跳过（`.qa/reliability-r7-vitest.log`）。UI证据为 `.qa/proactive-package-1793875922856`；主程序 bundle SHA256 为 `8852D61C37EDCB9F198EB8CC4110FFD37AA07B229A94C178996B66EEB059D64B`。r6候选包及失败证据仍保留。当前默认版及最新验收见上文，历史结果按原版本保留。

r7 另修正 WinForms `BS_OWNERDRAW` 复选框的原生状态读取：仅样式11、同HWND的MSAA角色为`0x2C`时补充状态；不读取Value或调用MSAA动作，保持原目标ID和矩形。mixed不写checked，标准按钮继续原BM_GETCHECK路径。9个真实隔离fixture的角色、未选/已选/mixed、普通按钮、disabled及错误PID案例通过（`.qa/native-checkbox-state-1793875768176/verification.json`），这一组没有模型或输入调用。

同批持有桌面的会话另外完成真实验收：

- r5云端模型自主 Cua checkbox：4请求，observe → click → verify → final，独立fixture checked=true、click_count=1，任务completed。证据 `.qa/harness-live-cloud-cua-checkbox-1793873446022/report.json`。
- 修复裁边后的生产源码组件：checkbox、double_click、scroll三案均通过，每案一次输入；实际截图/OCR、validate/guard和fixture独立读回均执行，同进程与重建执行器重放不重复输入，stop后新命令被拒绝。证据 `.qa/cua-native-live-1793874320657-9961e49d/verification.json`。
- r7本地RK模型自主 checkbox：`CUA=off`，使用真实RK USB输入，任务及proactive阶段均completed，独立fixture checked=true、mouse_down/mouse_up/click各1，progress.units=1。耗时339.70535秒，证据 `.qa/harness-live-rk-rk-checkbox-1793875947589/report.json`。这是基础复选框任务通过，不代表中文编辑或复杂业务已可靠。

r7 同目录的 `control-state-proof.json` 从官方会话记录提取实际工具链 `enable_tools → observe → execute → verify`；最后核验返回 `verified=true`、`observable=true`、`source=win32`、`completion_verification_required=false`。该成功同时有工具核验与独立fixture效果，不只是模型的完成声明。

第二组是源bundle执行器实测，Driver取自r5包，不是完整发布包的模型自主验收；其中RK生命周期使用明确标记的非输入stub，也未验证手势中途取消。第三组才是r7完整应用的真实RK模型与输入闭环。混合DPI、多屏及用户任务的覆盖仍需后续独立案例。云测试累计12次已达本批日限，r7本地测试结束后仍为12次、100178 tokenUnits；用量及失败案例见 [cloud-token-preflight.md](cloud-token-preflight.md)。

r6 的 RK 空白编辑器中文任务另有未通过样本：`.qa/harness-live-rk-rk-blank_editor-1793874696938/report.json`。模型首轮输出解析失败，未派发工具、未产生输入；不能由上述 Cua 组件通过推导该本地模型业务通过。适配层的内存验证支持合法分开的多个 tool_call，没有证据要求放宽动作参数或补造模型调用。
