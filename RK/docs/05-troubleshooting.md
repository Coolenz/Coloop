# 常见问题

按“供电与启动 → 网络 → Python 环境 → 运行库与驱动 → 模型输入输出”的顺序排查。以下是排查方向，不是未经核实就执行的修复命令。

| 现象 | 先检查什么 | 对应资料 |
|---|---|---|
| WSL 装完却找不到 Ubuntu | WSL 功能和 Linux 发行版是两部分；检查是否安装并首次启动 Ubuntu 22.04 | [微软 WSL](https://learn.microsoft.com/windows/wsl/install) |
| WSL 提示虚拟化或重启 | 按提示完成重启，检查 Windows 功能与硬件虚拟化 | [微软 WSL](https://learn.microsoft.com/windows/wsl/install) |
| Windows 安装 RKNN 显示没有匹配版本 | 工具包是 Linux 平台包；转换命令应在 WSL 的 Python 环境执行 | [Toolkit2](https://github.com/airockchip/rknn-toolkit2/tree/v2.3.2) |
| GitHub 下载失败 | 区分网络连通性和代码错误；可用野火配套资料入口获取相关资源 | [下载索引](02-downloads.md) |
| 有电源灯但系统不启动、负载下重启 | 电源与板型、线缆、镜像、存储和启动日志；同时确认散热 | [硬件资料](01-hardware.md) |
| 刷机软件看不到设备 | 数据线、是否接 OTG、驱动、按键进入的模式 | [烧录教程](https://doc.embedfire.com/linux/rk3588/quick_start/zh/latest/quick_start/flash1_img/flash1_img.html) |
| SSH 超时 | 板子是否启动、IP 是否改变、是否同一网络、22 端口是否可达 | [网络教程](https://doc.embedfire.com/linux/rk3588/quick_start/zh/latest/quick_start/network/network2.html) |
| SSH 身份验证失败 | 用户名和密码是否属于当前镜像；WSL 账户与板端账户分别管理 | [登录教程](https://doc.embedfire.com/linux/rk3588/quick_start/zh/latest/quick_start/board_startup/board_startup.html) |
| `No module named rknn` | 是否启用 Linux 转换环境，而非 Windows 或板端 Lite2 环境 | [项目说明](../README.md) |
| `No module named rknnlite` | 是否使用板端 `.venv-board/bin/python` | [Lite2](https://doc.embedfire.com/linux/rk356x/Ai/zh/latest/lubancat_ai/env/toolkit_lite2.html) |
| `librknnrt.so` 无法加载 | 运行库是否存在、架构是否 aarch64、依赖是否可加载；先记录路径与版本 | [Lite2](https://doc.embedfire.com/linux/rk356x/Ai/zh/latest/lubancat_ai/env/toolkit_lite2.html) |
| `Invalid RKNN model version` | 转换工具与板端运行库版本是否匹配，再检查驱动要求 | [Lite2](https://doc.embedfire.com/linux/rk356x/Ai/zh/latest/lubancat_ai/env/toolkit_lite2.html) |
| 模型转换失败 | 算子支持、固定输入形状、ONNX opset、转换日志 | [SDK 文档](https://github.com/airockchip/rknn-toolkit2/tree/v2.3.2/doc) |
| 能推理但结果明显不对 | RGB/BGR、NCHW/NHWC、缩放/裁剪、mean/std、输出解码、类别顺序 | [对应模型实例](https://github.com/airockchip/rknn_model_zoo) |
| INT8 比不量化模型差很多 | 校准图片是否代表真实输入，前处理是否一致，再做量化精度分析 | [Toolkit2 教程](https://doc.embedfire.com/linux/rk356x/Ai/zh/latest/lubancat_ai/env/toolkit2.html) |
| 视频帧率低但纯推理快 | 采集、缩放、颜色变换、后处理、显示或网络发送耗时 | [性能记录](06-device-record.md) |

遇到问题时保留：完整报错、执行位置、Python 路径、SDK/镜像版本、触发命令、模型输入尺寸。先定位原因，再决定是否升级或更换系统库。
