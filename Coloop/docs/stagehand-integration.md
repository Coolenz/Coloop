# Stagehand 浏览器适配

2026-11-05。固定使用实际 npm 发布的 `@browserbasehq/stagehand@4.4.0`，不是 v3 的构造器或 Browserbase 远程浏览器。主任务循环继续属于 Coloop 所选 Agent；Stagehand 负责浏览器观察、结构化提取与单个受控动作。

## 安装与运行

`npm ci` 同时安装 SDK 与官方浏览器扩展。需要本机 Chrome；可通过 `CHROME_PATH` 指定已安装浏览器。运行 `node scripts/setup-stagehand.mjs` 检查版本、浏览器路径与扩展资源摘要。该检查不下载浏览器、不注册服务、不请求模型。

本地浏览器使用官方 `localBrowser.launch()`，每任务生成独立临时 profile，当前不复用个人登录配置。开发测试使用 headless Chrome；生产可见性由 `WebReader` 的 headless 参数控制。宿主通过 SDK 返回的本地 CDP 地址连接 Playwright，用于现有网络权限、实际控件绑定、附件和完成读回。

当前 Electron 发布配置采用 `asar: false`，扩展可直接从安装目录读取。若未来启用 ASAR，必须将 `node_modules/@browserbasehq/stagehand/dist/extension/**` 放入 `asarUnpack`；适配器在首次动态加载 SDK 前会将官方 `STAGEHAND_EXTENSION_DIRECTORY_PATH` 指向 `app.asar.unpacked` 的真实目录，资源不完整时明确拒绝启动。

## 能力与边界

- `snapshot(page)`：官方 accessibility tree、XPath 与 URL 映射，无模型调用。
- `observe(page, instruction)`：官方 `observe()` 返回实际 AX 节点对应的候选动作。WebSession 只把能够对应当前真实 ElementHandle 的候选映射为已有 `target_id`，候选文字和方法不能直接执行。
- `extract(page, instruction, schema)`：官方 `extract()` 按 Zod schema 返回结构化数据；WebSession 在调用前后核对观察，输出标记为提取结果，并不自动成为业务完成证据。
- `act(page, action, beforeDispatch)`：只接收宿主校验过的确定 selector、限定方法和参数，不接受自然语言。必须在派发前执行宿主守卫。关闭 SDK self-heal 与 cache，禁止执行阶段调用模型。一次只允许一个在途操作。
- `setChecked` 是当前真实状态检查、最多一次官方 click、最终布尔状态读回；SDK 没有直接 `setChecked` act 方法。不会连续点击直到成功。
- 上传及下载继续走既有 WebSession/WorkspaceSession，保留授权目录、附件摘要、PDF 审阅和新文件提交规则。

网络写入仍只允许任务明确指定的 origin。页面、selector、模型输出不能扩大 origin 授权。页面属于本任务的校验以 BrowserContext 和真实 CDP target ID 为准，不按 URL 猜测标签页。

Stagehand 的 click 成功只证明动作派发，不能直接证明 form POST 已得到结果。扩展与 Playwright 使用不同 CDP 连接，因此点击确认后为导航 request 事件保留 250 毫秒到达窗口。适配器跟踪该次动作引起的主框架导航，并在单步 10 秒内等待响应和 DOMContentLoaded；超时及派发后异常返回 `unknown`，不重试。随后由父 Agent 重新观察并调用 WebSession `verify` 核对业务效果。这个单步确认期限不构成整个任务的总时限。

SDK 4.4.0 在 Windows 关闭 Chrome 时可能先完成 `Browser.close`，再由 `taskkill` 返回 255。仅当独立 Playwright CDP 连接也已经断开时，适配器将这一已知退出竞态视为正常关闭；连接仍在或其他错误继续报错。成功交接的会话由 WebReader 保留到应用退出，任务清理不主动关掉用户要继续使用的浏览器。

## 模型与用量

v4 的自定义模型接口为 `model: { generate }`，不是自定义 `baseURL`。适配器只调用任务宿主传入的 `StagehandCompletion(request, signal)`。宿主选择本地/云模型并负责既有隐私策略、任务关联、限速、预算与用量台账；适配器没有 provider key、Browserbase key、默认云端模型或网络 fallback。

回调传递 system、文字消息、JSON Schema、schema 名称和温度。图像及工具内容块拒绝；输出严格解析 JSON，并由 SDK 和业务 schema 验证。不会自行重试失败推理。取消信号传到宿主模型调用。

