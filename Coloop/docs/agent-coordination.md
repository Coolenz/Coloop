# Coloop 0.8.0：RK 与开发 Agent 协调

本文对应 2026-10-29 的本地源码。Coloop 接收 Agent 已经产生的权限请求或单项问题，先执行本机隐私规则，再让 RK 给出受约束的判断。判断界面位于「Agent 协调」。这条链路不调用云端模型，不自动回退云端。

当前通用 API 返回建议，不执行命令或桌面动作。OpenCode 适配器可以回复明确的拒绝和受限安全选项；所有权限 `allow` 仍保持原请求等待。Codex 桌面的原生审批尚未接入，也没有通过截图识别或模拟点击接管审批窗口。

## 数据与执行路径

```text
开发 Agent 的既有 pending 请求
  → 本机 Python 适配器：固定事件、保留原请求摘要
  → Coloop 回环鉴权 HTTP
  → 可信工作区、路径与隐私规则
  → 固定指纹 SSH → RK 回环模型服务 → Qwen3.5-4B
  → 严格解析 JSON、校验选择范围、请求哈希与有效期
  → 适配器重新读取原 pending 请求
  → 仅向同一请求回复拒绝或安全选项
  → 再查询 pending，确认本次回复已被消费
```

文件正文只在本机作有限规则扫描，不进入 RK 提示。权限候选提示只含工具名、文件数量、扩展名与范围类别；问题候选提示只含原选项 ID 和本地规则生成的 `offline` / `skip` 类别，不包含原题干、选项正文或路径。模型不能自行扩大候选范围。

协调直接调用 `BoardGateway.review()`，不创建普通文字任务，不写入普通任务历史，也不读取、召回或写入 Mem0 内容。既有前台活动登记仍会避让正在进行的记忆维护。RK 请求设置 `tools: []`、`tool_choice: 'none'`、`stream: false`、`X-RK-Cache: off`，审批输出上限为 128 tokens。

板端 `/health` 必须声明 `privacy_metadata_only: true`，每次审批请求携带并检查 `X-RK-Privacy: metadata-only` 回执。缺少能力或回执时不使用该回答。板端对应实现抑制审批正文、模型正文和可能反射原文的错误日志，厂商 worker 诊断默认不落盘；显式 raw 调试模式不接受私密审批。部署和原始验证记录见 RK 子项目，不能仅凭本机源码存在认定另一台板已启用此能力。

## 本机服务与临时凭据

应用主进程启动协调服务，固定绑定 `127.0.0.1`，端口由操作系统随机分配。它与 RK 模型的 `8088` 端口、OpenCode 服务示例的 `4096` 端口是三个独立接口。

每次应用运行生成 32 个随机字节的令牌，以 64 位十六进制字符串写入：

```text
%APPDATA%\coloop\agent-coordinator\connection.json
```

文件内容只有 `url` 和 `token`。主进程先关闭凭据目录的 ACL 继承，只授予当前 Windows 用户 SID 权限，再通过临时文件原子替换连接文件；该文件本身没有使用 DPAPI 加密。界面和快照只得到连接文件路径及服务地址，不获得令牌。相同用户权限下的其他进程仍属于信任边界，ACL 不构成独立硬件或进程隔离。

正常退出时只删除属于本次令牌的连接文件，同时关闭监听并取消等待。异常退出可能留下旧文件；已停止的服务不能再用旧凭据认证，重启会使用新令牌。设置 `COLOOP_DATA_DIR` 的隔离运行改用该资料目录下的 `agent-coordinator/connection.json`，适配器应显式传入 `--connection`。不要把连接文件加入源码、截图或报告。

服务启动或 ACL 设置失败会显示协调错误，不继续使用不受保护的连接文件。

## HTTP 协议 v1

两个接口都要求 `Authorization: Bearer <本次令牌>`。令牌经固定长度摘要后使用时序安全比较。带 `Origin` 或 `Sec-Fetch-Site` 的请求被拒绝，不提供浏览器跨域访问。响应设置 `Cache-Control: no-store`，错误只返回固定原因码。

