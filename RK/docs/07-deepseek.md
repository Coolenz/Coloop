# 在鲁班猫 4 上运行现成的 DeepSeek 模型

## 当前版本更新（2026-10-28）

已按最新要求切换至 **RKLLM Runtime 1.3.1**，应用已用新版头文件重新编译；电脑端 **RKLLM-Toolkit 1.3.1 / Python 3.10.12** 的使用方法见 [模型转换环境](08-rkllm-toolkit.md)。运行入口和板端 `deepseek` 目录保持一致。

现有模型仍是原先社区转换的 1.1.4 模型文件，文件名中的版本表示转换来源，不代表当前运行库版本。新版已完成该模型加载和生成测试，但同一算术题本次回答 18（正确答案为 19），不能将旧版的正确性验证直接沿用到新版。尚未重新转换完整 DeepSeek 模型。

SDK 下载目录现为 `downloads/rkllm-1.3.1/`。以下原始部署与验证内容保留为历史记录，其中 1.1.4 和“转换工具未安装”不再描述当前软件环境。

## 本次部署

- 模型：DeepSeek-R1-Distill-Qwen-1.5B，W8A8 量化，RK3588 平台。
- 模型文件：`deepseek-r1-1.5B-rkllm1.1.4.rkllm`，2,035,400,060 字节。
- 模型来源：[VRxiaojie 的社区转换版本](https://huggingface.co/VRxiaojie/DeepSeek-R1-Distill-Qwen-1.5B-RK3588S-RKLLM1.1.4)，不是野火或瑞芯微发布的权重。原始模型来自 DeepSeek。
- 模型仓库固定版本：`bb9ef8749ad138cedb3ed09e9ba72bd177cf0a15`。
- SHA256：`85f87f2e1bf0c70f1e9f4058bc0c6659b7db5728f00bd806e343a93e0a7dd66e`，与发布仓库的 LFS 摘要比对。
- 运行库与示例：瑞芯微官方 RKLLM 1.1.4，提交 `8623edd0559a07e7127876d685f2b7ca8b83590c`。
- 板端目录：`/home/cat/rk-edge-ai/deepseek`。

部署沿用现有 Ubuntu 22.04.5 和 NPU 驱动，不重新烧录。RKLLM 的运行库放在该应用的 `lib` 目录，原来的 ResNet18/RKNN 环境继续保留。

本次使用现成的 `.rkllm`，跳过电脑端模型转换；这不表示已经安装 RKLLM 转换工具。以后自行转换时，还需配置相应的独立转换环境。

## 启动问答

模型已下载、上传并通过一次实际问答测试，可双击项目根目录中的 **运行DeepSeek.cmd**。
输入现有开发板 SSH 密码，看到 `user:` 后输入中文问题，按回车。
输入 `exit` 退出。窗口同时会显示运行库版本和生成速度等信息。

在 Windows 的项目终端中也可以运行：

```powershell
powershell -ExecutionPolicy Bypass -File D:\RK\scripts\deepseek.ps1
```

如果已经登录到 `cat@lubancat:~$`，直接执行：

```bash
bash ~/rk-edge-ai/deepseek/run.sh
```

默认最多生成 512 个 token，上下文长度为 2048。token 是文本片段，不等同于汉字数。达到生成上限时，回答可能还未结束。
需要更长回答时，可在 Windows 执行：

```powershell
powershell -ExecutionPolicy Bypass -File D:\RK\scripts\deepseek.ps1 -MaxNewTokens 1024 -ContextLength 2048
```

这是终端问答演示，网页聊天界面尚未配置。1.5B 模型能力有限，回答可能出错。
同一应用只允许一个推理进程；启动返回代码 75 表示另一个窗口正在使用模型。

启动入口已统一使用 UTF-8，支持 Windows 终端直接输入中文。若之前遇到
`std::invalid_argument: invalid character` 或退出码 134，请关闭旧窗口并重新运行 **运行DeepSeek.cmd**。
板端会拒绝无效的 UTF-8 输入并继续等待下一行，不再将错误编码交给模型解析。

## 可复现的准备流程

```powershell
cd D:\RK
.\.venv\Scripts\python.exe tools\prepare_deepseek.py
.\.venv\Scripts\python.exe tools\deploy_deepseek.py
```

下载脚本支持分段续传，并固定模型和 SDK 来源版本。部署时会再次在开发板上校验模型摘要。
本地下载与来源记录位于 `downloads/deepseek-rkllm-1.1.4/`；配套运行源码位于 `deployment/deepseek/`。
运行源码基于官方示例，适配了 DeepSeek 对话标记、终端输入结束处理、流式刷新和推理返回值检查。

## 验证记录

2026-10-28：下载文件和板端文件均通过 SHA256 校验，RKLLM 初始化及 NPU 问答测试成功。

- 实际平台：RK3588；RKLLM Runtime 1.1.4；RKNPU 驱动 0.9.8。
- 测试问题：28 人排成一行，左起第 10 人，从右边数第几人？
- 实际回答：第 19 位，答案正确。
- 生成阶段：228 token，19.105 秒，约 11.79 token/秒。
- 包含初始化和退出的完整测试：23.78 秒。
- 测试期间所有已读取温度传感器的最高值：43.461℃。
- 退出码为 0；未超时，未触发测试程序的温度停止条件。

这是一次短问答验证，不是持续负载或模型能力的全面评测；风扇的实际转动问题仍待单独确认。
完整日志见 `logs/deepseek-smoke.txt`，摘要见 `logs/deepseek-status.json`。

2026-10-28 中文输入修复验证：通过 Windows PowerShell 5.1 启动脚本和 SSH 交互终端，
直接输入“  小明有20元，买了3支笔，每支4元。他还剩多少钱”，模型正确回答 8 元，
生成 211 token，约 11.76 token/秒，输入 `exit` 后正常退出。
另外验证了 GBK 中文、无效字节和截断的 UTF-8：均提示重新输入，进程未崩溃。
对应日志为 `logs/deepseek-encoding-before.txt` 和 `logs/deepseek-encoding-after.txt`。

## 教材依据

- [野火 DeepSeek-R1 章节](https://doc.embedfire.com/linux/rk356x/Ai/zh/latest/lubancat_ai/example/deepseek.html)：RKLLM 1.1.4，模型转换与鲁班猫 4 部署。
- [野火 RKLLM 环境章节](https://doc.embedfire.com/linux/rk356x/Ai/zh/latest/lubancat_ai/env/rkllm.html)：该章已更新到另一版本，不与本次固定的 1.1.4 混用。
- [瑞芯微 RKLLM 1.1.4](https://github.com/airockchip/rknn-llm/tree/release-v1.1.4)：运行库、头文件和示例源码。
