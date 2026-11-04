# Qwen3.5-4B 更换推理引擎实验

2026-10-31，鲁班猫 4 / RK3588 / 16GB。目标是提高现有 **Qwen3.5-4B** 的解码
tok/s，保持现有 RKLLM 应用、模型、OpenCode/Coloop 默认配置作为回退。

## 路线与资产

| 路线 | 权重格式 | 推理后端 | 实践范围 |
| --- | --- | --- | --- |
| 现有默认 | 社区 W8A8 `.rkllm` | RKLLM Runtime/Header 1.3.0 | 本机基线 |
| 既有独立对照 | 同一份 `.rkllm` | RKLLM Runtime/Header 1.3.1 | 同题对照 |
| 新引擎普通解码 | Qwen3.5-4B W4A8/W8A8 混合量化 safetensors | open_rknpu2_lm_infer v0.10.0 | 本次独立部署 |
| 新引擎 MTP1 | 同上，另带 BF16 MTP 权重和坐标适配 | 同一引擎，draft-mtp / n-max=1 | 本次独立部署 |
| rk-llama.cpp | GGUF，后端可能重新量化 | GGML / RKNPU2 | 本次未安装 |

新引擎是更换用户态程序与量化资产，不是把 `.rkllm` 改扩展名。不能通过修改现有
RKLLM profile 的模型名接入；OpenAI 兼容 API 也不意味着已兼容本项目的鉴权、
metadata-only、原生 KV、记忆调度、工具权限或桌面/HID 验收。

- 引擎来源：<https://github.com/happyme531/open_rknpu2_lm_infer>，固定 release `v0.10.0`，
  AGPL-3.0；发布资产与源码包的大小、SHA256、tag 对象见本机
  `downloads/qwen35-open-engine-v0.10.0/engine-manifest.json`。
- ARM64 二进制归档：5,773,668 字节，SHA256
  `e12576ec8cec7751941568023c3948b8bb22add2794ab28b059fbd57b854c489`。
- 新权重来源：<https://huggingface.co/happyme531/Qwen3.5-4B-W4A8-Mixed-QQQ-Rot>，
  固定 revision `ddb89f693b9773852f4ee5a496b4f124a6e28613`，Apache-2.0，
  固定离线残差旋转 + QQQ、W4A8/W8A8 混合量化；包含视觉、MTP 和 tokenizer。
  上游原始模型版本记录在该权重的 `source_provenance.json`。
- 全部顶层模型资产的大小、SHA256 见
  `downloads/qwen35-open-engine-v0.10.0/model-manifest.json`。
  LFS 文件按上游 SHA256 验证；小元数据先校验固定 revision 的 Git blob，再登记 SHA256。
- 板端独立目录：从 `config/board.json` 的 `project_dir` 拼接
  `qwen35-4b-open-v0.10.0/`，本机当前为 `/home/cat/rk-edge-ai/qwen35-4b-open-v0.10.0`。
  模型上传使用 `.partial`，板端 SHA256 验证通过后才改为正式文件。

## 复现工具

以下从 `D:\RK` 使用 `.venv\Scripts\python.exe`。联网复用已有进程代理配置，不改系统代理。
板端连接沿用指纹校验，密码只通过本次进程的 `RK_BOARD_PASSWORD` 提供。

```powershell
.\.venv\Scripts\python.exe tools/prepare_qwen35_open_engine.py --stage source
.\.venv\Scripts\python.exe tools/prepare_qwen35_open_engine.py --stage models --workers 8
.\.venv\Scripts\python.exe tools/deploy_qwen35_open_engine.py --stage runtime
.\.venv\Scripts\python.exe tools/deploy_qwen35_open_engine.py --stage models
```

`source` 下载并安全解包固定源码和运行程序；`models` 下载约数 GB 权重并校验。
部署仅写独立应用目录，不安装系统依赖、不替换全局运行库、不启动 HTTP 服务。

开始推理前先核对其他任务、NPU 占用与推理锁。benchmark 不会停止既有服务；已驻留服务
持有模型锁时拒绝运行。其他任务的服务只能在获得任务授权后通过原停止脚本释放，并在实验后恢复。