| 请求              | 结果                                                    |
| ----------------- | ------------------------------------------------------- |
| `GET /health`     | `{ "version": 1, "ready": true, "busy": false }`        |
| `POST /v1/review` | `Content-Type: application/json`；返回下面的 `Decision` |

`/health` 的 `ready` 表示协调服务可接收请求，不单独证明 RK 模型就绪。POST 请求体上限为 **32768 字节**，拒绝压缩正文；读取正文限时 5 秒。没有通用 shell、文件写入、鼠标键盘或远程 URL 代理接口。

### ReviewEvent

对象严格拒绝表外字段，未提供的可选字段应省略，不发送 `null`。

| 字段                     | 类型与边界                                                                     |
| ------------------------ | ------------------------------------------------------------------------------ |
| `version`                | 必填整数 `1`                                                                   |
| `id`、`sessionId`        | 必填字符串，1–128 字符，匹配 `[A-Za-z0-9._:-]+`                                |
| `kind`                   | 必填 `permission` 或 `question`                                                |
| `workspace`              | 必填已存在的绝对目录路径，1–1024 字符；须通过可信根校验                        |
| `tool`                   | 可选字符串，1–80 字符；权限事件需要                                            |
| `patterns`               | 可选数组，1–20 个字符串，每个 1–1024 字符；权限事件需要明确绝对文件路径        |
| `command`                | 可选字符串，最多 8000 字符；当前策略对含该字段的权限事件一律拒绝，包括空字符串 |
| `question`               | 可选字符串，1–4000 字符；问题事件需要                                          |
| `choices`                | 可选数组，1–20 项；问题事件需要，ID 不得重复                                   |
| `choices[].id`           | 必填字符串，1–64 字符，匹配 `[A-Za-z0-9_-]+`                                   |
| `choices[].label`        | 必填字符串，1–200 字符                                                         |
| `choices[].description`  | 可选字符串，最多 800 字符                                                      |
| `createdAt`、`expiresAt` | 必填带时区的 ISO 8601 时间字符串                                               |

`permission` 不得混入 `question` / `choices`；`question` 不得混入 `tool` / `patterns` / `command`。下面的对象展示字段形状，时间必须在实际提交前生成：

```json
{
  "version": 1,
  "id": "request-001",
  "sessionId": "session-001",
  "kind": "question",
  "workspace": "D:\\RK",
  "question": "选择资料处理方式",
  "choices": [
    { "id": "offline", "label": "仅在本地离线分析，不上传任何数据" },
    { "id": "skip", "label": "取消本次操作并保持当前状态" }
  ],
  "createdAt": "2026-10-29T14:00:00.000Z",
  "expiresAt": "2026-10-29T14:03:00.000Z"
}
```

### Decision

```typescript
type Decision = {
  version: 1
  id: string // 与原事件完全一致
  sessionId: string // 与原事件完全一致
  requestHash: string // 64 位小写十六进制 SHA256
  decision: 'allow' | 'deny' | 'select' | 'defer'
  choiceId?: string // 当且仅当 decision 为 select，且为原候选 ID
  reasonCode: string // [A-Z][A-Z0-9_]{0,79}
  source: 'policy' | 'rk'
  expiresAt: string // 原事件到期时间，不延期
}
```

`allow` 是一次受约束的读取建议；`deny` 是拒绝建议；`select` 是原候选中的一个选择；`defer` 保留等待。HTTP 200、合法 JSON 或 `source: rk` 都不代表原业务已经执行或完成。

### 哈希、到期与重试

`requestHash` 对完整事件递归按对象键排序，数组顺序不变，使用紧凑 JSON、UTF-8 与 SHA256。Python 等价序列化为：

```python
json.dumps(event, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
```