官方 v4.4.0 的一次 observe 在本地夹具中调用模型一次；一次 extract 会请求 `Extraction` 和 `Metadata`，共两次。两次都经过相同宿主回调和用量记录。默认确定动作及 snapshot 不调用模型。

## 本轮验证

`npx vitest run tests/stagehand-runtime.test.ts` 使用真实官方 SDK、其 npm 包内扩展、本地隐藏 Chrome、本地网页和宿主持有的合成 HTTP 模型端点，覆盖：

1. 宿主 schema 与取消透传、拒绝图像、拒绝动作阶段推理。
2. 真实 snapshot、observe、extract、中文填写、下拉选择、复选框和单次 POST；密码 canary 未出现在 snapshot 或模型请求中。
3. WebSession 的 navigate → discover → extract → act → 独立 verify，旧观察被拒绝；前置 guard 拒绝时业务发送为零。
4. 真实 POST 响应延迟 11.5 秒，先收到 unknown，再读取实际页面并核验完成，POST 总数为 1、模型调用为 0。
5. WebReader 默认 Stagehand 会话中的真实 multipart 附件上传、单次提交、实际下载文件和 WorkspaceSession 摘要读回。
6. 核验后交接的真实页面在任务 dispose 后仍可读，应用 dispose 时释放；取消任务后已关闭 runtime 及时从 WebReader 注册表移除。

五个测试通过，与 `web-reader.test.ts`、`web-session.test.ts` 合跑共 12 个测试通过。初次探针发现官方 act 提前返回派发成功，以及两个 CDP 连接的事件时序差异，已补导航确认后重测；没有把先前失败当作通过。这部分不是真实云模型、真实外部账号或真实业务平台实测。

## 发布包隔离验收

`node tests/runtime-package-smoke.mjs` 默认验证 `release/harness-cua-0.14.0-20261105-r13/win-unpacked`，也可以将其他发布目录作为第一个参数。它将当前三个适配器通过 esbuild 编译成临时 probe，依赖保持 external，放在包的 `resources/app` 下并逐项确认模块从该包的 `node_modules` 解析。执行器使用包内 Node 24.14.0，工作目录、Harness 状态、Docling 缓存、浏览器临时 profile 均位于新建 `.qa` 目录；测试结束移除 probe，不修改包核心文件。下列隔离验收结果来自原 r1 基线；默认路径更新本身不代表重新执行了这些验收。

默认保留正常 Windows 系统环境，移除密钥、令牌、代理和 Node/Python 路径覆盖；PATH 只保留包内 Node 和 System32。2026-11-05 实测通过：

- 官方 Harness SDK 调用一次真实宿主工具，两次本地合成模型请求，以 `stop` 完成并关闭 SDK。
- 包内 Stagehand 扩展提取实际网页金额 42.50，填写中文客户，提交一次真实本地 POST，并从实际页面读回结果；总计两次合成模型请求。
- 包内独立 Python 3.12.10 生成中文 DOCX，Docling 2.147.0 解析正文及表格共 6 个块，源文件 SHA-256 与再次读取缓存均验证通过。

结果见 `.qa/runtime-package-windows-1793859037384/report.json`。这是使用真实库和发布依赖的脚本测试，模型端点是合成夹具；Electron 主进程/UI 启动由单独发布包测试覆盖，不能将该结果当成真实模型业务验收。

`--strict-env` 可显式启用完整环境白名单并重写 Windows 用户目录。此模式在本机 Chrome 156 中启动进程后没有开放调试端口，60 秒失败，证据保留于 `.qa/runtime-package-1793858716849/report.json`；源/包扩展 8 个文件逐项 SHA-256 完全一致。只恢复系统原有 `USERPROFILE`、`LOCALAPPDATA`、`APPDATA`（`--strict-env --native-known-folders`），其他白名单限制不变，三项验收全部通过，见 `.qa/runtime-package-strict-native-folders-1793859110020/report.json`。因此测试不重写产品所需的 Windows 用户目录；浏览器自身仍始终使用 SDK 新建临时 profile，没有复用个人浏览器登录。

官方依据：[SDK README](https://github.com/browserbase/stagehand)、[v4 自定义模型](https://docs.stagehand.dev/v4/configuration/models)、[v4 本地浏览器](https://docs.stagehand.dev/v4/configuration/browser)。实际 API 同时以安装的 4.4.0 类型声明和扩展实现核对。
