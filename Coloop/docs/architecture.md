# 架构与工程约束

## 分层

```text
React renderer
   │  DesktopApi：明确的方法，无通用 invoke、shell 或文件系统接口
Sandboxed preload
   │  contextBridge + IPC allowlist
Electron main composition root
   ├── TaskService：串行任务、状态转换、取消、恢复与审计
   ├── CloudGateway：OpenAI compatible / Anthropic / Gemini
   ├── BoardGateway：USB RNDIS + 固定指纹 SSH + 私有 HTTP 转发
   ├── OcrEngine：私有 JSON Lines + 常驻 Python OCR 子进程
   └── AppStore：原子 JSON snapshot + Windows DPAPI secret codec
               │
               └── 已安装 RK OCR 环境 / 板端 RK OpenCode 模型服务
```

渲染层只负责交互和显示，不能直接连接网络、访问文件或运行程序。`src/shared/contracts.ts` 同时定义公共 TypeScript 类型和 Zod 输入边界。主进程校验调用窗口、顶层 frame 与确切页面地址，然后校验参数。

`src/main/index.ts` 是组装入口，负责窗口、原生对话框、截图与依赖注入。业务状态在 `services/tasks.ts`，模型、SSH、OCR、持久化位于各自的基础设施模块。新设备协议应实现新的设备 gateway，不把设备命令嵌入 React 页面。

## 设备协议决策

现有 `D:\RK` 是 LubanCat-4 / RK3588 项目：USB 提供 Windows RNDIS 网络，设备通过 SSH 管理；板端 `~/rk-opencode` 已有鉴权模型桥接服务。Coloop 0.7.0 复用该服务的 Qwen3.5-4B 推理接口。

- 从 `D:\RK\config\board.json` 导入 host、port、user 和 SHA256 指纹，以及可选 `agent_dir` / `agent_port`。服务目录、端口缺省为 `~/rk-opencode` / `8088`，可在设备页保存修改。
- SSH 在认证前校验主机指纹，不采用首次连接自动信任。
- 温度、内存、运行时长通过固定 Python 脚本读取，返回结构化 JSON 并验证类型。连接会话绑定刷新结果，旧请求不能恢复已断开的状态或断开新连接；同会话并发刷新合并。
- 主进程通过 `ssh2.forwardOut` 为 HTTP 请求建立私有通道，目标固定为开发板的 `127.0.0.1` 与配置端口，不在 Windows 另开监听端口。鉴权 Key 通过 SSH 从服务目录的 `.runtime/api-key` 读取，只保留在主进程内存，不回传界面或写入 Coloop 配置。
- `/health` 必须返回 `ready: true`、模型 `qwen35-4b-rkllm`、worker protocol 2 和有效上下文等信息，才能令 `qwenReady` 为真；文件存在不再代表模型可用。设备页显示响应中的实际模型、上下文与运行库。
- 「启动端侧服务」调用已部署目录中的 `scripts/start.sh`，使用 `qwen35-4b` profile、16384 上下文；检查已有桥接进程、端口占用和安装文件后才启动。存在活跃服务或端口被占用时拒绝替换，不重装环境、权重或运行库。已有启动脚本只支持端口 `8088`；自定义端口用于连接已按相同协议启动的服务。
- 文本推理调用 `/v1/chat/completions`，设置 `tools: []`、`tool_choice: 'none'`、`stream: false`，关闭请求缓存，输出上限 512 tokens。上下文以服务上报预算为准，发送前保守按 UTF-8 字节检查并预留开销；参考文本使用独立标签包裹。请求最长等待 190 秒，响应上限 2 MB。
- 板端完成后一次返回回答，不把一次性结果伪装成逐 token 流式输出。HTTP 429 明确表示模型忙碌；鉴权失败、模型不可用、超时或输出截断分别反馈。
- 「停止等待」取消本次 HTTP 等待，不强杀共享 worker，也不证明板端推理已停止。后续任务可能仍收到 HTTP 429；界面保留这一语义。修改配置或断开连接前需先停止当前 Coloop 端侧任务。

