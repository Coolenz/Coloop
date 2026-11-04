# Coloop 与 RK 协调开发（2026-10-29）

本文保留0.8.0协调通道的历史验收；0.9.0原生Hook、默认终端SDK、隔离上下文和RK快审性能见 [2026-10-30专题](18-coloop-hooks.md)。

Coloop 0.8.0 增加独立的 Agent 协调通道：待处理权限或问题，经本机规则筛选后交给板端 Qwen3.5-4B 分析，适配器复查原请求后回复现有选项。目前覆盖明确的安全单项选择和权限拒绝；读取许可只给建议，不会自动把文件内容授权给数据去向尚未验收的主 Agent。

源码分别在 `D:\Coloop`、本项目 `tools/coloop_agent.py`、独立子仓库 `rk-opencode/bridge/server.py`。`D:\Coloop-GitHub` 是独立发布聚合副本，本次未复制或推送改动到那里。

## 使用

启动 `D:\Coloop\start.cmd`，设备管理连接 RK，确认模型服务和审批隐私能力就绪，再打开「Agent 协调」。服务在本机随机回环端口监听。会话令牌位于 `%APPDATA%\coloop\agent-coordinator\connection.json`，目录 ACL 只允许当前 Windows 用户；界面不接收令牌，退出删除文件，重启更换令牌。测试使用独立目录。

对于已有本机 OpenCode 1.19.5 服务：

```powershell
# 4096是OpenCode事件服务，8088是RK模型桥，不能互换。
.\.venv\Scripts\python.exe tools/coloop_agent.py opencode --url http://127.0.0.1:4096 --directory D:\RK
```

`--connection FILE` 指定隔离连接文件；`--once` 最多处理一条新请求。Basic 鉴权通过当前进程 `RK_OPENCODE_USERNAME` / `RK_OPENCODE_PASSWORD` 传入。仅允许数字回环 HTTP 地址，禁用代理、重定向和 URL 凭据。

通过固定指纹 SSH 隧道接入板端 OpenCode 时，`--directory` 为板端目录，`--workspace D:\RK` 为本机策略范围。映射不授予读取权，不证明主 Agent 的数据去向。OpenCode 本身的服务启动和模型配置仍由原工程管理。

其他 Agent 可调用：

```powershell
.\.venv\Scripts\python.exe tools/coloop_agent.py review --event tmp/review-event.json
```

该命令只返回评审建议，不执行动作。完整 API 与示例见 [Coloop 协议说明](../../Coloop/docs/agent-coordination.md)。Codex 桌面原生审批尚未接入，不能把启动服务表述为接管了所有 Agent。

## 隐私与授权

- 原始事件只送本机鉴权回环接口。RK 收到缩减的动作类别、文件数量/扩展名或安全选项 ID/类型，不接收源码正文、原题干与完整路径。不调用云模型、Mem0 召回或写入。
- 仅扫描可信工作区内明确存在的源码，固定大小上限，拒绝敏感路径、检测到的凭据/个人信息、通配目录与未知命令。规则不能证明任意源码无隐私，也不能控制外部 Agent 后续的读取与传输。
- OpenCode 适配器的全部 `allow` 保持待处理，原因 `UNVERIFIED_AGENT_DATA_ROUTE`。实际回复限原权限 `reject`、问题 `reject` 或已有安全标签 `answers`。未知 metadata 保持等待，不丢字段后冒充安全请求。
- 请求绑定 session、request ID、事件 SHA256 和期限。回复前重新获取并比较原 pending 全对象，回复后确认该项消失。变更/过期/格式错误/范围不明不放行；忙碌等临时状态在原 180 秒期限内重试，不刷新期限。
- 本机审计只存哈希、类别、结果、来源、原因码、耗时与时间，不进入普通任务历史。哈希仍可能用于关联，不等于匿名化或物理擦除。
- “选中离线”仅代表回复原标签，不能证明上游实际离线或业务动作完成。题干与标签语义反转等情况需要额外的受信执行器验收。

## 板端日志保护

`bridge/server.py` 对 `X-RK-Privacy: metadata-only` 请求只记录固定白名单元数据，响应确认同名头。`/health` 声明 `privacy_metadata_only: true` 后 Coloop 才发审批分析；缺少能力的旧服务不接审批。

默认 `--worker-log-mode metadata-only` 丢弃厂商诊断 stderr，保留协议 stdout。显式 `raw` 用于非私密调试，同时关闭隐私能力并拒绝私密请求。普通聊天 HTTP 记录保留既有行为，不能声称所有 RK 记录均已脱敏。旧日志、其他 Agent 会话记录和备份未清理。

本次只备份更新板端桥接源码并正常重启；模型、Runtime、Header、HID 与系统配置未变。回退文件及 SHA256 见 `logs/coloop-coordination-20261029-225344/privacy-deployment.json`。先停止服务、恢复备份、再用原启动器启动可回退；回退后 Coloop 会因缺少隐私能力拒绝模型审批分析。

## 验证

Coloop TypeScript/构建和 97 项单元测试通过；Python 适配器 22 项本地 HTTP 测试、板端子仓库 60 项单元测试通过。假服务只证明协议，不等于真实 Agent 任务完成。

- `logs/coloop-coordination-20261029-225344/`：实机预检、最小部署及真实 NPU 随机串。随机串精确回显，三个日志新增字节中均未出现验证串；worker/bridge 日志无新增，推理约 4.686 秒。
- `D:\Coloop\.qa\coordination-1793286374262/results.json`：真实 Electron、固定指纹 SSH、实际 NPU、安全选项选择和 Python 适配器闭环；该轮 OpenCode pending API 为模拟测试服务，包含双尺寸截图和独立审计。
- `logs/coloop-real-opencode-1793287042732/summary.json`：随后真实 OpenCode 1.19.5 会话、真实 NPU 产生 question pending，Coloop/RK选中原有离线标签，适配器一次reply被接受，question工具completed、pending消失、最终回答确认选择；已清理自有session/临时进程并释放调度标记。仅合成数据/仅question工具，模型服务新增3条记录均metadata-only。对应真实Electron结果为 `D:\Coloop\.qa\coordination-1793287026119/results.json`。
- 首轮真实模型合法返回 `defer`，未强行选择；明确离线优先提示后的新一轮通过。失败轮隔离审计保留，不作为通过结果。
- 0.8.0已打包；同包unpacked程序启动、鉴权、页面和退出清理通过（无额外NPU）。源码/产物SHA256与证据索引见真实OpenCode实验目录的 `run-manifest.json`。portable包装器不能直接接Playwright Electron调试管道，自动化使用 `release/win-unpacked/Coloop.exe`。

```powershell
.\.venv\Scripts\python.exe -m unittest discover -s tools/tests -p test_coloop_agent.py -v
.\.venv\Scripts\python.exe -m unittest discover -s rk-opencode/tests -v
# 从D:\Coloop运行 npm.cmd test / npm.cmd run test:coordination
# 后者仅在COLOOP_TEST_BOARD_PASSWORD进程变量存在时增加真实NPU验证。
```

参考 [Violoop 官方机制说明](https://violoop.ai/blog/ai-that-reads-your-screen/) 与 [隐私政策](https://violoop.ai/privacy/)。这里实现软件策略约束的自动回复，没有复现独立 MCU 或物理按键闸门。
