# 鲁班猫 4 端侧 AI 工作区

2026-10-28 更新：RKLLM 转换工具与板端运行库已升级到 **1.3.1**，Python **3.10.12**。双击 **打开RKLLM转换环境.cmd** 进入转换环境；操作与验证范围见 [RKLLM 转换说明](docs/08-rkllm-toolkit.md)。

入口：[开始使用](docs/START-HERE.md)。资料：[配套教程](downloads/README.md)、[原理图](downloads/hardware/README.md)。

Coloop 协调开发：RK 本地分析、Agent 安全选项回复与请求级日志隐私保护，见 [Coloop 与 RK 协调说明](docs/17-coloop-coordination.md)。

2026-10-30：RK Agent 已将模型差异集中为独立 profile，启动、桥接、记忆和桌面入口可共用不同 RKLLM 模型；默认仍为 Qwen3.5-4B。Qwen 8B 接入示例、运行库/上下文约束与实机验收边界见本机独立仓库的 `rk-opencode/model-profiles/README.md`（该子仓库不随父仓库分发）。

2026-10-30：Coloop 0.9.0 新增 OpenCode 原生消息/工具/审批 Hook、隔离上下文与 RK 快审，接入和性能验收见 [原生 Hook 专题](docs/18-coloop-hooks.md)。

2026-10-30：Coloop 0.10.0 已实现 RK 审批后的实际单次快照读取，真实 Agent 返回未知文件验证串；受控配置固定本地模型、路径与签名边界。入口和限制见 [受控审批](docs/20-coloop-managed-approvals.md)，固定题集及原始测试结果见 [评测报告](docs/19-coloop-managed-approval-evaluation.md)。

2026-10-30：0.10.1消费缓存撤销及完整实际批次通过：36/36支持场景完成审批闸门，20次审批P95 2.703秒；Agent最终任务34/36，完整隐私观察与4个未支持路由另列。Linux策略127/128及真实fd27/27，失败和限制均保留在上述报告。

Qwen3.5-4B：双击 **运行Qwen3.5-4B.cmd** 或 **看图Qwen3.5-4B.cmd**；独立部署目录、量化限制和实测结果见 [4B 部署说明](docs/11-qwen35-4b.md)。

2026-10-29：Qwen3.5-4B / 9B 日常入口的默认上下文调整为 **16K（16384 token）**，可选 512～16384；依据与验证见 [上下文配置说明](docs/16-qwen35-context.md)。原公开同题评测继续固定 2048。

公开同题测试：电脑官方原始 BF16 与端侧 W8A8 均已完成 CMMLU 固定 48 题，双方均为 33/48；逐题差异及限制见 [双端对照报告](docs/14-qwen35-board-comparison.md)。可双击 **测试Qwen3.5-4B对照集.cmd** 重新测试。

扩大评测：已完成 **C-Eval 全部 52 科、固定抽样 260 题** 的双端测试，电脑 BF16 为 187/260（71.92%），板端 W8A8 为 200/260（76.92%）；数学子集分别为 14/25、12/25。来源、逐题记录、执行限制及离线板端复现包见 [C-Eval 对照报告](docs/15-qwen35-ceval260.md)。根目录新增 **测试板端Qwen3.5-4B-C-Eval.cmd** 和 **测试电脑Qwen3.5-4B-C-Eval.cmd**。

项目管理：[Git 使用与文件管理](docs/PROJECT-MANAGEMENT.md)。版本变化记录：[CHANGELOG.md](CHANGELOG.md)。

可视化管理：双击项目目录里的 **打开Git管理.cmd**，即可查看修改、提交和历史。

## 实机状态（2026-10-27）

- 已烧录并启动野火 Ubuntu 22.04.5 Server，Linux 6.1.84，SSH 登录通过。
- 实机型号：Embedfire LubanCat-4 V1，16GB 内存、128GB eMMC。
- 板端：Python 3.10、Lite2 2.3.2、RKNN Runtime 2.3.2、RKNPU 驱动 0.9.8。
- 官方 ResNet18 已实际使用 NPU 推理：space shuttle，分数 0.999680。
- Windows Python 3.12、ONNX Runtime、OpenCV、SSH 工具已配置并通过依赖检查。
- WSL Ubuntu 22.04.5、Python 3.10、PyTorch 2.4.0 CPU、RKNN-Toolkit2 2.3.2 已安装；ONNX 转换及板端数值对比通过。

重启后 USB 自动恢复连接，NPU 数值测试再次通过。完整状态见 `logs/environment-status.json`。

板端工程：`/home/cat/rk-edge-ai`。Windows：`D:\RK`。WSL：`/mnt/d/RK`。

## 日常入口

在本项目 PowerShell 终端中：

```powershell
# 开发板 NPU 图片分类
powershell -ExecutionPolicy Bypass -File scripts/board.ps1 -Action resnet
# 登录开发板
powershell -ExecutionPolicy Bypass -File scripts/board.ps1 -Action shell
# 打开电脑端转换环境
powershell -ExecutionPolicy Bypass -File scripts/open-ai.ps1
```

SSH 用户 `cat`，镜像默认密码 `<RK_BOARD_PASSWORD>`；密码未写入连接配置。
保持供电和 USB 连接；正常开机时不按 MR 键。

## 文件与复现

| 位置 | 用途 |
|---|---|
| `scripts/setup-host.ps1` | 重建 Windows 环境 |
| `scripts/setup-wsl.ps1` | 安装 Linux RKNN 转换环境 |
| `scripts/setup-board.sh` | 安装板端依赖 |
| `scripts/run-board.sh` | 板端检查和模型测试 |
| `tools/convert.py` | ONNX 转 RK3588 RKNN |
| `tools/board_remote.py` | 校验板子 SSH 指纹、上传和执行验证 |
| `tools/prepare_ai_bundle.py` | 下载校验 SDK 子集、准备部署包 |
| `deployment/board/` | 板端安装包、模型、运行库和头文件 |
| `downloads/sdk/rknn-2.3.2/manifest.json` | SDK 来源与校验值 |
| `config/board.json`、`config/ssh_config` | 本机连接信息 |
| `flash/flash-plan.json` | 镜像来源、烧录和启动结果 |
| `logs/` | 安装、转换与 NPU 测试记录 |

SDK 固定为官方 v2.3.2 提交 `42aa1d426c0a9e0869b6374edba009f7208a1926`。
板端安装了镜像原本缺少的 `/usr/lib/librknnrt.so`，部署包保留同版本副本。

## 官方来源

- [野火烧录说明](https://doc.embedfire.com/linux/rk3588/quick_start/zh/latest/quick_start/flash1_img/flash1_img.html)
- [野火 RKNN 教程](https://doc.embedfire.com/linux/rk356x/Ai/zh/latest/lubancat_ai/env/toolkit2.html)
- [Rockchip RKNN 2.3.2](https://github.com/airockchip/rknn-toolkit2/tree/v2.3.2)

本项目当前配置常规视觉模型的 RKNN 路线。大语言模型使用独立 RKLLM 工具链，按具体模型另配。
