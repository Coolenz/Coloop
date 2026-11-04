# 电脑会话控制与顶部提示

实现日期：2026-10-30。桌面、手机入口和未来 RK 续推建议复用同一个会话控制服务。会话基础首轮实现 Windows OpenCode 人工控制及屏幕顶部真实提示；后续 Android 客户端与独立公网加密入口见 [Android 首版](android.md)。自动续推或 Codex 桌面控制尚未实现。

## 当前入口

在「Agent 协调 → 电脑会话控制」中预览顶部提示、选择已接入的 Windows 会话、发送追加要求或停止控制。纯文字推理、OCR、设备连接和仅观察 Hook 不显示正在控制电脑。预览明确显示「Preview · No actions running」，30 秒后自动关闭。

实际控制提示为独立 Electron 窗口，按主显示器的完整 `screen.bounds` 坐标定位到整个屏幕顶部中央，距屏幕顶部约 8 DIP，不跟随软件主窗口。最大 373 × 76 DIP（原宽度的约 2/3）、透明背景、无边框、置顶、不进入任务栏，使用 `showInactive()` 显示。品牌仅显示「Coloop」，不显示 AI 来源或项目名；所有窗口文字、按钮及辅助标签使用英文，含「Controlling your computer」「Stop」。默认保留持续时间。移动、缩放、最小化或隐藏主窗口不改变提示位置。实际控制期间不能关闭或隐藏提示；显示失败或渲染进程中断会撤销待发指令并请求停止。

关闭主窗口后保留系统托盘。托盘可打开主界面、预览提示、停止全部控制、退出程序；退出前短暂等待停止回执。退出或电脑睡眠不应被描述为已经终止外部 AI。系统锁屏、UAC 安全桌面、第三方独占全屏及多屏目标窗口的提示覆盖不在本轮保证范围。

## 接入电脑上的 OpenCode

适配固定 OpenCode 1.19.5。保留项目其他配置，在 OpenCode 项目配置中添加：

```json
{
  "plugin": ["file:///D:/RK/rk-opencode/plugins/coloop-hook.mjs"]
}
```

启动 Coloop 后，在启动 OpenCode 的同一 PowerShell 中设置：

```powershell
$env:COLOOP_HOOK_CONNECTION = Join-Path $env:APPDATA 'coloop/agent-coordinator/connection.json'
opencode
```

独立资料目录运行时，以「Agent 协调」里实际显示的连接文件路径为准。插件路径随 RK 项目位置调整。默认可信工作区是配置中的 RK 目录及同级 Coloop 目录；注册目录必须存在，并通过 `realpath` 校验，来源不能自述目录以扩大访问范围。现有会话需要先产生原生消息或状态事件才会注册；重启 Coloop 后需重启插件来源以读取新令牌。

当前 `send_message` 仅接受空闲、已连接、支持该能力的 Windows 会话。运行中的追加要求暂不排队注入。RK 和其他平台可注册观察，当前不提供对其发消息的控制入口。中断仅作用于由 Coloop 发起、尚在跟踪的控制，不用于停止无关会话。

## 协议与状态

`SessionControlService` 独立于本应用的 `TaskService` 以及审批用的短期 Hook scope。稳定路由绑定 source、sourceId、instanceId、sessionId；当前 task/message ID 用于确认执行归属，不用作长期会话目录。界面使用随机 opaque handle，不接收原生路由和控制正文历史。

沿现有 Bearer 鉴权回环通道增加三个精确 POST 路由：

| 路由                   | 行为                                        |
| ---------------------- | ------------------------------------------- |
| `/v1/control/register` | 注册来源、平台、能力、可信工作区及会话状态  |
| `/v1/control/poll`     | 来源领取仅属于当前实例的待发命令，最多 8 条 |
| `/v1/control/report`   | 回报接受、确认、失败或结果不明              |

这些路由继续只监听 `127.0.0.1`，拒绝浏览器 Origin / Sec-Fetch 请求，并沿用 32 KiB JSON 上限。Android 使用另一个独立远程网关，经单独配对凭据、受限 RPC 和端到端加密复用会话控制；本地 Hook 总令牌不发给手机，公网隧道也不发布本地 Hook 服务。见 [跨端协议](mobile-protocol.md)。

控制命令仅有 `send_message` 和 `abort_turn`。插件主动轮询，通过 OpenCode 原生进程内 SDK transport 执行精确路径，不探测 4096 端口，不修改模型、工具或权限设置。发送使用稳定 message ID；204 接受后回读对应原生 user message，核对 ID、会话和原文。中断要求原生返回 true 并查询状态为空闲；单独 HTTP 成功不能当作停止证明。

命令状态区分 queued、dispatched、accepted、confirmed、failed、unknown、cancelled、expired。消息 confirmed 只表示已经送达；提示还要等待属于该消息的运行及结束事件。旧任务关闭、重复事件和注册心跳中的 idle 不能提前结束当前控制。

每条指令绑定 UUID 和内容摘要，账本在派发前写入磁盘。重复 UUID 同内容返回原状态，冲突内容拒绝。命令寿命 60 秒、来源心跳超时 90 秒；派发响应丢失不重新投递写指令。停止撤销排队消息，并保留全局停止锁；重新允许只接受新指令，不补发旧指令。停止未确认时持续显示未确认状态。

账本在资料目录的 `session-control/commands.json` 保存有限元数据、去重摘要和停止锁，不保存指令正文、原生会话 ID 或凭据。重启后的未结束控制标记为 unknown，不恢复执行或重投。账本损坏时阻止新控制，保留文件以便检查。普通任务历史不接收控制正文。

## 检查

```powershell
npm run typecheck
npm test
npm run test:control
```

`test:control` 使用真实 Electron 和受控协议来源，验证窗口、控制状态与回执边界，不证明真实模型任务质量。真实 Windows OpenCode 验证通过 `COLOOP_OPENCODE_EXECUTABLE` 指定固定版本可执行文件，再运行 `npm run test:control:native`；测试使用独立配置、真实 OpenCode 运行时和本机合成模型响应，不消耗云端账户。具体结果以本轮独立 `.qa` 报告为准。
