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
   ├── BoardGateway：SSH host-key pinning + USB RNDIS
   ├── OcrEngine：私有 JSON Lines + 常驻 Python OCR 子进程
   └── AppStore：原子 JSON snapshot + Windows DPAPI secret codec
               │
               └── 已安装 RK 环境 / 下位机现有模型入口
```

渲染层只负责交互和显示，不能直接连接网络、访问文件或运行程序。`src/shared/contracts.ts` 同时定义公共 TypeScript 类型和 Zod 输入边界。主进程校验调用窗口、顶层 frame 与确切页面地址，然后校验参数。

`src/main/index.ts` 是组装入口，负责窗口、原生对话框、截图与依赖注入。业务状态在 `services/tasks.ts`，模型、SSH、OCR、持久化位于各自的基础设施模块。新设备协议应实现新的设备 gateway，不把设备命令嵌入 React 页面。

## 设备协议决策

现有 `D:\RK` 是 LubanCat-4 / RK3588 项目：USB 提供 Windows RNDIS 网络，设备通过 SSH 管理；没有公开的上位机串口/HID RPC。因此使用现有通道，不发明与固件不匹配的串口帧。

- 从 `D:\RK\config\board.json` 导入 host、port、user 和 SHA256 指纹。
- SSH 在认证前校验主机指纹，不采用首次连接自动信任。
- 只暴露健康查询与 Qwen 文本推理，没有通用 shell 入口。
- 健康读取是固定 Python 脚本，返回结构化 JSON，并再次验证类型。
- 模型 prompt 用 POSIX 单引号转义。最大上下文 3000 字，输出 256 tokens，板端 context 2048，外层 `timeout` 180 秒、TERM 后 5 秒 KILL。
- 取消时发 SSH TERM 并关闭 channel；若服务端没有处理 signal，板端 timeout 仍提供上限。下位机现有 `flock` 防止相同模型重入。

本版只读健康测试不修改板卡系统。Qwen 是可选能力，不将端侧失败悄悄回退云端。

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

## 状态与持久化

任务状态为 `running → completed | failed | cancelled`。应用同一时间只有一个任务，避免板端模型竞争和并发屏幕上下文错配。任务开始与结束保存快照，输出过程中在内存更新，IPC 通知按 70ms 合并。

`state.json.tmp → rename → state.json` 提供同目录原子替换。最多 200 条任务，损坏的文件重命名为 `state.recovery-*.json` 供恢复；上次未结束的运行在重启后标记中断。原始图像与 SSH 密码不持久化。历史文本不加密，云端发送行为由用户主动发起任务决定。

## 版本与构建

先建立 Git 并提交初始化，再进行实现。根目录 `package-lock.json` 固定解析依赖；CI 在 Windows 以 Node.js 24 安装、测试、构建和产出 portable 程序。代码统一 Prettier 与 EditorConfig，输入边界与设备身份有自动测试；端到端测试用独立资料目录，避免污染实际工作区。

应用没有必须重新编译的 Node 原生扩展。SSH 使用 ssh2 的 JavaScript 实现，打包关闭 `npmRebuild`，避免其可选 CPU 检测扩展触发不必要的 node-gyp 工具链下载；真实打包程序的 SSH 通道另做端到端验证。

后续若加入长任务队列、插件、HID、UIA 和动作回读，应保留现有 gateway 边界，增加明确的动作协议、状态机与结果验证。离开模式和自动重试不能仅靠在界面加开关实现。
