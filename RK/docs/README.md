# 鲁班猫 4 端侧 AI 配套资料包

整理日期：2026-10-26。适用：Windows 电脑 + WSL Ubuntu + 鲁班猫 4 系列官方 Linux 镜像。

这份资料可以离线阅读；官方 PDF 手册、配套源码及一个 RK3588 测试模型已保存到 [downloads 资料目录](../downloads/README.md)，下载数量和大小见其中的下载汇总。新增[原理图与硬件资料](../downloads/hardware/README.md)。系统镜像和 RKDevTool 3.37 已下载并完成烧录，当前使用说明见 [开始使用](START-HERE.md)。

想理解模型部署的底层原理，可先读 [学习路线](学习路线.md)：从指针与内存、张量布局、Transformer、量化数学，学到模型编译、Runtime/驱动和性能分析，再接入完整部署；附五张配图和三个可运行的 NumPy 小实验。

## 按这个顺序准备

| 顺序 | 资料 | 帮你完成什么 |
|---|---|---|
| 1 | [硬件与配件清单](01-hardware.md) | 确认板型，准备电源、散热、网线等 |
| 2 | [官方资料与下载入口](02-downloads.md) | 找镜像、烧录工具、教程和 SDK |
| 3 | [接线、烧录与首次启动](03-first-boot.md) | 启动 Linux，连接 SSH，收集板端信息 |
| 4 | [AI 开发路线与验收](04-ai-workflow.md) | 从环境自检走到静态图、摄像头推理 |
| 5 | [常见问题](05-troubleshooting.md) | 排查安装、连接、转换与 NPU 问题 |
| 6 | [设备与实验记录模板](06-device-record.md) | 保存板型、镜像、版本和性能结果 |
| 7 | [运行 DeepSeek](07-deepseek.md) | 使用现成的 1.5B 模型进行本地 NPU 问答 |
| 8 | [部署 Qwen3.5-9B](09-qwen35.md) | 9B W8A8 文字模型和 FP16 视觉编码器的独立部署与验收 |
| 9 | [部署 Qwen3.5-4B](11-qwen35-4b.md) | 4B W8A8 独立部署、量化限制与同题复测 |
| 10 | [Qwen3.5-4B 多任务评测](12-qwen35-evaluation.md) | 基础任务、公开 CMMLU 非数学子集与数学对照的 48 次实测 |
| 11 | [电脑原始权重基线与公开同题测试](13-qwen35-pc-baseline.md) | 官方 BF16 原始模型、固定 CMMLU 48 题及后续板端复现入口 |
| 12 | [端侧与电脑 48 题对照](14-qwen35-board-comparison.md) | 双端均 33/48，逐题差异、分科结果与测试边界 |
| 13 | [C-Eval 260 题双端对照](15-qwen35-ceval260.md) | 全部 52 科，板端 200/260、电脑 187/260，分科结果及复现入口 |
| 14 | [Qwen3.5 上下文配置](16-qwen35-context.md) | 4B / 9B 的 16K 日常默认值、模型转换上限与实机验证 |

## 当前状态与下一步

2026-10-27 已完成系统烧录、WSL 转换环境和板端 NPU 环境。
官方 ResNet18 已运行成功；电脑转换的数字测试模型也已在 NPU 通过数值比较。
2026-10-28 已增加 DeepSeek-R1-Distill-Qwen-1.5B 的板端 RKLLM 环境，现成模型已通过中文问答测试。
按 [开始使用](START-HERE.md) 运行测试、登录板子或转换自己的模型。
后续教程内的清单作为新项目参考，实际完成情况以项目 README 和 logs 记录为准。

## 先理解这几个名字

| 名称 | 在本项目中的用途 |
|---|---|
| WSL | Windows 上运行 Linux 的环境 |
| Ubuntu | WSL 中的 Linux 系统；开发板也可使用另一个独立的 Ubuntu 系统 |
| ONNX | 常见模型交换格式，是模型转换的输入 |
| RKNN-Toolkit2 | 在 Linux 主机上把模型转换为 RKNN，并进行量化等操作 |
| RKNN-Toolkit-Lite2 | 在开发板上用 Python 调用 RKNN 模型 |
| librknnrt.so | 板上 NPU 推理所用的用户态运行库 |
| RKNPU 驱动 | 板上 Linux 内核中负责 NPU 硬件的驱动 |
| RKLLM | 大语言模型使用的另一套 SDK；已配置 1.1.4 板端运行环境，电脑转换工具尚未安装 |

开发入门的目标是“模型在 NPU 上正确运行”。先用已有模型推理，再考虑训练自己的模型。
