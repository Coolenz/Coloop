# Coloop

Windows 上的 RK 智能设备工作台，以及配套的 RK3588 端侧 AI 开发工具。

Coloop 提供本地截图/OCR、云端模型连接、USB 网络设备管理和端侧 Qwen 文本推理。RK 部分包含模型准备、板端部署、OpenCode/RKLLM 桥接、记忆与隔离窗口桌面实验源码。

```text
Coloop/          Electron + React 桌面应用，当前源码版本 0.7.0
RK/
  tools/         OCR、模型准备/校验/部署、评测工具与 C++ 模板
  scripts/       Windows、WSL 与板端操作脚本
  config/        设备配置模板
  rk-opencode/   RKLLM HTTP 服务、OpenCode 集成、Mem0、桌面实验与测试
  docs/          部署说明、历史实验报告与学习资料
docs/            跨组件启动说明、模型来源、发布检查与源码来源清单
```

## 开始使用

需要 Windows 10/11 x64、Node.js 24。端侧功能需要已配置的 LubanCat-4 / RK3588 开发板；云端功能使用自己的模型服务与 Key。

```powershell
git clone https://github.com/Coolenz/Coloop.git
cd Coloop/Coloop
npm ci
npm run dev
```

OCR 需要独立的 Python 3.12 环境与 PP-OCRv5 模型。启动应用后，在设置中将 RK 项目路径改为本次克隆的 `RK` 目录；导入自己配置的 `RK/config/board.json`，使用自己的开发板地址、指纹和密码。

完整步骤见 [首次配置](docs/GETTING-STARTED.md)。应用说明见 [Coloop/README.md](Coloop/README.md)，端侧说明见 [RK/rk-opencode/README.md](RK/rk-opencode/README.md)。

## 模型和大文件

本仓库保存源码、依赖锁文件、配置模板、固定小题集、来源与校验记录。模型、SDK 二进制、虚拟环境、`node_modules`、安装程序、系统镜像、运行日志、截图、实际设备配置和凭据保留在本机。

下载入口见 [模型与 SDK 索引](docs/MODELS.md)，固定 revision、文件大小与 SHA256 见 [模型清单](docs/model-manifests/)。Qwen4B、Qwen9B 和电脑 BF16 的准备脚本保留固定版本与校验；OCR 按固定 RapidOCR 版本注册表下载。记忆嵌入模型附本次固定清单，准备脚本首次下载时会解析上游 revision，复现时应预置清单中的固定 revision。

## 能力与验证边界

- Coloop 当前调用 OCR 和端侧文本分析接口，尚未将 RK 实验中的 HID、记忆召回或跨应用自动操作接入产品界面。
- RKLLM 日常 Qwen4B 使用应用私有 Runtime/Header 1.3.0、16K 上下文。1.3.1 对照环境与历史 2048 上下文评测分别记录。
- `RK/docs` 和 `RK/rk-opencode/VALIDATION.md` 是原开发机带日期的历史报告。文中 `D:\RK`、`D:\Coloop` 等路径是原环境示例；`logs/`、部署包和截图未随代码上传，历史结论不表示任意克隆环境已通过验证。
- 本次发布的本机检查与限制见 [发布检查记录](docs/PUBLICATION.md)。

## 开发检查

```powershell
cd Coloop
npm run typecheck
npm test
npm run format:check
npm run build
```

RK Python 桥接测试：从仓库根目录运行 `python -m unittest discover -s RK/rk-opencode/tests -v`。这些单元测试不启动真实 NPU，不代替实机验收。

## 来源与许可

本仓库从三个本地 Git 工作区的当前源码快照整理，包含尚未提交的源码变更；来源基准提交与逐文件 SHA256 见 [source-snapshot.json](docs/source-snapshot.json)。本次建立统一的发布历史，原目录及其 Git 历史保留在本机。

Coloop 应用采用 [MIT](Coloop/LICENSE)。RK 原创文件本次未新增许可证，其他模型、SDK、第三方代码、字体与题集分别遵循原许可，详见 [许可与第三方来源](docs/THIRD-PARTY.md)。