ID、会话、选项顺序、正文和时间均参与绑定。客户端必须核对 `id`、`sessionId`、`requestHash`、`expiresAt` 和当前时间；只验证某个字段不足以允许回复。相同 `id + sessionId` 在账本内出现不同事件摘要返回 HTTP 409 `REQUEST_CONFLICT`。

服务允许的最长事件寿命为 **300 秒**，`expiresAt` 必须晚于 `createdAt`，创建时间不能比服务当前时间超前超过 30 秒。模型等待最多 90 秒，且不得超过事件剩余寿命；迟到或到期回答不能成为可用的 `allow` / `select`。即使底层忽略取消，也会保留进行中槽直到其实际结束，避免启动第二次并发分析。

账本最多 1000 项，终态决定及规则产生的不确定结果按原事件缓存，避免重放重复触发 NPU。仅 `MODEL_BUSY`、`REQUEST_IN_PROGRESS`、`REVIEW_UNAVAILABLE`、`REVIEW_TIMEOUT` 四类暂时失败允许在原事件剩余有效期内重试，事件和哈希保持不变，不延长时间；正在进行的相同请求立即返回等待，不排队。审计写入失败也不会放行。

## 本地策略与隐私边界

可信根由主进程从保存的设置派生：`ocrWorkspace` 与 `join(ocrWorkspace, '..', 'Coloop')`。例如 `ocrWorkspace=D:\RK` 时是 `D:\RK` 和 `D:\Coloop`。请求自称的工作目录不能扩充这组根；目录需存在，`realpath` 后必须在某个可信根内。没有配置根时拒绝放行。

权限候选严格限于 `read` / `glob` / `grep` / `list`，但每个目标仍必须是可信工作区内的明确普通源码文件。目录、通配、父目录遍历、符号链接逃逸、未知扩展名、二进制和命令不自动通过。`.env*`、`.ssh`、凭据路径、`AGENTS.md`、`config/board.json` 等被拦截；正文规则检测部分 Key、密码赋值、私钥、邮箱、手机号和身份证格式。

每个文件扫描预算为 256 KiB，通过固定文件描述符最多读取 256 KiB + 1 字节，并前后复核文件身份、大小、修改时间与真实路径。模型建议允许时再做一次校验。超过预算、文件变化、路径不可用或模型输出不合规都不能产生可用许可。模型回答必须是规定的 JSON，额外字段、Markdown、重复键和不存在的选择 ID 均被拒绝。

这仍是有限检测：其他编码、未覆盖的凭据形式、业务私密信息及语义性个人信息可能漏检。校验与上游真正执行间仍有 TOCTOU 窗口，适配器没有锁住文件或约束上游整个执行器；哈希绑定事件，不绑定原始文件内容。读取被建议允许，也不能证明主 Agent 不会随后把文件送入云端、插件或代理。因此当前自动接入不把这些规则当作 DLP 保证。

问题选项仅识别代码中列明的完整安全语句及对应英文句，典型中文为：

- `仅在本地离线分析，不上传任何数据` / `只在本机离线处理，不向外部发送数据`。
- `取消本次操作并保持当前状态` / `跳过本次操作并保持当前状态` / `保持当前状态，不执行任何操作`。

标签与非空描述拼接后必须整体匹配，不能在安全句后附加上传、删除等行为。只有「本地」「否」「继续」等短标签会保留等待。固定选择策略是优先 `offline`，其次 `skip`，同类首项；选择仍由 RK 实际输出并通过范围验证。适配器不能为上游补造这些选项。

选中「本机离线」只能证明回复了该标签，不能证明上游业务真实保持离线。恶意题干、被改写的选项语义或不可信执行器仍需另外处理与验收。

## 使用 Python 适配器

先启动 Coloop，在设备管理连接并确认 RK 与审批日志保护均已就绪。以下使用 RK 的独立 Windows 解释器，不依赖当前终端激活状态。

### 通用建议接口

下面生成一个新的、180 秒有效的安全问题事件。`review` 只打印建议 JSON，不执行该建议：

