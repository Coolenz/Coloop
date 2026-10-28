# Coloop

Windows 上的 RK 智能设备工作台。连接 USB 设备，在本机识别屏幕，再交给云端或端侧模型分析。

仓库位于 `D:\Coloop`。开发前已初始化 Git，首个提交为 `c1102c8`；没有上传到远端。

## 启动

双击 [`start.cmd`](start.cmd)，优先运行 `release` 下的 Windows 程序。打包程序复用本机已经安装的 `D:\RK` OCR 环境，无需重新安装 OCR。

开发环境需要 Windows 10/11 x64、Node.js 24。使用锁文件安装：

```powershell
cd D:\Coloop
npm ci
npm run dev
```

Electron 下载如受网络影响，可仅对当前终端设置镜像，再运行 `npm run setup:electron`：

```powershell
$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
npm run setup:electron
```

## 已实现

| 功能     | 行为                                                                         |
| -------- | ---------------------------------------------------------------------------- |
| 工作台   | 文字任务、附加屏幕或 OCR 文本、云端/RK 选择、流式结果、取消                  |
| 模型连接 | OpenAI 兼容、Anthropic、Gemini 协议；自定义地址/模型；保存与连接测试         |
| 屏幕理解 | 多显示器截图、图片导入、RapidOCR 中英文识别、文字框/中心坐标、坐标 JSON 复制 |
| USB 设备 | USB RNDIS 网络 + SSH；固定主机指纹；温度、内存、运行时长、端侧文件状态       |
| 端侧推理 | 调用 RK 已有 `qwen35/run.sh --prompt`，有超时、取消与已有推理锁              |
| 工作流   | 截屏 → 本地 OCR → 模型总结/翻译 → 本地任务记录                               |
| 历史     | 最近 200 条任务、搜索、状态筛选、导出 JSON、清空                             |
| 本地存储 | API Key 经 Windows DPAPI 加密；SSH 密码不落盘；原始图片只留内存              |

## 第一次配置

1. 在「模型连接」选择协议、填写带版本前缀的地址、模型 ID 与 API Key，保存后测试。默认模型名只是可编辑示例，以账户实际可用模型为准。
2. 在「设备管理」点「导入 RK 配置」，使用数据线连接开发板 OTG 接口，输入 SSH 密码。会校验 `D:\RK\config\board.json` 中的设备指纹。
3. 在「屏幕理解」导入图片或截屏、识别，再点「用于任务」。也可在工作台直接启用「附加当前屏幕」。截图时本窗口会短暂隐藏。

OpenAI 兼容地址示例为 `https://api.deepseek.com/v1`；本地 Ollama 可填 `http://localhost:11434/v1`，允许留空 Key。远程地址必须 HTTPS。云端请求使用 Electron 网络栈，沿用 Windows 系统网络配置。

OCR 复用 `D:\RK\deployment\screen-ocr\.venv\Scripts\python.exe` 和 `D:\RK\tools\screen_ocr.py`，不复制或修改 RK 环境。在「模型连接」底部可更改 RK 项目路径。识别常驻进程不监听 TCP 端口，仅通过私有 stdin/stdout 通信，网络请求被禁用。

## 检查与打包

```powershell
npm run typecheck
npm test
npm run format:check
npm run test:e2e
npm run package:win
```

`test:e2e` 使用真实 Electron、真实 RapidOCR 和本机 HTTP 测试服务，不消耗云端额度；需上述已安装 OCR 环境。设置 `COLOOP_TEST_BOARD_PASSWORD` 可额外验证真实 USB 设备健康读取；测试配置与历史写入独立的 `.qa` 目录。测试不执行桌面点击、键盘输入或板端模型推理。

打包入口使用本机安装的 Electron 精确版本，生成 `release/Coloop-0.1.0-Windows-x64.exe` 和 `release/win-unpacked/Coloop.exe`。换电脑时，需要另行准备 RK OCR 环境并设置路径；当前发布物没有复制整个 Python 环境。可执行程序未做代码签名。

## 当前边界

- 已验证 USB 健康读取；Qwen 文件就绪检查不等于模型回答质量验收。RK 现有日志的一次算术检查未通过，输出需核对。
- OCR 坐标是当前图像的像素坐标，不直接作为桌面物理坐标。不是按钮边界，也不证明可点击。
- 这一版提供屏幕分析与任务结果，没有 USB HID 鼠标键盘固件、跨应用自动操作、语音或离开模式。后续需基于明确的设备协议扩展执行适配器。
- 云端真实账户调用需配置自己的 Key；本次测试使用本机协议服务，不代表已验证某个账户或服务商的可用性。
- 运行历史包含任务与模型回答，保存在 `%APPDATA%\coloop\state.json`；API Key 的加密不覆盖历史文本。

详见 [架构](docs/architecture.md)、[验收记录](docs/verification.md)、[界面设计](docs/design.md)、[参考来源与第三方组件](docs/references.md)。
