# Qwen3.5-4B 电脑原始权重基线与 CMMLU 同题测试

后续已扩大到 C-Eval 全部 52 科、260 题：电脑 187/260，板端 200/260。完整结果及本轮文件读取异常的处理见 [C-Eval 双端报告](15-qwen35-ceval260.md)。本文保留原 CMMLU 48 题的环境与复现记录。

日期：2026-10-29。电脑端已完成一轮；端侧现已使用同一题集完成复测，双方均为 33/48，详见 [端侧与电脑对照](14-qwen35-board-comparison.md)。

## 本轮结果

使用官方原始 Qwen3.5-4B 权重，在电脑上以 BF16 推理，没有重新做整数化量化。

| 科目 | 与原始答案一致 |
|---|---:|
| 小学语文 | 3/6 |
| 小学常识 | 5/6 |
| 中国历史 | 6/6 |
| 世界历史 | 6/6 |
| 中国文学 | 3/6 |
| 计算机科学 | 4/6 |
| 小学数学 | 3/6 |
| 高中数学 | 3/6 |
| 总计 | **33/48（68.75%）** |

数学科目合计 6/12，其他科目合计 27/36。全部 48 次输出都是单个合法选项字母，正常生成结束，没有截断或时间中止。计分严格比较原始选项字母，未根据模型输出修改标准答案或删除题目。

这只是固定抽样子集，不是完整 CMMLU 分数，不能直接与榜单比较。其中 `elementary_chinese-28` 的“岁寒三友”题同时给出兰和菊两个不属于松竹梅的选项，存在歧义；原标注 C 与电脑输出 B 不同。本轮保留原标注计分，不将所有标注差异都视作已经独立确认的模型错误。

逐题记录：[summary.json](../logs/qwen35-pc-bf16-20261029-004006/summary.json)。自动分科计分：[scores.json](../logs/qwen35-pc-bf16-20261029-004006/scores.json)。原始控制台日志：`logs/qwen35-pc-cmmlu48-controller.txt`。

## 公开测试集与抽样