```powershell
# 每次使用新目录；prepare 只生成/上传计划，不进行推理。
.\.venv\Scripts\python.exe tools/bench_qwen35_open_engine.py --stage prepare --suite smoke --include-131 --context 4096
# 按上一步输出目录执行；run/fetch 必须显式指定同一目录。
.\.venv\Scripts\python.exe tools/bench_qwen35_open_engine.py --stage run --output-dir logs/<上一步目录>
.\.venv\Scripts\python.exe tools/bench_qwen35_open_engine.py --suite tune --context 4096
.\.venv\Scripts\python.exe tools/bench_qwen35_open_engine.py --suite timing --include-131 --context 4096 --repetitions 2
```

本次正式计划固定相同用户 prompt、4K 上下文、贪心解码、关闭思考，输出上限24/64（短题）或128
（计时题）。每个子进程独立冷 KV，记录全部实际输出；英文、中文、较长输入分别计时。
第二次重复反转引擎顺序，降低固定顺序的温度偏差。新引擎按模型 chat template 包装；
现有 RKLLM 使用权重内模板，因此不是同一转换输入或严格同 token 序列的内核 A/B。

`tune` 对1、2、128行搜索策略，缓存仅放独立应用的 `benchmark-cache/`。
所有推理和调优均串行、单子进程最长600秒、80℃或可用内存低于512MiB中止，
只终止本实验创建的进程组。不改频率、不向模型注册工具。
独占窗口协调器仅向Mem0服务登记/续期自己的前台租约，等待已有整理结束；
不调用recall/enqueue/set，不读写记忆内容。
短题与JSON只检查模型输出，不执行任何生成内容。

每个实验保留 `plan.json`、计划/runner SHA256、原始 stdout/stderr、`time -v`、
每2秒的温度/内存/频率、退出码和结果。RKLLM 记录SDK的 Generate 时间和token数；
新引擎同时记录其原生 decode 指标及 `(completion_tokens-1)/decode_ms` 的完整解码耗时口径。
两套运行库的首token/末token统计边界可能不同；短输出不用于稳定 tok/s 结论。
调优时间、加载时间、首字延迟和解码速度分别报告。

## 本次记录

已固定版本、下载校验并部署新引擎；依赖检查与 `--version` / `--help` 通过。
28个模型资产共4,667,944,797字节，主机与板端全部SHA256一致；
新引擎 `inspect` / `tokenize --conversation` 均退出0；这两项检查没有打开NPU。
原始检查与部署清单：`logs/qwen35-open-setup-20261031-0140/`。
实机支持 DMC 节点，初次读到 DDR 1.848GHz、NPU 1GHz、GPU 1GHz。
这只是瞬时频率，不代表负载期间的完整状态或最优配置。

首次准备的短题计划：`logs/qwen35-open-smoke-20261031-013353/`。
已实际检查原有服务仍持有模型锁，实验在启动任何子进程前被拒绝，
记录见该目录的 `occupied-lock-check.txt`。此记录是占用保护验证，不是模型推理失败。
随后用户明确授权桌面任务结束后暂停模型并恢复。首次执行窗口
`logs/qwen35-open-session-20261031-020049/` 中，1.3.0短题正确；已有1.3.1对照程序
拒绝16K（其旧入口上限4096），实验退出并成功恢复原服务。此失败没有改写或删除。
正式四路比较改为统一4096，计划与执行证据位于
`logs/qwen35-open-session-20261031-020155/`。默认日常16K配置不因本次实验改变。

该窗口的12次短题均正常退出，四种配置各自2/3满足预期：

| 短题 | RKLLM 1.3.0 | RKLLM 1.3.1 | 新引擎普通 | 新引擎MTP1 |
| --- | --- | --- | --- | --- |
| 2+3，只答数字 | `5`，通过 | `5`，通过 | `5`，通过 | `5`，通过 |
| 20元买3支笔、每支4元 | `16`，错误 | `16`，错误 | `16`，错误 | `16`，错误 |
| 随机串与count字段的JSON | 通过 | 通过 | 通过 | 通过 |

