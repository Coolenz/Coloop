# 官方资料与下载入口

核对日期：2026-10-26。优先从野火和 Rockchip 官方入口获取工具。网盘内容与发布文件名会更新，下面保留官方导航页面，不猜测某个镜像的直链。

## 板卡与 Linux 系统

| 资料 | 官方入口 | 何时需要 |
|---|---|---|
| RK3588 系列快速手册 | [手册目录](https://doc.embedfire.com/linux/rk3588/quick_start/zh/latest/index.html) | 始终保留作索引 |
| 鲁班猫 4 系列硬件 | [硬件与板型](https://doc.embedfire.com/linux/rk3588/quick_start/zh/latest/quick_start/lubancat/lubancat4.html) | 选电源、确认接口前 |
| 官方系统镜像 | [镜像获取](https://doc.embedfire.com/linux/rk3588/quick_start/zh/latest/quick_start/flash_img/flash_img.html) | 需要刷机时；页面带网盘资源入口 |
| RKDevTool、DriverAssistant、SD 写卡工具 | [镜像烧录](https://doc.embedfire.com/linux/rk3588/quick_start/zh/latest/quick_start/flash1_img/flash1_img.html) | 按镜像类型与 eMMC/SD 选择；官方页注明网盘提取码 hslu |
| 开机与串口、SSH 登录 | [系统登录](https://doc.embedfire.com/linux/rk3588/quick_start/zh/latest/quick_start/board_startup/board_startup.html) | 首次连接 |
| 网络配置 | [网络连接](https://doc.embedfire.com/linux/rk3588/quick_start/zh/latest/quick_start/network/network2.html) | 获取 IP、排查联网问题 |
| 摄像头支持与操作 | [摄像头章节](https://doc.embedfire.com/linux/rk3588/quick_start/zh/latest/quick_start/camera/camera.html) | 购买摄像头和采集图像前 |
| 镜像与驱动变化 | [Kernel 5.10](https://doc.embedfire.com/linux/rk3588/quick_start/zh/latest/quick_start/baidu_cloud/update_history_kernel5.10.html)、[Kernel 6.1](https://doc.embedfire.com/linux/rk3588/quick_start/zh/latest/quick_start/baidu_cloud/update_history_kernel6.1.html) | 核对新镜像修复与兼容性 |

镜像选择建议：出厂系统能用则先保留；需重装时，优先选择明确支持该板型、Python 与 NPU 的野火 Linux 镜像。板上没有桌面也能通过 SSH 做 AI 开发。主机 WSL 的 Ubuntu 22.04 和板端系统不必相同。

Ubuntu 22/24 的官方命名区分 `lubancat-4` 与 `lubancat-4io`（BTB 配套板）。不要只看到“RK3588”就下载；核对完整板型。旧版通用镜像的命名可能不同，按对应下载说明判断。[镜像命名说明](https://doc.embedfire.com/linux/rk3588/quick_start/zh/latest/quick_start/flash_img/flash_img.html)

## AI 工具与教程

| 内容 | 官方入口 | 项目中的对应文件 |
|---|---|---|
| 野火 RKNN 转换教程 | [Toolkit2](https://doc.embedfire.com/linux/rk356x/Ai/zh/latest/lubancat_ai/env/toolkit2.html) | `requirements-rknn.txt`、`tools/convert.py` |
| 野火板端 Python 推理教程 | [Toolkit Lite2](https://doc.embedfire.com/linux/rk356x/Ai/zh/latest/lubancat_ai/env/toolkit_lite2.html) | `scripts/setup-board.sh` |
| 野火 C/C++ 推理教程 | [RKNPU2](https://doc.embedfire.com/linux/rk356x/Ai/zh/latest/lubancat_ai/env/rknpu.html) | `cmake/aarch64-linux-gnu.cmake` |
| Rockchip SDK 2.3.2 | [固定版本仓库](https://github.com/airockchip/rknn-toolkit2/tree/v2.3.2) | `scripts/fetch-sdk.ps1` 可按需拉取 |
| SDK 中文手册 | [v2.3.2 文档目录](https://github.com/airockchip/rknn-toolkit2/tree/v2.3.2/doc) | 手动选择中文用户指南、API 文档 |
| 官方模型示例 | [RKNN Model Zoo](https://github.com/airockchip/rknn_model_zoo) | 选分类/检测示例，记录实际使用的 tag 或提交 |
| 野火 AI 示例源码 | [LubanCat Gitee 仓库](https://gitee.com/LubanCat/lubancat_ai_manual_code) | GitHub 访问不畅时也可参考配套实例 |
| 大语言模型 | [RKLLM](https://github.com/airockchip/rknn-llm) | 独立路线，本项目暂未安装 |
| WSL 安装 | [Microsoft 安装说明](https://learn.microsoft.com/windows/wsl/install) | `scripts/install-wsl-admin.ps1` |

Model Zoo 主分支会更新。使用本项目的 Toolkit2 2.3.2 时，要核对示例的 SDK 要求，不能默认最新示例都与旧 SDK 匹配。

## 建议下载顺序

1. 完成 WSL Ubuntu 和本项目的 Python 依赖安装。
2. 开发板可以启动则直接获取系统信息；不能启动或决定换系统时才下载匹配镜像。
3. 根据 eMMC/SD 和镜像类型下载相应烧录工具。
4. 需要 SDK 手册、运行库或官方完整实例时再下载 SDK。
5. 跑通基础验证后只下载一个模型及所需测试图，再逐渐增加资料。

官方 PDF、入门示例源码及一个 RK3588 测试模型已通过下载脚本保存到 `downloads/`；结果、阅读顺序和校验清单见 [本地资料索引](../downloads/README.md)。已补充 Ubuntu 22.04 Server 镜像、RKDevTool 3.37 和必要 RKNN SDK 安装文件，且已完成实机验证；全量 SDK 与全部模型权重未下载。

2026-10-27 补充：普通鲁班猫 4 与 4-BTB 核心板/底板原理图已从官方硬件站直链下载并解压，见[硬件资料索引](../downloads/hardware/README.md)。