- 来源：[CMMLU 官方仓库](https://github.com/haonan-li/CMMLU)、[数据集页面](https://huggingface.co/datasets/haonan-li/cmmlu)。
- 固定提交：`d6e7b716d8ac694f38969a6c0407437d1fded799`，使用 `data/test/*.csv` 原始题目、选项与答案。
- 八个科目，每科用 Python `random.Random(42)` 抽六题，共 48 题；抽样在本轮电脑推理前完成。
- 题集：[cmmlu-balanced-seed42-48.json](../tools/evalsets/cmmlu-balanced-seed42-48.json)。内含题号、科目、原题、选项、预期答案、源文件 SHA256 及抽样行号。
- 题集 SHA256：`9f15ce2ee3df5fd92b8136e9360e37012696289dd53a4fb8bcb9714e888cca71`。
- 电脑运行目录另保存了完全相同的 `dataset.json` 快照，后续不要直接修改已有题集；新题目应使用新文件和版本名。

复现抽样：

```powershell
cd D:\RK
.\.venv\Scripts\python.exe tools\prepare_cmmlu_eval.py --profile balanced48
```

## 电脑资源及实际配置

本机为 Ryzen 9 8940HX（16 核 / 32 线程）、约 16GB 系统内存、RTX 5060 Laptop 8GB。开始检查时可用显存约 6GB，内存约 3GB，D 盘约有 78GB 空间。

官方整个检查点约 9.32GB，语言张量本身约 8.41GB / 7.83GiB，另外还需要运行库、缓存和临时空间，因此当前余量无法将语言模型完整放入 GPU。本次使用 GPU + CPU + SSD 卸载：GPU 权重预算 4.5GiB，CPU 权重预算 0.75GiB，其余权重按需从文件读取。没有改变 WSL 内存设置或替换现有 RKLLM 转换环境。

- 独立环境：`D:\RK\.venv-qwen-pc`，Python 3.12.8。
- PyTorch 2.11.0+cu128，CUDA 12.8，原生支持该显卡的 `sm_120`；BF16 矩阵计算自检通过。
- Transformers 5.8.0，Accelerate 1.12.0；完整版本在 `logs/requirements-qwen-pc-resolved.txt`。
- 官方原始模型：[Qwen/Qwen3.5-4B](https://huggingface.co/Qwen/Qwen3.5-4B)，固定提交 `851bf6e806efd8d0a36b00ddf55e13ccb7b8cd0a`。
- 权重和分词器均通过官方仓库对应 SHA256 校验，小型配置文件核对 Git blob 摘要。文件位于 `downloads/qwen3.5-4b-original`。
- 只加载语言部分，排除视觉编码器和 MTP 头；加载前检查全部语言张量名称和形状，加载后验证若干 GPU 张量样本与原始权重逐位相同，并确认输出头与词嵌入绑定。
- 关闭思考、贪心解码，最多输出 128 token，输入加输出不超过 2048 token；使用官方对话模板与停止标记。
- 本机缓存启用路径的试跑出现异常混合输出，已标为无效参考；本轮 **禁用 KV 缓存，逐步重算前缀**。其具体根因尚未定位，不能据此判断模型能力。
- 加载时曾触及内存保护下限。回收本测试进程自身可回收的映射页面后完成测试，没有关闭其他应用。

48 题生成阶段合计约 **219.49 秒**，单题中位数约 4.49 秒。GPU 张量分配峰值约 **4.16GiB**，不含 CUDA 上下文与其他应用占用。运行各题时进程工作集最高约 1.40GiB；加载、回收前工作集约 5.52GiB。这些是本次短题、卸载条件下的观测，不是纯 GPU 性能基准或最低资源保证。

## 在电脑重跑

双击根目录 **测试电脑Qwen3.5-4B对照集.cmd**，或：

```powershell
cd D:\RK
.\.venv-qwen-pc\Scripts\python.exe tools\eval_qwen35_pc.py --no-cache --dataset tools/evalsets/cmmlu-balanced-seed42-48.json
```

每次会创建新的 `logs/qwen35-pc-bf16-<时间>/`，保存逐题原始输出、设置、题集摘要及计分结果。

## 后续板端同题测试

### 从电脑通过 SSH 在板端运行

重新连接并正常启动板子，先退出已经打开的大模型聊天。双击根目录 **测试Qwen3.5-4B对照集.cmd**，或执行：

```powershell
cd D:\RK
.\.venv\Scripts\python.exe tools\eval_qwen35.py --board-subdir qwen35-4b --dataset tools/evalsets/cmmlu-balanced-seed42-48.json
```

板卡密码通过提示输入或 `RK_BOARD_PASSWORD` 环境变量提供。推理实际在板卡进行；题集与原始结果保存在电脑。此路径不依赖提前上传本轮测试包。

每题独立启动现有 4B 程序，2048 上下文、最多 128 输出 token、关闭思考、`top_k=1`。结果位于 `logs/qwen35-4b-cmmlu-balanced48-<时间>/`，自动生成 `summary.json`、`scores.json` 和各题日志。

### 直接在板端终端运行

已准备 [独立测试包](../deployment/qwen35-cmmlu48-test.zip)，包含同一题集、仅依赖 Python 标准库的板端运行器和评分器。这个本地包尚未自动上传；如需直接在板端终端运行，可在连线后自行复制。本次已完成的端侧复测使用上面的电脑 SSH 入口。

在板端解压到 `/home/cat/rk-edge-ai/qwen35-4b/eval/`，然后执行：

```bash
python3 /home/cat/rk-edge-ai/qwen35-4b/eval/eval_qwen35_board.py
```

结果保存在 `/home/cat/rk-edge-ai/qwen35-4b/eval-results/cmmlu-balanced48-<时间>/`。

### 对照两次结果

将板端结果复制回电脑，或直接使用 SSH 运行生成的电脑端日志目录：

```powershell
.\.venv\Scripts\python.exe tools\score_qwen35_eval.py <板端summary.json路径> --reference D:\RK\logs\qwen35-pc-bf16-20261029-004006\summary.json
```

程序会核对题号、提示和原始答案完全相同，再生成分科分数和逐题答案差异 `comparison.json`。

## 结果解释边界

本轮可以作为后续板端的同题参考，但两边的推理后端、缓存路径和精度不同；社区转换所用的原始权重提交也尚未核实。因此分数差不能直接当作“纯量化损失”。本轮使用关闭思考的直接选择，不是原始模型开启长思考时的能力上限。

另一个独立短题验证中，电脑原始权重也把旧买笔题答成“还剩 2 元。”，与板端一致，记录在 `logs/qwen35-pc-bf16-20261029-003611/summary.json`。这说明那道题的错误不能单凭现有证据归咎于社区量化。
