# Qwen3.5-4B：C-Eval 260 题双端对照

2026-10-29，双端各完成 260 题，共 520 次作答。协议及题集在推理前固定。

## 参评模型

| 项目 | 电脑参考模型 | 板端部署模型 |
|---|---|---|
| 模型与参数规模 | Qwen3.5-4B，4B | Qwen3.5-4B，4B |
| 语言部分精度 | 官方原始 BF16，无整数化量化 | 社区预转换 W8A8，8 位权重、8 位激活 |
| 来源 | `Qwen/Qwen3.5-4B` | `Qengineering/Qwen3.5-4B-rk3588` |
| 运行环境 | 电脑 GPU / CPU / 磁盘分配 | 鲁班猫 4 / RK3588S 三核 NPU，RKLLM Runtime 1.3.0 |
| 本轮任务 | 纯文字选择题 | 纯文字选择题，未使用 FP16 视觉编码器 |

两端均为 4B 参数规模。本轮明确使用 2048 上下文预算、关闭思考、最多输出 128 token；后续日常启动默认上下文调整为 16K，不改变这份历史测试记录。模型来源、缓存和后端差异见下文协议与限制。

## 实际结果

| 题组 | 电脑官方原始 BF16 | 板端社区 W8A8 |
|---|---:|---:|
| 总计 | **187/260（71.92%）** | **200/260（76.92%）** |
| 理工 | 70/100（70.00%） | 72/100（72.00%） |
| 社会科学 | 41/50（82.00%） | 42/50（84.00%） |
| 人文 | 43/55（78.18%） | 47/55（85.45%） |
| 其他 | 33/55（60.00%） | 39/55（70.91%） |

另按数学与高难科目筛选；Hard 与其他分组重叠，不能与它们相加。

| 子集 | 电脑 BF16 | 板端 W8A8 |
|---|---:|---:|
| 数学 | 14/25（56.00%） | 12/25（48.00%） |
| 非数学 | 173/235（73.62%） | 188/235（80.00%） |
| 官方 Hard 科目抽样 | 24/40（60.00%） | 23/40（57.50%） |

本轮板端总分高 5.00 个百分点：非数学多命中 15 题，数学少命中 2 题。数学在两端都相对薄弱；每科仅五题，分科结果用于定位线索，不足以稳定排名科目能力。结果支持继续评估现有端侧部署，不能推出量化使模型变强或已经证明量化无损。两端后端、缓存和转换输入版本尚未完全受控。

两端 **230/260（88.46%）** 题输出相同，30 题不同。按原标注：两端都命中 180 题；仅电脑命中 7 题；仅板端命中 20 题；两端都未命中 53 题，其中三题错误选项不同。

## 执行完整性与资源

- 双端均核对全部 260 个题号、提示、原答案及题集 SHA256，每科恰好五题，无漏题或重复。
- 正式运行的 520 个输出均为合法单个大写选项；电脑全部以 EOS 正常结束，无输出截断或超时。板端 260 个进程全部正常退出，无温度中止或超时。
- 板端测试过程耗时合计 3055.91 秒（约 50.93 分钟），单题中位数 11.66 秒，包含每次模型加载、推理和监测开销；最高温度 54.538℃，最大进程 RSS 约 4.729GiB。
- 电脑生成耗时合计 1562.019 秒（约 26.03 分钟），中位数 5.2655 秒；显存分配峰值约 4.185GiB，生成时进程 RSS 峰值约 1.454GiB，可用系统内存最低约 2.989GiB。
- 两种耗时口径不同，不能据此直接比较 GPU 与 NPU 的硬件速度。结束后检查，板端没有遗留 Qwen 推理进程，可用内存约 15.2GiB。

原始记录：

- [电脑逐题记录](../logs/qwen35-pc-bf16-20261029-122319/summary.json)、[电脑完整性及资源](../logs/qwen35-pc-bf16-20261029-122319/integrity-and-resources.json)
- [板端逐题记录](../logs/qwen35-4b-ceval260-20261029-121956/summary.json)、[板端完整性及资源](../logs/qwen35-4b-ceval260-20261029-121956/integrity-and-resources.json)
- [分科计分](../logs/qwen35-4b-ceval260-20261029-121956/scores.json)、[双端逐题差异与正误转换](../logs/qwen35-4b-ceval260-20261029-121956/comparison.json)
- [本轮索引](../logs/qwen35-ceval260-latest.json)


## 题集来源与抽样