Coloop 只暴露健康查询、启动已有服务和文本分析，没有通用 shell、HID、工具执行或记忆召回入口。端侧失败不会自动回退云端。

若已部署 Mem0，推理前只登记前台活动并等待正在进行的记忆维护排空，结束或停止等待后释放本次活动登记；不读取、写入或召回用户记忆。模型服务与其他 RK 会话共享，Coloop 的单任务约束不能代替板端忙碌检测。

## OCR 决策

按用户补充信息复用已经安装的 RapidOCR 3.10.0 + PP-OCRv5 mobile，而不是再安装一套 OCR。`resources/rapidocr-worker.py` 仅做适配，不改动 RK 文件。子进程使用 `windowsHide`，每次应用运行复用一个模型实例。只有图像识别接口，不加载用户提供的代码、不接受鼠标键盘指令。

图片经原生图像解码规范化为 PNG；来源必须是主进程截图或原生文件选择器，渲染层只拿到随机 ID。最多缓存 4 张，文件最大 20 MB、4000 万像素。识别超时/取消会终止该子进程，下次识别重新启动。OCR 文本、置信度、四角坐标、中心位置按 JSON Lines 返回；IPC 只返回经 schema 验证的结果。

坐标属于识别图片。Electron 的桌面布局单位与 Windows 混合 DPI 的物理像素映射尚未做跨屏标定，因此没有把文字中心直接用于自动点击。

## 模型与凭据

- 云端网关仅做协议适配和有限的 SSE/JSON 解析，使用 Electron `net.fetch`，请求直达配置端点。
- 请求超时 120 秒，输出上限 4 MB；不跟随重定向转发凭据；不回显服务商错误响应正文。
- Key 只在主进程解密，使用 `safeStorage`（Windows DPAPI）持久化，界面只获得 `hasKey`。
- 地址或协议改变时清除旧凭据，防止旧 Key 发到新端点。
- 本地环回 HTTP 可无 Key；其余地址必须 HTTPS，禁止 URL 内嵌账号、密码或 query 参数。
- OCR 文字作为不可信上下文包裹，不作为应用指令。模型输出仅显示为文本，不渲染 HTML、不执行代码。
- 选择 RK 时，OCR 文本作为上述参考内容发送到板端模型，原始图片和 OCR 坐标不进入 HID 或工具调用链路。

## 状态与持久化

任务状态为 `running → completed | failed | cancelled`。应用同一时间只有一个任务，避免本应用内的板端模型竞争和并发屏幕上下文错配。任务开始与结束保存快照，云端流式输出过程中在内存更新，RK 回答完成后更新；IPC 通知按 70ms 合并。RK 的 `cancelled` 表示用户停止等待，不表示已终止板端共享推理。

`state.json.tmp → rename → state.json` 提供同目录原子替换。最多 200 条任务，损坏的文件重命名为 `state.recovery-*.json` 供恢复；上次未结束的运行在重启后标记中断。原始图像与 SSH 密码不持久化。历史文本不加密，云端发送行为由用户主动发起任务决定。

## 版本与构建

先建立 Git 并提交初始化，再进行实现。根目录 `package-lock.json` 固定解析依赖；CI 在 Windows 以 Node.js 24 安装、测试、构建和产出 portable 程序。代码统一 Prettier 与 EditorConfig，输入边界与设备身份有自动测试；端到端测试用独立资料目录，避免污染实际工作区。

应用没有必须重新编译的 Node 原生扩展。SSH 使用 ssh2 的 JavaScript 实现，打包关闭 `npmRebuild`，避免其可选 CPU 检测扩展触发不必要的 node-gyp 工具链下载；真实打包程序的 SSH 通道另做端到端验证。

后续若加入长任务队列、插件、HID、UIA 和动作回读，应保留现有 gateway 边界，增加明确的动作协议、状态机与结果验证。离开模式和自动重试不能仅靠在界面加开关实现。