```powershell
Set-Location D:\RK
$reviewTime = [DateTimeOffset]::UtcNow
$reviewEvent = @{
    version = 1
    id = [guid]::NewGuid().ToString()
    sessionId = 'manual-session'
    kind = 'question'
    workspace = 'D:\RK'
    question = '选择资料处理方式'
    choices = @(
        @{ id = 'offline'; label = '仅在本地离线分析，不上传任何数据' }
        @{ id = 'skip'; label = '取消本次操作并保持当前状态' }
    )
    createdAt = $reviewTime.ToString('o')
    expiresAt = $reviewTime.AddSeconds(180).ToString('o')
}
$reviewEventPath = Join-Path $env:TEMP ('coloop-review-' + $reviewEvent.id + '.json')
[IO.File]::WriteAllText($reviewEventPath, ($reviewEvent | ConvertTo-Json -Depth 10), [Text.UTF8Encoding]::new($false))
& D:\RK\.venv\Scripts\python.exe D:\RK\tools\coloop_agent.py review --event $reviewEventPath
```

隔离资料目录可在命令后加 `--connection C:\绝对路径\agent-coordinator\connection.json`。CLI 使用回环地址、禁用环境代理与重定向，并校验返回决定和原事件绑定。退出码 0 代表命令取得了合法建议，不表示建议为允许或业务完成。

### OpenCode 待处理请求

适配器连接已经运行的 OpenCode 1.19.5 兼容服务，不自行启动 Agent 或 RK 模型：

```powershell
& D:\RK\.venv\Scripts\python.exe D:\RK\tools\coloop_agent.py opencode --url http://127.0.0.1:4096 --directory D:\RK
```

加 `--once` 只进行一轮、最多处理一个新请求，便于检查；持续模式每 2 秒轮询。`--directory` 为要绑定的真实项目绝对目录。若 OpenCode 要求 HTTP Basic 鉴权，通过当前进程的 `RK_OPENCODE_USERNAME` / `RK_OPENCODE_PASSWORD` 传入，不把密码写入命令 URL。部署在板端的 OpenCode 需已有受控的本机回环转发，CLI 不接受非回环目标。RK `8088` 模型桥不是 OpenCode pending 服务。

适配器使用固定版本 SDK 已核对的接口：

| 作用             | OpenCode 接口                                                      |
| ---------------- | ------------------------------------------------------------------ |
| 获取待处理       | `GET /permission?directory=...`、`GET /question?directory=...`     |
| 明确拒绝权限     | `POST /permission/{requestID}/reply`，`{"reply":"reject"}`         |
| 回复一个既有选项 | `POST /question/{requestID}/reply`，`{"answers":[["原选项标签"]]}` |
| 拒绝问题         | `POST /question/{requestID}/reject`                                |

OpenCode 的 `sessionID` 映射为事件 `sessionId`，问题选项用原数组索引的字符串作为 ID；不合并多个问题，不自动回答多选，也不接受重复标签。未知权限 metadata 保留等待并报告 `UNKNOWN_PERMISSION_METADATA`，避免丢字段后审批了不同操作。

所有权限 `allow` 均保持 pending，原因 `UNVERIFIED_AGENT_DATA_ROUTE`；当前不发送 `once` 或 `always`。模型名、服务商名或配置字符串不能证明主 Agent 的文件内容实际留在本地。`deny` 和受限安全 `select` 才会在重新查询并比对原 pending 摘要、再次校验有效期后回写；随后查询确认该请求已消失。回复失败不盲目重复 POST。

每个首次观察到的请求只生成一次 **180 秒**事件。上述四类暂时失败用同一个事件重试；原 pending 改变、到期或被消费后，不刷新原事件寿命来绕过检查。网络结果不明确或非暂时性等待原因不会自动重复操作。

## 审计与验证口径

