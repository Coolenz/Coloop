# DeepSeek Harness 运行层

Coloop 使用官方 `@deepseek-ai/dsh-sdk-client@0.2.1-rc.5` 与其同版本 `@deepseek-ai/dsh`，经 SDK 启动独立标准 Node 子进程。官方 AgentLoop 负责推理、工具循环、上下文压缩与会话日志。Coloop 保留任务授权、模型预算、设备状态、RK 输入回执、未知动作处理和成果核验。

本版本仍为上游预览版。npm 的 SDK `latest` 标签曾指向旧 `0.0.1-rc.1`，因此必须按锁文件使用精确版本，不能以浮动标签升级。本文描述实测发布包，不把上游 master 新增 API 当作已安装能力。

## 运行边界

`src/main/infrastructure/harness-runtime.ts` 创建隔离的 `coloop` profile。它从空 bundles 清单加载所需 Agent、LLM、持久化、checkpoint、压缩及 SDK 服务，不继承 `sdk` 或 `sdk-minimal` 的默认工具。模型工具仅来自宿主注册的 `coloop_*`；没有 shell、原生鼠标键盘、浏览器、插件安装或任意文件工具。内部文件服务只供运行时会话工作目录服务使用，不暴露为模型工具。

`resources/harness/coloop-plugin.mjs` 注册受限工具并通过本机随机端口和随机令牌调用宿主。模型看不到桥令牌或云密钥。工具参数通过官方 JSON Schema 校验，宿主再次检查工具名称、当前可见性、会话身份和调用编号。官方循环设置 `maxParallelToolCalls: 1`；宿主也拒绝重叠调用。

模型适配器只连接该本机桥，桥再调用宿主提供的 `options.fetch`。常规模型请求与自动压缩请求均经过同一模型计费、预算、隐私和取消通道。子进程不继承云 API Key 或代理变量。请求次数上限在实际转发前检查，不能依靠模型自行遵守。

RK 仍使用现有受控文本接口。适配层把工具定义和历史转换成现有 `<tool_call>` 文本协议，解析 RK 回复为官方工具调用流；它不增加本地重规划循环。RK 传输按 UTF-8 字节执行 16384 的独立硬限制，普通输出最多 1024 token，并遵守每次请求指定的更小上限。DSH 本地路由声明实际 16384 上下文容量；压缩在约 2560 启发式 token 时提前触发，保留最近 384 启发式 token，摘要输出最多 512 token。不能用虚报 4096 容量来提前压缩：当前 pi-ai 额外预留 4096 tokens，会因此把实际输出压成 1 token。压缩触发阈值和模型容量必须分别配置。字符启发式不保证任意中文历史都能装入上下文，独立字节守卫仍会拒绝过大的请求。压缩走同一宿主路由和计数，原始审计保留，不能通过清空账本或重放工具解决上下文不足。

本地模型超时后，桥接进程可能仍存活而 worker 已退出。自动准备服务只在核对原 bridge 的工作目录、精确启动参数、PID 启动时间、认证健康响应的模型/协议/指纹，以及模型锁空闲后，调用已有的正常停止与启动脚本恢复。健康模型、占用中的模型、错误身份、鉴权失败或无法确认的健康状态均不触发替换；不会宽泛杀进程或修改模型权重。

本地路由通过 `resources/harness/coloop-compaction.mjs` 继承当前锁定版本官方 `BasicCompactionEngine`，只覆盖 `summarize` 扩展点：摘要调用不携带执行工具 schema，并将规划器 system prompt 换成只做摘要的短指令；全部非 system 历史仍交给官方摘要器。摘要不能执行工具，仍使用原本地路由、512 token 输出上限及宿主请求计数。官方引擎继续负责取消、摘要缩小校验、持久化替换和原始日志；云端路由保持默认压缩器。此调整避免摘要请求为了复用前缀而带上完整工具说明，自己先撞上 RK 字节限制。真实归档恢复是否通过须单独看验收报告，回归通过不替代实机结果。

## 停止与恢复

发布版 SDK 没有单会话取消 RPC，所以一个 Coloop runtime 只承载一个任务。`abort()`先撤销宿主 AbortSignal，再关闭并等待官方子进程退出；`run()`的取消结果和`dispose()`均等待宿主仍在执行的工具收束。上层仍须执行 RK stop 并验证其回执。关闭进程不代表 USB 已停止，历史上已发送的输入也不会因此撤销。

每个任务使用独立 Harness home。持久 Session 由官方 JSONL 后端和 checkpoint 插件保存，模型请求与顶层工具调用在派发前经过 checkpoint。宿主额外保存 fsync 后的工具意图、调用编号和结果；同一调用编号再次到达时返回已有结果或拒绝，不重复执行。强杀发生在外部动作完成但结果落盘之前时仍可能留下未知结果，不承诺外部动作恰好执行一次。

恢复必须传入相同任务编号、原 home 和 `resume: true`。已有会话不会被普通启动静默重用。若宿主 queued checkpoint 已保存，但运行时在创建 SDK 会话之前失败，适配器仅在 owner marker 缺失且宿主日志与 sessions 目录均无持久内容时，允许同一 UUID 首次创建。已有日志、会话内容或符号链接均不能据此降级成新会话。恢复只重建会话历史，不恢复窗口、浏览器进程、RK观察编号、焦点或用户问题等待句柄；上层须重新取得当前观察与任务授权。

