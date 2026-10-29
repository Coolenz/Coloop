# Coloop

Windows 上的 RK 智能设备工作台。连接 USB 设备，在本机识别屏幕，再交给云端或端侧模型分析。

0.7.0 接入 RK 已部署的 Qwen3.5-4B 模型服务：经固定指纹 SSH 访问板端鉴权 HTTP 接口，设备页显示服务状态、实际模型和上下文，并可启动已有服务。RK 回答完成后返回；云端沿用流式结果。

界面沿用 0.6.1 的倾斜双半圆 Logo 与石墨黑视觉：石墨黑导航、白色任务工作区、浅灰设备栏、石墨黑操作按钮和灰阶状态层级。快捷操作改为紧凑列表，表单、OCR 与设备图同步使用黑白轮廓。六个页面共享排版、控件与圆角规则；名称保持 **Coloop**。Logo 保留外弧稍厚、竖边稍细的轮廓，整体倾斜 −35°；源文件为 `resources/brand.svg`，预览为 `resources/logo-preview.png`，PNG 和 ICO 由同一 SVG 生成。设计规范见 `DESIGN.md`。

本目录是 Coloop 应用源码；仓库级配置和模型来源见 [根目录说明](../README.md)。下文绝对路径是原开发机示例，克隆后应替换为实际路径。

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

| 功能     | 行为                                                                            |
| -------- | ------------------------------------------------------------------------------- |
| 工作台   | 文字任务、附加屏幕或 OCR 文本、云端/RK 选择；云端流式结果，RK 完成后返回        |
| 模型连接 | OpenAI 兼容、Anthropic、Gemini 协议；自定义地址/模型；保存与连接测试            |
| 屏幕理解 | 多显示器截图、图片导入、RapidOCR 中英文识别、文字框/中心坐标、坐标 JSON 复制    |
| USB 设备 | USB RNDIS 网络 + 固定指纹 SSH；温度、内存、运行时长、模型服务就绪状态           |
| 端侧推理 | 复用板端 `qwen35-4b-rkllm` / 16K 鉴权服务；启动已有服务、超时与忙碌提示         |
| 工作流   | 截屏 → 本地 OCR → 模型总结/翻译 → 本地任务记录                                  |
| 历史     | 最近 200 条任务、搜索、状态筛选、导出 JSON、清空                                |
| 本地存储 | 云端 API Key 经 Windows DPAPI 加密；SSH 密码与板端服务 Key 不落盘；图片只留内存 |

## 第一次配置

1. 使用数据线连接开发板 OTG 接口，在「设备管理」点「导入 RK 配置」，输入 SSH 密码并连接。会校验 `D:\RK\config\board.json` 中的设备指纹。端侧服务目录默认 `~/rk-opencode`，端口默认 `8088`；修改后先保存。
2. 查看「端侧能力」。已就绪时可直接在工作台选择 RK；未启动时点「启动端侧服务」，等待服务就绪。按钮只启动已部署的 Qwen3.5-4B 服务，不安装运行环境或权重。存在活跃桥接进程或端口被占用时会拒绝替换，需先检查原服务。已有启动脚本使用端口 `8088`。
3. 需要云端模型时，在「模型连接」选择协议、填写带版本前缀的地址、模型 ID 与 API Key，保存后测试。默认模型名只是可编辑示例，以账户实际可用模型为准；运行 RK 任务不需要云端 Key。
4. 在「屏幕理解」导入图片或截屏、识别，再点「用于任务」。也可在工作台直接启用「附加当前屏幕」。截图时本窗口会短暂隐藏。选择 RK 时，仅将识别文本作为参考内容交给板端模型分析。

端侧请求经 SSH 私有转发到开发板 `127.0.0.1:8088`，板端服务 Key 通过 SSH 读取后只保留在主进程内存，界面不接收该凭据。设备显示「已就绪」来自鉴权 `/health` 响应，不再使用模型文件存在作为就绪依据。模型忙碌会显示明确提示，不自动切换云端。

RK 任务的「停止等待」只停止上位机等待，不强制结束板端共享推理；之后立即提交的新任务可能收到忙碌提示。端侧当前一次返回完整回答，不提供逐 token 输出。

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

`test:e2e` 使用真实 Electron、真实 RapidOCR 和本机 HTTP 测试服务，不消耗云端额度；需上述已安装 OCR 环境。设置 `COLOOP_TEST_BOARD_PASSWORD` 可额外验证真实 USB 设备健康读取；同时设置 `COLOOP_TEST_BOARD_INFERENCE=1` 会启动已部署的端侧服务（如未启动），运行真实 NPU 算术与 OCR 文本提取。测试配置与历史写入独立的 `.qa` 目录，不执行跨应用桌面操作。设置 `COLOOP_EXECUTABLE` 可对指定的打包程序执行同一验证。

打包入口使用本机安装的 Electron 精确版本，生成 `release/Coloop-0.7.0-Windows-x64.exe` 和 `release/win-unpacked/Coloop.exe`。换电脑时，需要另行准备 RK OCR 环境并设置路径；当前发布物没有复制整个 Python 环境。可执行程序未做代码签名。

## 当前边界

- 服务健康就绪表示选定模型与协议可用，不代表模型回答质量已验收。端侧输出仍需核对，具体实机验证范围见验收记录。
- OCR 坐标是当前图像的像素坐标，不直接作为桌面物理坐标。不是按钮边界，也不证明可点击。
- Coloop 当前只接入文本分析，不暴露 RK 项目独立的 HID、工具执行或记忆召回能力，也不提供跨应用自动操作、语音或离开模式。
- Mem0 仅用于登记本次前台模型占用，并在推理前等待正在进行的维护排空；任务不会借此调用记忆检索或写入。共享服务可能被其他 RK 会话占用。
- 云端真实账户调用需配置自己的 Key；本次测试使用本机协议服务，不代表已验证某个账户或服务商的可用性。
- 运行历史包含任务与模型回答，保存在 `%APPDATA%\coloop\state.json`；API Key 的加密不覆盖历史文本。

详见 [架构](docs/architecture.md)、[验收记录](docs/verification.md)、[界面设计](docs/design.md)、[参考来源与第三方组件](docs/references.md)。