本机协调审计位于资料目录的 `agent-coordinator/audit.jsonl`，界面只保留最近 50 项。字段为 `idHash`、`requestHash`、`kind`、`decision`、`reasonCode`、`source`、`durationMs`、`at`。不保存原题干、选项、路径、文件正文、模型原文或令牌；适配器 stderr 也只打印摘要与固定结果码。它们与原来含任务正文的 `state.json` 历史分开。

摘要仍可关联同一请求；知道候选原文时也可重算哈希匹配，不能把元数据审计称作匿名或无隐私风险。普通任务、上游 Agent 自身历史和其他系统日志不由协调审计策略统一清除。

已通过 **54 项协调核心单元测试**及 TypeScript 检查，覆盖工作区、路径与正文拒绝、格式/重复键、选择范围、幂等、暂时失败重试、并发与迟答、退出缓存、HTTP 鉴权/来源/大小、审计脱敏和扫描预算。可分别运行：

```powershell
Set-Location D:\Coloop
npm.cmd run typecheck
npx.cmd vitest run tests/coordinator.test.ts
npm.cmd run test:coordination

Set-Location D:\RK
& D:\RK\.venv\Scripts\python.exe -m unittest discover -s tools/tests -p test_coloop_agent.py -v
```

`test:coordination` 构建并启动真实 Electron，使用隔离 `.qa/coordination-*/profile`。设置当前进程的 `COLOOP_TEST_BOARD_PASSWORD` 才额外进行真实板端 NPU 测试；没有该变量的测试不代表已经验证模型。具体本轮端到端结果、耗时与证据目录由 [验收记录](verification.md) 分项记录。

验证分两类：本机 fixture 检查边界与协议；随后实际 OpenCode 1.19.5 会话通过真实 NPU 调用 question 产生 pending，由 Coloop/RK 选择原有离线标签，适配器提交一次reply后工具completed、pending消失、最终回答确认选择。实际记录见 `D:\RK\logs\coloop-real-opencode-1793287042732/summary.json`。该样例只含受限合成问题，不能外推通用开发成功率或证明任意后续动作；Codex 桌面原生审批尚未接入。

## 源码与参考

| 范围                                | 可维护入口                                                                      |
| ----------------------------------- | ------------------------------------------------------------------------------- |
| 事件、决定与规范 JSON               | `src/shared/coordinator.ts`                                                     |
| 本机隐私、路径、扫描与选项规则      | `src/main/domain/review-policy.ts`                                              |
| 账本、超时、HTTP 与元数据审计       | `src/main/services/coordinator.ts`                                              |
| 临时连接文件与 Windows ACL          | `src/main/infrastructure/coordinator-connection.ts`                             |
| RK 鉴权通道、私密日志回执与模型互斥 | `src/main/infrastructure/board.ts`                                              |
| 组装、可信根、启动和清理            | `src/main/index.ts`                                                             |
| 界面                                | `src/renderer/src/CoordinatorPage.tsx`                                          |
| 协调测试                            | `tests/coordinator.test.ts`、`tests/coordination-e2e.mjs`                       |
| Python 客户端和 OpenCode 映射       | `D:\RK\tools\coloop_agent.py`、`D:\RK\tools\tests\test_coloop_agent.py`         |
| 板端日志隐私实现                    | `D:\RK\rk-opencode\bridge\server.py`、`D:\RK\rk-opencode\tests\test_privacy.py` |

产品参考为 [Violoop 官网](https://violoop.ai/)及其[屏幕理解机制说明](https://violoop.ai/blog/ai-that-reads-your-screen/)，借鉴观察、判断、执行分层及按模式说明数据路由的思路。本实现没有复现其宣称的独立 MCU 或物理确认闸门，不能据此声称具有相同硬件隔离能力。

[Violoop 隐私政策](https://violoop.ai/privacy/)（页面标注更新于 2026-09-15）对 Internet BYOK 说明了代理处理路径。因此不能把某个模式的本地处理或直连描述扩大为所有模式的数据保证。Coloop 的隐私口径以本项目实际回环、SSH、模型服务、适配器和日志证据为准。
