# Qwen3.5-4B / 9B 上下文配置

2026-10-29。日常文字和看图入口的默认上下文改为 **16384 token（16K）**，允许填写 **512～16384**。最多输出仍默认 128 token，关闭思考；这些参数分别控制上下文预算、输出上限和思考模式。

## 范围的来源

旧入口在 `tools/qwen35_main.cpp` 和 `scripts/qwen35.ps1` 中人为设置默认 2048、校验范围 512～4096。这是早期部署的保守设置，没有实测出“开发板最大只能使用 4096”。

固定版本的上游 [9B 示例](https://github.com/Qengineering/Qwen3.5-9B-NPU/blob/304aaaa1c1b6c70bcea2c3df37572e828994fe0a/src/main.cpp#L18) 与 [4B 示例](https://github.com/Qengineering/Qwen3.5-4B-NPU/blob/df7a244d43de018d6f2eec11cab6b6967039eacd/src/main.cpp#L18) 均向 `LoadModel` 传入 16384。更直接的依据是板端加载现有两份 `.rkllm` 文件时都报告：

```text
rkllm-toolkit version: 1.3.0, max_context_limit: 16384,
npu_core_num: 3, target_platform: RK3588, model_dtype: W8A8
```

因此本次把应用上限对齐到当前转换文件报告的 **16384**。最低 512 仍是本应用的参数校验设置，不表示模型或硬件只能从 512 开始使用。上下文必须大于输出上限。

原模型规格、转换文件上限、启动时设置和实际处理的 token 数是不同数据。设置 16384 不会把短问题补齐到 16K，也不证明所有 16K 长文本任务都能正确完成。输入、保留的对话历史、模板和生成内容共同使用上下文；图片还涉及视觉 token。

## 已更新的入口

- `scripts/qwen35.ps1`：4B / 9B 默认 16384，校验范围 512～16384。
- `tools/qwen35_main.cpp`：统一的 C++ 入口，板上直接运行也默认 16384；启动时打印 `CONFIG context=... max_new_tokens=...`。
- `tools/build_qwen35_bundle.py`：重建两个部署包时保留相同默认值和范围，并记录到来源清单。
- `tools/smoke_qwen35.py`：新增 `--context`，保存实际请求值；它的默认值仍为 2048，以保留现有评测协议。

根目录的运行、看图 `.cmd` 都调用上述 PowerShell 入口，无需分别修改。

```powershell
# 4B / 9B 的日常默认值均为 16K
powershell -ExecutionPolicy Bypass -File D:\RK\scripts\qwen35.ps1 -ModelSize 4B
powershell -ExecutionPolicy Bypass -File D:\RK\scripts\qwen35.ps1 -ModelSize 9B

# 有需要时可主动缩小上下文
powershell -ExecutionPolicy Bypass -File D:\RK\scripts\qwen35.ps1 -ModelSize 4B -ContextLength 8192

# 明确指定 16K 的单次板端检查
.\.venv\Scripts\python.exe tools\smoke_qwen35.py --board-subdir qwen35-4b --context 16384 --prompt 'What is 2+3? Answer only the digit.' --tokens 24
```

## 评测复现

现有 CMMLU / C-Eval 评测继续明确使用 2048；历史结果、模型权重和运行库未因日常默认值调整而替换。日常默认值改大不能用来推断历史分数会提高。

RKLLM 1.3.1 对照应用 `qwen35-4b-131` 仍保留自己的历史配置；本次更新的日常应用为 `qwen35-4b` 与 `qwen35`。

## OpenCode 的 Qwen 接入

独立仓库 `rk-opencode` 的 Qwen3.5-4B profile 同步改为默认 16384：`scripts/profile.sh`、Python HTTP 服务的 profile 默认值和 `opencode-qwen.json` 的模型声明保持一致。启动健康检查同时核对模型和上下文，避免错误沿用旧的 4096 常驻进程。该服务现有 worker 的参数校验范围为 1024～16384，最低 1024 同样是该应用的设置。

DeepSeek profile 仍为 4096，因为它的旧转换文件实际报告 4096 上限。两个 profile 按各自模型处理，不能把 DeepSeek 的限制套到 Qwen。

OpenCode 适配层仍按 UTF-8 字节数保守控制请求预算，因此可接受的实际文本可能小于 16K token；本次没有声称已实现精确 token 预算。重新打开 OpenCode 窗口可确保读取新的模型声明，常驻模型服务则已按新配置重启并检查健康状态。

## 实机验证

验证原始记录：`logs/qwen35-context16k-20261029-132235/`。运行状态、实际预填充 token 数、内存和回答质量分别记录，完整结果见该目录的 `summary.json`。

本次使用独立构建目录 `build-context16384` 验证新程序，完成验证后再更新日常 `build/qwen35`。仅替换应用可执行文件与来源清单，保留旧可执行文件备份，不上传或覆盖模型权重和运行库。

| 应用与检查 | 实际预填充 token | 最大 RSS（GiB） | 回答核对 |
|---|---:|---:|---|
| 4B 短问答 | 24 | 5.168 | `2+3` 回答 `5`，正确 |
| 4B 长输入 | 3190 | 5.169 | 找回开头的 `BLUE`，且只输出该词 |
| 4B 单张图片 | 222 | 5.877 | 描述宇航员、月球、绿色瓶子和地球 |
| 9B 短问答 | 24 | 8.649 | 输出无关字符，未通过 |
| 9B 长输入 | 3190 | 8.652 | 找回 `BLUE`，但多输出解释，严格格式未通过 |
| 9B 单张图片 | 222 | 9.591 | 描述月球上的宇航员 |

六个 16K 配置检查均正常退出，未发生交换，最高监测温度约 54.54℃。这是配置与少量推理验证，没有进行填满 16K 的长文本准确率或持续负载测试。

9B 另用旧的 2048 设置和原可执行文件运行完全相同的短问题，输出与 16K 的异常字符完全一致。此次调整未解决该模型已有的文本异常，也没有据此把“进程通过”记录为“回答正确”。同题对照见 `summary.json` 的 `baseline_comparison`。

命令行在加载前拒绝 511 和 16385 的边界检查通过。两个部署包与规范入口一致，板端安装的可执行文件与本轮已测试构建逐字节相同；备份路径和安装摘要见 `deployment.json`。OpenCode 协议用例在主机和板端均通过，覆盖超过旧 4K 的请求和超过新预算时的明确拒绝。

OpenCode 常驻服务的 `/health` 已返回 `model=qwen35-4b-rkllm`、`context=16384`，客户端文件同样声明 16384。真实 API 短题正确回答 `5`；长输入为 13626 UTF-8 字节，运行库实际处理 3200 token，正确回答 `BLUE`，约 60.74 秒。这个请求在旧的 4096 保守字节预算下会被拒绝；3200 本身没有超过 4096 token，不能混为一谈。结果见 `opencode-live.json`，服务文件备份与摘要见 `opencode-deployment.json`。
