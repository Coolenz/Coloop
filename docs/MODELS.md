# 模型与 SDK 下载索引

这里给出来源链接；仓库不包含权重或 SDK 二进制。下载后核对文件大小和 SHA256，不能只依据文件名。

| 用途 | 来源与固定版本 | 本仓库入口 |
|---|---|---|
| 默认板端 Qwen3.5-4B，W8A8，RK3588 | [Qengineering 社区转换](https://huggingface.co/Qengineering/Qwen3.5-4B-rk3588/tree/ee09c44b420e031dbe96fcb489ef30c5f3e0d1a5) | [下载工具](../RK/tools/prepare_qwen35_4b.py)、[文件清单](model-manifests/qwen35-4b.json) |
| 可选 Qwen3.5-9B，W8A8，RK3588 | [Qengineering 社区转换](https://huggingface.co/Qengineering/Qwen3.5-9B-rk3588/tree/8e14580be5ac58feadd2f463efd4200963ec7b9e) | [下载工具](../RK/tools/prepare_qwen35.py)、[文件清单](model-manifests/qwen35-9b.json) |
| 电脑 BF16 对照，非日常应用必需 | [Qwen 官方 4B](https://huggingface.co/Qwen/Qwen3.5-4B/tree/851bf6e806efd8d0a36b00ddf55e13ccb7b8cd0a) | [下载工具](../RK/tools/prepare_qwen35_original.py)、[主要文件清单](model-manifests/qwen35-4b-bf16.json) |
| Windows OCR，RapidOCR 3.10.0 / PP-OCRv5 mobile | [RapidAI 官方模型](https://www.modelscope.cn/models/RapidAI/RapidOCR/files) | [准备工具](../RK/tools/prepare_screen_ocr.py)、[21.5 MB 两个模型的链接与校验](model-manifests/ocr.json) |
| 可选 Mem0 中文嵌入，约 95 MB ONNX | [Qdrant/bge-small-zh-v1.5 固定版本](https://huggingface.co/Qdrant/bge-small-zh-v1.5/tree/46fbe35fd4374a00fee7de77dfddaeb6dd6a2c59) | [准备工具](../RK/rk-opencode/scripts/prepare-memory-model.py)、[文件清单](model-manifests/memory-embedding.json) |
| RKLLM SDK / Runtime / Header | [Rockchip rknn-llm](https://github.com/airockchip/rknn-llm) | [构建模板中的固定文件摘要](../RK/tools/build_qwen35_bundle.py)、[SDK 专题](../RK/docs/08-rkllm-toolkit.md) |
| RKNN Toolkit2 | [Rockchip v2.3.2](https://github.com/airockchip/rknn-toolkit2/tree/v2.3.2) | [SDK 准备工具](../RK/tools/prepare_ai_bundle.py) |
| OpenCode | [v1.19.5 release](https://github.com/anomalyco/opencode/releases/tag/v1.19.5) | [host.py 中的归档 SHA256](../RK/rk-opencode/host.py) |
| 旧 DeepSeek 实验 | 来源和版本见 [DeepSeek 专题](../RK/docs/07-deepseek.md) | [准备工具](../RK/tools/prepare_deepseek.py) |

4B 语言权重为 5,578,247,044 字节；可选视觉权重为 704,579,761 字节。Coloop 当前只接入端侧文本接口，视觉模型用于 RK 独立实验。9B 文本质量验收尚未通过，保留其源码和历史失败边界。

社区 RK3588 转换文件与官方 BF16 权重是不同资产。默认 4B 应用及 worker 使用匹配的 RKLLM Runtime/Header 1.3.0；1.3.1 是独立对照，不能全局替换库后沿用旧结果。

Mem0 嵌入准备脚本在没有本地 manifest 时解析上游当前 revision，再固定后续下载。要复现本次版本，先把 `model-manifests/memory-embedding.json` 复制到 `RK/rk-opencode/.cache/memory-model/manifest.json`（先创建目录），再运行准备脚本。脚本对已有缓存检查摘要，但新下载文件会重新记录摘要；因此下载后还需对照本仓库独立保存的参考清单复核，不能只检查脚本更新过的缓存 manifest：

```powershell
# 从仓库根目录执行
$reference = Get-Content docs/model-manifests/memory-embedding.json -Raw | ConvertFrom-Json
foreach ($entry in $reference.files.PSObject.Properties) {
    $asset = Get-Item (Join-Path RK/rk-opencode/.cache/memory-model $entry.Name)
    if ($asset.Length -ne $entry.Value.bytes -or
        (Get-FileHash -LiteralPath $asset.FullName -Algorithm SHA256).Hash -ne $entry.Value.sha256) {
        throw "Embedding asset verification failed: $($entry.Name)"
    }
}
```

SDK、模型、数据、字体和工具使用各自许可证，下载及使用前阅读对应上游说明。本仓库的应用 MIT 许可不覆盖这些资产。