采用 [C-Eval 官方数据集](https://huggingface.co/datasets/ceval/ceval-exam)，论文为 [C-Eval: A Multi-Level Multi-Discipline Chinese Evaluation Suite for Foundation Models](https://arxiv.org/abs/2305.08322)，发表于 NeurIPS 2023。原来的 CMMLU 也是正式公开基准；本轮增加另一套来源、覆盖全部科目，减少对少量题目的依赖。

- 使用有公开答案的 **val 验证集**，总体 1,346 题；不使用供示例使用的 dev，也不把验证集称作隐藏测试集。
- 按科目英文名排序，用 Python `random.Random(42)`，每科随机抽五题，共 **52 科 × 5 = 260 题**。每科权重相同。
- 未按模型输出过滤、删除或修正题目。题号、原题、选项、原标注、抽样索引和源文件 SHA256 均保留。
- 四大类：理工 STEM 100 题、社科 50 题、人文 55 题、其他 55 题。
- 数学为高等数学、概率统计、离散数学、高中数学、初中数学，共 25 题；非数学 235 题。“非数学”仍可能包括物理或会计计算题。
- 按官方八个高难科目定义的 Hard 子集共 40 题；该子集包含数学、物理和化学。
- 数据集提交：`617524a00b307ff6f9933702f724131fe12ca7ce`；科目映射来自官方仓库提交 `cba65ae93bcf189149ced9f66ae0c958201faed9`。
- 题集：[ceval-val-all52-seed42-260.json](../tools/evalsets/ceval-val-all52-seed42-260.json)，SHA256 `7a915526ab87b69ab0811710d1567727ad31698a2ab50397aeaafd546421985c`。
- C-Eval 数据遵循 CC BY-NC-SA 4.0。来源署名：Yuzhen Huang 等，C-Eval，NeurIPS 2023；抽样文件保留出处与授权信息。

## 固定测试协议

使用相同中文提示，零样本、关闭思考，只输出 A/B/C/D。最多输出 128 token，2048 上下文预算。推理前用官方 tokenizer 检查全部提示：最长 334 token，未截断题目。完整记录见 [输入检查](../logs/ceval260-input-audit.json)。

电脑继续使用上一轮的官方原始 BF16 权重、贪心解码、无缓存路径、GPU/CPU/磁盘分配；每题独立提示，模型常驻。板端继续使用独立目录 `qwen35-4b` 的社区 W8A8、RKLLM 1.3.0、三核 NPU，`top_k=1`，每题重新启动进程，无跨题历史。

电脑本轮起始两次在第一题读取磁盘权重时发生 Windows 原生访问异常（`torch_cpu.dll`，`0xc0000005`）；堆栈指向 Accelerate 的 safetensors mmap 读取，未产生答案，均不计分。两份权重文件 SHA256 与原下载记录一致。评测工具为磁盘权重读取选择 safetensors 支持的 `pread` 后，从第一题完整重启；没有替换权重、修改 dtype 或合并崩溃运行的结果。此选项记在 `settings.offload_read_backend`，Windows 默认使用 `pread`，可用 `--offload-read-backend` 显式指定。该读取方式的区别见 [官方 API](https://huggingface.co/docs/safetensors/api/torch)。

严格去掉首尾空白后，完整输出必须等于原答案字母才算命中。无效输出、异常退出、超时及温度中止另行记录，不把解释中出现正确字母算命中，也不修改官方答案。每题完成即保存结果。

这是固定分层抽样的同题运行对照。它不是完整 C-Eval 验证集或官方隐藏测试榜单分数。原始权重提交与社区转换输入未核实完全一致，推理后端及缓存实现不同，因此分差不能单独归因于量化。选择题结果也不能替代自由问答、指令遵循和实际业务测试。

## 复现入口

先保持开发板供电和 USB 连接。根目录新增：

- `测试板端Qwen3.5-4B-C-Eval.cmd`
- `测试电脑Qwen3.5-4B-C-Eval.cmd`

也可以执行：

```powershell
.\.venv\Scripts\python.exe tools/eval_qwen35.py --board-subdir qwen35-4b --dataset tools/evalsets/ceval-val-all52-seed42-260.json
.\.venv-qwen-pc\Scripts\python.exe tools/eval_qwen35_pc.py --no-cache --dataset tools/evalsets/ceval-val-all52-seed42-260.json
```

两个命令分别使用开发板和电脑，可并行运行；每端只开一个评测进程。每次生成新的时间戳日志目录，不覆盖旧结果。

如需脱离电脑，在板上独立重跑，可把 [板端离线评测包](../deployment/qwen35-ceval260-test.zip) 解压到 `/home/cat/rk-edge-ai/qwen35-4b/`，再在该目录运行 `python3 eval-ceval260/eval_qwen35_board.py --dataset eval-ceval260/ceval-val-all52-seed42-260.json`。只依赖 Python 标准库和已有模型环境；当前这一轮使用电脑 SSH 控制器逐题调起板端推理，离线包是另外的复现入口。

重建题集需要工具环境安装 `requirements-eval-data.txt`，再运行 `tools/prepare_ceval_eval.py`。数据源使用固定提交，脚本按固定顺序抽样；生成后的 SHA256 应与上述记录一致。

## 全部 52 科结果

每科五题，按原始答案计分。

| 科目 | 电脑 BF16 | 板端 W8A8 |
|---|---:|---:|
| 注册会计师 | 4/5 | 4/5 |
| 高等数学 | 2/5 | 2/5 |
| 艺术学 | 4/5 | 4/5 |
| 基础医学 | 3/5 | 3/5 |
| 工商管理 | 4/5 | 5/5 |
| 中国语言文学 | 4/5 | 5/5 |
| 公务员 | 1/5 | 1/5 |
| 临床医学 | 3/5 | 3/5 |
| 大学化学 | 2/5 | 3/5 |
| 大学经济学 | 4/5 | 4/5 |
| 大学物理 | 4/5 | 4/5 |
| 大学编程 | 3/5 | 5/5 |
| 计算机组成 | 3/5 | 3/5 |
| 计算机网络 | 4/5 | 5/5 |
| 离散数学 | 3/5 | 2/5 |
| 教育学 | 4/5 | 4/5 |
| 注册电气工程师 | 5/5 | 5/5 |
| 环境影响评价工程师 | 3/5 | 3/5 |
| 注册消防工程师 | 2/5 | 4/5 |
| 高中生物 | 3/5 | 3/5 |
| 高中化学 | 5/5 | 5/5 |
| 高中语文 | 3/5 | 3/5 |
| 高中地理 | 5/5 | 5/5 |
| 高中历史 | 4/5 | 5/5 |
| 高中数学 | 1/5 | 1/5 |
| 高中物理 | 4/5 | 4/5 |
| 高中政治 | 3/5 | 4/5 |
| 思想道德修养与法律基础 | 5/5 | 5/5 |
| 法学 | 3/5 | 4/5 |
| 法律职业资格 | 4/5 | 4/5 |
| 逻辑学 | 4/5 | 4/5 |
| 毛泽东思想和中国特色社会主义理论体系概论 | 3/5 | 3/5 |
| 马克思主义基本原理 | 5/5 | 4/5 |
| 注册计量师 | 3/5 | 3/5 |
| 初中生物 | 4/5 | 4/5 |
| 初中化学 | 5/5 | 5/5 |
| 初中地理 | 4/5 | 4/5 |
| 初中历史 | 5/5 | 5/5 |
| 初中数学 | 5/5 | 5/5 |
| 初中物理 | 4/5 | 4/5 |
| 初中政治 | 5/5 | 5/5 |
| 近代史纲要 | 4/5 | 5/5 |
| 操作系统 | 3/5 | 3/5 |
| 医师资格 | 5/5 | 5/5 |
| 植物保护 | 3/5 | 4/5 |
| 概率统计 | 3/5 | 2/5 |
| 导游资格 | 3/5 | 3/5 |
| 体育学 | 4/5 | 4/5 |
| 税务师 | 1/5 | 3/5 |
| 教师资格 | 4/5 | 4/5 |
| 注册城乡规划师 | 4/5 | 5/5 |
| 兽医学 | 4/5 | 4/5 |

## 不同选项的 30 题

| 题号 | 原标注 | 电脑 | 板端 |
|---|---|---|---|
| `advanced_mathematics-3` | A | A | B |
| `advanced_mathematics-18` | B | C | B |
| `basic_medicine-7` | D | A | D |
| `basic_medicine-16` | D | D | A |
| `business_administration-28` | C | D | C |
| `chinese_language_and_literature-5` | C | A | C |
| `civil_servant-9` | D | A | B |
| `college_chemistry-3` | B | A | D |
| `college_chemistry-17` | C | A | C |
| `college_programming-14` | C | A | C |
| `college_programming-18` | C | A | C |
| `computer_network-6` | C | B | C |
| `discrete_mathematics-2` | D | C | D |
| `discrete_mathematics-5` | D | D | A |
| `discrete_mathematics-11` | A | A | C |
| `fire_engineer-28` | B | C | B |
| `fire_engineer-29` | A | D | A |
| `high_school_history-16` | A | B | A |
| `high_school_mathematics-9` | C | B | C |
| `high_school_mathematics-13` | D | D | C |
| `high_school_politics-1` | C | A | C |
| `law-5` | D | B | D |
| `law-8` | A | D | B |
| `marxism-11` | D | D | A |
| `modern_chinese_history-17` | C | D | C |
| `plant_protection-1` | A | C | A |
| `probability_and_statistics-1` | A | A | B |
| `tax_accountant-11` | B | A | B |
| `tax_accountant-29` | D | C | D |
| `urban_and_rural_planner-5` | B | C | B |
