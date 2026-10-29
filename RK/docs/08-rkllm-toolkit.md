# RKLLM 1.3.1 模型转换环境

本环境在电脑的 WSL Ubuntu 22.04 中运行，用于把受支持的原始大语言模型转换成板端使用的 `.rkllm`。板端已升级为 RKLLM Runtime 1.3.1，并重新编译问答应用。

## 教材依据与版本

按用户要求，转换工具与板端运行库均采用官方最新稳定版 **1.3.1**（2026-10-28 核对），满足 `rkllm-toolkit>=1.3.0`、`rkllm-runtime>=1.3.0`、`python>=3.9`。

参考项目内野火 AI 教程的 RKLLM 安装流程，具体 API 和依赖以配套官方 `downloads/rkllm-1.3.1/doc/Rockchip_RKLLM_SDK_CN_1.3.1.pdf` 为准。教程 DeepSeek 旧章节中的 1.1.4 已不作为安装目标。官方本版支持 Python 3.10/3.11/3.12，本项目选择现有的 Python 3.10；用独立 venv 隔离依赖。

| 项目 | 配置 |
|---|---|
| WSL 发行版 | Ubuntu-22.04，x86_64 |
| Python | 3.10 |
| 虚拟环境 | `~/.venvs/lubancat4-rkllm-1.3.1` |
| RKLLM-Toolkit | 1.3.1 |
| PyTorch / torchvision | 2.6.0+cpu / 0.21.0+cpu |
| 模型转换设备 | 电脑 CPU |
| 导出目标 | RK3588，W8A8，3 个 NPU 核 |

PyTorch 版本来自该 Toolkit 安装包的依赖要求。使用 CPU 版本；本次不配置电脑 RTX 5060 的 CUDA 转换。电脑的转换设备与开发板的推理设备是两回事：CPU 转换的结果仍用于板端 NPU。

安装包来自瑞芯微官方仓库固定提交 `f7390530443bf84f0394255a449d7cbe81e69d1c`，位于 `rkllm-toolkit/packages/`。本地副本及来源记录在 `downloads/rkllm-1.3.1/`。安装脚本核对本次从固定官方地址下载文件的 SHA256；该摘要是项目固定值，不是另行获取的发布方签名。

采用官方安装包声明的依赖版本，包括 PyTorch 2.6、Transformers 5.8、Datasets 4.1.1 和 PyArrow 21。完整安装结果见 `logs/requirements-rkllm-resolved.txt`。

## 打开环境

在 Windows 双击项目根目录的 **打开RKLLM转换环境.cmd**。

或在 WSL 中执行：

```bash
cd /mnt/d/RK
source ~/.venvs/lubancat4-rkllm-1.3.1/bin/activate
python tools/check_rkllm.py
```

视觉模型转换仍使用原来的 **打开AI开发环境.cmd**。两者使用独立虚拟环境。

## 验证转换功能

```bash
python tools/check_rkllm.py --conversion
```

该检查生成一个很小的、随机权重的 Qwen2 测试模型，然后在 CPU 上执行加载、W8A8 量化和 `.rkllm` 导出。测试文件保存在 `tmp/rkllm-toolkit-smoke/`，没有实际问答能力，也不部署到开发板。

检查结果在 `logs/rkllm-toolkit-status.json`；这项检查不代表已经完成完整 DeepSeek 1.5B 的转换或板端推理验证。

2026-10-28 验证结果：依赖检查、Toolkit 初始化、测试模型 W8A8 量化与导出均通过。另将导出的测试模型上传到开发板，Runtime 1.3.1 日志确认模型由 Toolkit 1.3.1 生成，完成 NPU 推理并以 0 退出；日志见 `logs/rkllm-1.3.1-end-to-end.txt`。这只验证工具链连通性，随机权重模型的输出没有语义用途。

## 转换自己的模型

需要准备两类材料：

1. 完整的原始 Hugging Face 模型目录，包括 `config.json`、分词器文件和原始权重；现有 `.rkllm` 文件不能代替原始模型。
2. 符合模型任务的量化校准数据，JSON 列表，每条有 `input` 和 `target` 字符串；按模型对话模板准备文本。

在已激活的环境里运行，路径按实际文件修改：

```bash
python tools/convert_llm.py \
  --model /path/to/DeepSeek-R1-Distill-Qwen-1.5B \
  --dataset /path/to/data_quant.json \
  --output models/deepseek-custom-w8a8.rkllm
```

转换器固定使用 CPU、RK3588 和 W8A8。仅适用于 RKLLM 1.3.1 支持的模型架构。选择新的输出文件名，工具会拒绝覆盖已有文件。

当前 WSL 可用内存总量约 7.4 GiB、交换空间约 2 GiB。完整模型转换的内存占用随模型、精度和校准样本而变化；大模型转换前需另行评估，本次不修改 WSL 全局配置。

## 重建环境

在 WSL 执行：

```bash
cd /mnt/d/RK
bash scripts/setup-rkllm.sh
python_path="$HOME/.venvs/lubancat4-rkllm-1.3.1/bin/python"
"$python_path" tools/check_rkllm.py --conversion
```

脚本仅安装电脑端独立转换环境，无需重烧系统。板端问答运行方式仍见 [DeepSeek 部署说明](07-deepseek.md)。

## 旧版清理状态

板端默认 `deepseek/lib/librkllmrt.so` 和本地 `deployment/deepseek/` 的运行库均已被 1.3.1 替换，准备和部署脚本也已改为下载新版 SDK。

2026-10-28 已完成旧工具链清理：永久删除被自动审批阻止后，改用可恢复的回收站方式。以下目录均已从原位置移除：

- WSL：`/root/.venvs/lubancat4-rkllm-1.1.4`（本次被中断的旧环境安装）。
- Windows：`D:\RK\downloads\rkllm-toolkit-1.1.4`。
- Windows：`D:\RK\downloads\deepseek-rkllm-1.1.4\sdk`。

Windows 文件位于 Windows 回收站；WSL 旧环境位于 `/root/.local/share/Trash/files/lubancat4-rkllm-1.1.4-20261028-185304`，对应 `.trashinfo` 保留原位置。此操作可恢复，尚未永久释放这些文件占用的磁盘空间。

清理后，`~/.venvs/` 中的 RKLLM 环境仅剩 `lubancat4-rkllm-1.3.1`，其依赖检查通过。

`downloads/deepseek-rkllm-1.1.4/` 中的 `.rkllm` 模型、模型卡和校验记录继续作为当前模型的来源材料保存；其版本名称不表示正在使用旧 Runtime。