2026-11-05 迭代：owner marker 还保存模型路由摘要，覆盖 provider、model、baseURL（忽略末尾斜杠）、工具协议和自定义 headers；不保存 API Key 或端点明文。恢复在读取工具账本、调和未知操作、启动 SDK 之前校验任务身份、运行时版本和路由。更换端点、模型、协议或 headers 会以 `HARNESS_SESSION_ROUTE_MISMATCH` 拒绝，不能把本地历史继承给云端；同路由仅轮换 model.apiKey 可恢复。构造时复制模型配置，后续调用方修改原对象不改变活动路线。

旧 marker 缺少路由绑定时返回 `HARNESS_SESSION_ROUTE_UNBOUND`，保留原文件，不自动认定当前路由就是原路由。损坏或身份不符返回 `HARNESS_SESSION_OWNER_INVALID`。本轮没有为旧会话自动迁移或删除历史。该绑定限制应用内的意外跨路由恢复，不是抵御能够修改本机文件或传输实现的管理员的加密措施。

边界收紧例外：由宿主依据实际模型路由传入 `historyBoundary: local | remote`（默认 remote），并保存到 marker。remote → local 可用于原有云端失败后的 RK 回退，进入调和/SDK 之前同步写入 local 标记；local → remote 永远拒绝，即使目标是之前用过的云端。remote → 不同 remote 仍拒绝。旧 marker 缺少边界同样拒绝自动恢复。不能靠看似本地的 URL 或 `prompt_engineering` 参数声明本地信任。

无结果或失败的宿主调用默认阻断恢复。可由宿主提供 `reconcileUnknown(intent)`：

- 返回 `{kind: 'verified', result}`：宿主已独立核对外部效果，记录核对结果后继续。
- 返回 `{kind: 'retry_read_only'}`：宿主确认该准确调用只读或仅等待，记录中断后允许模型重新发出新调用；不重新执行旧编号。
- 返回 `undefined`：继续阻断。写文件、输入、发送、上传和保存记忆不能仅因进程重启而归为只读。

完成门控位于官方 `agent/turn-stopping` 扩展点。模型给出最终答案但宿主尚无完成证据时，插件将缺少证据的信息投入当前 Agent 的下一步；没有另一个宿主推理循环。

## 打包

打包保留 `resources/harness`，将其绝对路径作为 `runtimeResources`，把应用用户数据下专用目录作为 `home`。`nodePath` 指向随包分发的 `resources/runtime/node/node.exe`；开发态 Electron 使用 `.cache/node-runtime/node.exe`。普通 Node 测试默认使用 `process.execPath`。Node 版本应与安装时验证的标准 Node 24 一致。不能直接使用 Electron 45.1.0 加 `ELECTRON_RUN_AS_NODE=1` 运行 Harness：rc.5 的上游原生模块拦截器不支持该 Electron V8 指纹，实测启动失败。

SDK rc.5 的公开类型没有可执行文件选项。适配器使用该发布包实际提供、上游自身测试也使用的构造器注入点：`DeepSeekHarness(options, clientFactory)` 与 `HarnessClient(options, runtimeOptions)`。启动前检查 SDK 和 CLI 都精确等于 `0.2.1-rc.5`；不匹配直接拒绝。官方客户端仍直接拥有唯一 Node 子进程、协议、关闭升级与退出确认，没有中转启动器。此注入点不是稳定公共 API，升级上游必须重新检查实现并执行集成测试。

外部 Node 无法读取 Electron ASAR 虚拟路径，因此当前打包使用 `asar: false`，让 CLI、profile 加载器与原生依赖均位于真实文件路径。插件依赖使用宿主 `require.resolve` 得到的绝对文件 URL，不依赖额外资源目录的裸模块解析。子进程不继承 `ELECTRON_RUN_AS_NODE`。

安装包的原生依赖和官方 profile 解析仍需以打包程序单独验收；开发目录集成成功不等同安装包通过。

## 验证

`tests/harness-runtime.test.ts` 启动真实安装的官方 SDK 子进程，以隔离 HTTP/SSE 模型服务验证精确版本、工具闭环、RK文本协议、完成门控、非法工具/参数拒绝、实际请求预算、截断不算完成、取消等待工具收束、显式历史恢复、未知结果阻断与只读恢复、自动压缩同一宿主传输和 DeepSeek reasoning 历史回传。`tests/harness-local-budget.test.ts` 从实际 `TarsAgentService` 获取完整按组可见工具配置，经真实 Harness 和 `createRkTarsFetch` 检查 RK 提示字节加 1152 预留后仍小于 8000。

2026-11-05 独立 smoke 使用 Electron 45.1.0 宿主、标准 Node 24.14.0 子进程和真实 SDK，通过两次合成 HTTP/SSE 模型请求完成一次宿主工具调用，退出后无残留 Harness 进程。可复用 `tests/harness-electron-smoke.mjs`，通过 `COLOOP_HARNESS_SMOKE_MODULE` 指向临时编译后的运行层、`COLOOP_HARNESS_NODE` 指定标准 Node、`COLOOP_HARNESS_SMOKE_REPORT` 指定报告路径。这些测试不调用真实模型、不发送 USB 输入，不能作为实机任务或最终安装包验收。

上游依据：[SDK](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sdk/client/README.md)、[工具契约](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cookbook/adding-a-tool.md)、[checkpoint](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/session/session-checkpoint-policy/README.md)。
