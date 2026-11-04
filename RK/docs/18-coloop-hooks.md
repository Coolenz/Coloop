# Coloop 原生 Agent Hook 与 RK 快审（2026-10-30）

Coloop 0.9.0 在既有协调通道上增加 OpenCode 原生插件：消息、工具执行、状态和审批直接上报，不依赖 OCR。源码在 `D:\Coloop` 和本项目独立子仓库 `rk-opencode`；`D:\Coloop-GitHub` 未同步或推送。

## 开源方案与入口

采用固定的 OpenCode **1.19.5 / MIT** 插件与 SDK，参考提交 [`810c0eba1a7348036f8bdf61e6632d0c36c6876c`](https://github.com/anomalyco/opencode/tree/810c0eba1a7348036f8bdf61e6632d0c36c6876c)。参考 HumanLayer / Apache-2.0 的会话镜像设计，固定提交 [`316e74ef9af0b7b3d64ac45b5eb93415b3ed2204`](https://github.com/humanlayer/humanlayer/tree/316e74ef9af0b7b3d64ac45b5eb93415b3ed2204)，未安装或打包其面向 OpenCode 2.x 的运行库。没有升级现有 OpenCode、SDK、模型或运行库。

启动 Coloop，设备管理导入本项目配置并连接 RK；「Agent 协调」显示反向 Hook 通道及实际事件。连接成功会将本地 `rk-opencode/plugins/coloop-hook.mjs` 和 `scripts/coloop-opencode.sh` 备份上传到应用目录，建立板端回环至上位机鉴权回环的 SSH 转发，并生成私有 `0600` 连接文件。随后在板端运行：

```bash
bash "$HOME/rk-opencode/scripts/coloop-opencode.sh"
```

自定义服务目录时使用界面给出的完整启动路径。正常启动保留原有 profile 和记忆插件；连接断开后重新连接需要重启该 Hook 会话，旧进程不会自动换令牌。UI 的通道就绪仅说明转发已建立，实际事件计数才证明来源已接入。仅关闭/清理当前连接自己的转发、连接文件与前台活动记录。

默认终端界面没有独立 HTTP 监听端口。插件通过 OpenCode 注入的 SDK core 保留原有进程内 fetch、鉴权和目录上下文，重新读取/回复原 pending；不回退连接 `localhost:4096`。缺少兼容 SDK core 时插件停止工作。外部 `serve` 模式使用同一 SDK 路径。

## 内容、上下文与审批

- 原生捕获消息正文、工具执行前后、状态、压缩/关闭及 question/permission 通知。源文本先过滤已知秘密、限制为约2KiB并标记截断；不是完整工具审计，也不采集 reasoning part。
- 源观察的待发与在途合计最多128条/256KiB、单 scope 64KiB；跨批次合并未发送的同一正文更新。超限停止使用该上下文审批并记录固定原因。最多64个来源会话，仅回收无排队/在途/审批的空闲会话；全忙时明确报告容量不足。
- 上位机按来源、进程实例、会话和任务隔离，单 scope 最多16条/8KiB，全局内容预算256KiB、最多32个 scope、空闲五分钟释放。压缩使旧审批失效，关闭任务不能由迟到事件复活。
- RK 最多收到192 UTF-8字节的近期概况。短正文整条保留；长正文用明确的省略标记，不通过截断路径或否定条件制造完整语义。投影、代次及当前审批绑定到不可变 contextRef。
- 每次审批绑定完整原 pending 的规范 JSON SHA256、原 session/request ID、来源及180秒期限。重复通知不续期。模型输出只接受限定整数索引，映射回本次真实选项。回写前再次查询原 pending 并比较完整摘要，回写后确认消费；歧义网络失败不重发动作 POST。
- 目前自动回复既有安全单选标签或权限拒绝。所有权限 allow 保持 pending：`UNVERIFIED_AGENT_DATA_ROUTE`。不发永久授权。未知、多选、多题、变更/过期、模型暂缓或错误格式不自动放行。Codex 桌面原生审批尚未接入。

事件通知不是阻塞审批 hook；真正等待由 OpenCode 的 pending / Deferred 完成。上游权限 reject 可能连带拒绝同会话其他等待项。选择离线标签只证明原标签被回复，不能证明上游任意工具真的离线。

## 记忆与隐私

Hook 接收只更新有界内存，不调用 Mem0 recall/enqueue/set，不把工具文本或模型自述升级为长期事实。活跃任务登记自己的前台租约，候选进入模型前等待正在进行的一次维护结束；idle/关闭/断连释放。保留既有120秒空闲维护和不可抢占的一次整理，因此忙碌时可能额外等待。

**普通启动仍保留 MemoryPlugin。**正常用户聊天继续按原规则召回、排队与维护，不能把 Hook 不写记忆扩展成整场会话不保存文本。性能基准使用独立配置，仅 question 工具及 Hook 插件，禁用自动记忆，检查前后事实、摘要和队列计数。

模型请求使用 `X-RK-Privacy: metadata-only` 并核对健康能力和响应头。Hook 正文不写普通 Coloop 任务历史；审计保留摘要、原因码与耗时。OpenCode 自身的会话库、其他插件和错误日志仍可能保存源内容，历史备份没有清理；过滤规则不能证明任意文本没有秘密。

## 验收口径

固定目标为普通事件100条 P95≤100ms、规则拒绝10条 P95≤150ms、真实原生审批20条 P95≤3500ms（另列一次预热）。审批计时从源插件观察原生请求到源 pending 确认被消费，使用源进程单调时钟；板端与 Windows 的墙钟存在偏差，禁止相减。nearest-rank 百分位；任何错误、暂缓、超时、未消费或样本不足使正式验收失败。

模型热服务使用 Qwen3.5-4B / 16K / Runtime1.3.0；快审输出上限16 token、关闭 KV 缓存。主 Agent 与审批共享一个 worker/KV槽，审批可能使主任务下一轮冷建。记录预填充、新增 token 和任务总耗时，不以缓存 token 冒充速度。未换权重、运行库、内核或 HID。

```powershell
# 从 D:\Coloop 执行
npm.cmd test
npm.cmd run test:hooks
# 从 D:\RK 执行
.\.venv\Scripts\python.exe -m unittest discover -s tools/tests -p test_hook_benchmark.py -v
C:\nodejs\node.exe --test rk-opencode/tests/test_coloop_hook.mjs
.\.venv\Scripts\python.exe tools/bench_coloop_hook_transport.py --connection PRIVATE_FILE --output-dir NEW_LOG_DIR --samples 20 --hook-samples 100 --timeout 1200
```

`--pilot` 仅是功能试跑，不能成为正式性能通过；整个实验1200秒预算与单次推理限制分别记录。板端密码只经当前进程环境提供。每次保留输入/配置/插件摘要、实际原生工具及 pending 消费证据、资源温度、元数据日志检查和自有进程清理结果。

## 本次验收结果

**Hook＋真实 RK 审批性能达标。** 正式证据为 `logs/coloop-hooks-benchmark-1793296894702/summary.json`，打包程序联调为 `D:\Coloop\.qa\hooks-1793296891877/results.json`。源端使用明确标记 `source_model_scripted=true` 的受控 OpenAI 兼容测试服务：只按本次用户参数发出 question 调用，再原样回显真实工具结果。OpenCode 1.19.5、native pending、生产 Hook、RK NPU 判断、原摘要核验和 SDK 消费全部真实。测试服务不参与审批，不注入预期离线选项；这不是20次模型开发任务成功率。

| 指标 | 样本与实际结果 | 目标 |
| --- | --- | --- |
| 结构化事件接收，本机回环往返 | 100条；P95 **22.200ms**，最大28.901ms | ≤100ms |
| 明确规则拒绝往返 | 10条；P95/最大 **28.279ms** | ≤150ms |
| 原生审批产生→源 pending 确认消费 | 20条；P50 **2877.321ms**，P95 **3008.326ms**，最大3029.731ms | P95≤3500ms |
| 完整受控源任务 | P95 3331.521ms，最大3334.848ms | 单列，不冒充主模型开发速度 |

20/20成功、0失败，原事件与摘要回执绑定全部通过，选项位置交替。另列预热一次3124.880ms；模型在实验前已经就绪，这不是模型冷启动。21次真实 RK 请求全部为 metadata-only，worker日志新增0字节；受控源42次请求、21次发题与21次真实结果回显，0拒绝。Mem0事实/版本/摘要/队列计数前后未变。每个样本均有消息、状态、工具前后、审批和关闭六类原生事件。

独立真实能力证据为 `logs/coloop-internal-hook-1793295194567/summary.json`：隔离的 question-only 配置、stock `--mini` 终端模式、真实 Qwen 主 Agent 和 RK 审批，**不含受控源或阶段 fixture**。第二位置的离线选项被正确消费，工具完成且最终文本精确匹配；审批2957.743ms，整任务53.047秒，3次模型请求均私密，源进程无TCP监听。对应打包程序结果 `D:\Coloop\.qa\hooks-1793295190991/results.json`。这证明进程内 SDK 路径的实际能力，不代表任意开发任务均可靠。

自有会话、进程组、活动租约与临时连接文件均已清理。最终只读板端核验 `final-board-check.json` 为通过，0残留测试进程，部署插件与本地SHA256一致。源码/SDK锁/产物/测试fixture摘要见 `run-manifest.json`；完整合成输入、逐样本结果和原生回执分文件保留。

Coloop144项单元测试、插件36项、benchmark16项、受控源HTTP/SSE9项、进程内smoke验收器5项、旧适配器22项及子仓库60项测试通过；类型、构建、相关Ruff/语法/格式检查通过。通用Electron的导航、DPAPI、协议、取消、真实RapidOCR、截图和历史导出回归通过。关闭/SSH竞态与容量边界由本机测试覆盖，五分钟TTL使用假时钟验证，不冒充已经走过完整硬件寿命测试。

Windows产物 `D:\Coloop\release\Coloop-0.9.0-Windows-x64.exe`，112780740字节，SHA256 `efecae01552bd94a7313fd40851bc92ca68ae768578e8dfcf9c527291b0b23ba`。真实联调使用同包 `release/win-unpacked/Coloop.exe`；portable用于普通启动。

## 保留的失败与限制

- 大投影试跑 `logs/coloop-hooks-benchmark-1793292103613/` 功能通过但约4.8–5.0秒未达标；192字节初版 `1793292849922/` 及反转选项试跑 `1793293414781/` 出现模型暂缓，未计成功。
- 全NPU发题端的 `1793295293416/` 与阶段提示版 `1793295660254/` 在主模型生成审批前返回422。独立诊断 `logs/coloop-source-json-diagnostic-1793296283889/` 确认主模型嵌套JSON括号错序，严格拒绝正确；没有自动修补调用。该诊断仅一条固定合成请求，**显式不采用metadata-only**以读取原始错误，不属于正式性能/隐私通过样本，不能宣称所有历史日志均私密。
- `1793294837779/` 的首次mini验收器错误地要求桥接解包后的文本是JSON，并丢失日志中的回执摘要；修正验收器后独立新实验通过。受控源首次 `1793296725884/` 暴露验收器在异步消费回执送达前就取样的竞态；改为同时等待业务完成、idle和消费回执，保留全部原成功条件，之后试跑及正式测量通过。
- 控制源只隔离发题模型的格式质量；生产插件、审批阈值和安全规则未为通过测试而放宽。原全NPU端到端脚本 `tools/bench_coloop_hooks.py` 保留，用于另行评估主模型任务质量。受控源成绩不能外推为复杂读写、任意应用、繁忙NPU或记忆维护期间的延迟保证。

完整协议、参数与安全边界见 [Coloop 原生 Hook 说明](../../Coloop/docs/native-agent-hooks.md)，旧轮询适配器及0.8.0历史记录见 [协调开发](17-coloop-coordination.md)。