新引擎普通与MTP1在这三个短题上的输出逐字一致；不是通用准确率或MTP无损证明。
这些短进程观察到新引擎约100秒的重新加载成本，原应用约12秒；
这包含加载和少量推理，不当成解码tok/s。实际使用需要单独评估常驻服务。
## 正式计时结果

固定4096上下文、关闭思考、贪心、128输出上限，每个负载/后端各重复2次，
下表为中位数，单位tok/s。四路的用户prompt SHA256与上下文逐组一致；
实际prefill token数也分别一致为英文47、中文43、较长输入879。
SDK Generate计数与新引擎完整decode计数均为127；新引擎completion_tokens为128，
包含prefill得到的首token，统计定义没有混在一起。

| 后端 | 英文 | 中文 | 879 token输入后 | 相对原默认 | 正式计时最大RSS |
| --- | ---: | ---: | ---: | --- | ---: |
| RKLLM 1.3.0，原W8A8 | 4.86 | 4.83 | 4.70 | 基线 | 4.79 GiB |
| RKLLM 1.3.1，同一W8A8文件 | 4.87 | 4.86 | 4.72 | 接近 | 4.79 GiB |
| 新引擎，混合量化，普通解码 | 7.36 | 7.31 | 7.25 | +51.4%～54.3% | 3.88 GiB |
| 新引擎，同一混合量化，MTP1 | 8.82 | 8.62 | 8.95 | +78.5%～90.6% | 3.91 GiB |

24/24计时进程正常结束，没有超时或温度/内存中止。调优345.17秒，1/2/128行均完成。
MTP1与普通解码的6对计时输出逐字相同，加上3对短题共9对相同；
这只是这些固定贪心样例，不是通用无损证明。计时题刻意要求较长回答并限128 token，
因此限长输出不算完整业务任务验收。

较长输入的prefill中位数：原默认15.743秒，新引擎普通6.616秒、MTP1为7.158秒。
这些是各后端报告的prefill阶段，准备/首字/加载边界另见原始timings，不能混成纯解码。
整个CLI进程含重载的中位数：原默认英文38.13秒、较长输入53.21秒；
新引擎普通为111.38/117.44秒，MTP1为115.44/119.42秒。
因此本轮证明了解码吞吐提升，但一次一进程的完整等待反而更长；
应用接入应采用常驻方式摊销初始化成本，常驻API接入本轮尚未验收。

整个窗口未改频率：NPU/GPU观察值均1GHz，CPU大核2.304GHz、小核1.8GHz，
DDR动态528MHz～1.848GHz；最高温度55.461℃。系统原本已有swap使用，
SwapFree监测范围2,079,996～2,081,020 KiB，不声称整个系统零交换。
RSS只是进程指标，不等于所有内核/DMA分配的总内存。

原始证据：`logs/qwen35-open-session-20261031-020155/`，其中：

- `summary.md` / `summary.json`：可重建的表格、逐次指标、输入对齐与文本比较；
- `smoke/` / `tune/` / `timing/`：计划、执行SHA256、原始输出、time-v与采样；
- `baseline-assets.jsonl`：两套RKLLM模型/程序/头文件/库的实机摘要；
  两套模型解析为同一固定SHA256
  `31ebf6a003675c82c72a2893bf46136720a0ae052a40bb12814e1bf67314b8ca`；
- `verification.json`：36项推理进程完成、原始日志严格UTF-8和恢复一致性检查；
- `health-before.json` / `health-after.json`：字典逐项相同，已恢复
  `qwen35-4b-rkllm` / Runtime1.3.0 / context16384 / native缓存 / protocol3，
  `privacy_metadata_only=true`；前台租约已释放，没有遗留新引擎进程。

汇总复现：

```powershell
.\.venv\Scripts\python.exe tools/report_qwen35_open_engine.py logs/qwen35-open-session-20261031-020155
```

结论边界：这条路线保留Qwen3.5-4B的模型规模，但同时更换量化资产、算子与调度，
不是只换运行库或保持原`.rkllm`不变的提速。没有切换默认引擎；
OpenCode/Coloop、metadata-only实现、长期记忆、工具执行、HID和图像质量仍需另行接入验收。
