# Qwen3.5-0.8B RK3588 权重下载

2026-11-04，选择 Hugging Face 社区预转换仓库
[Qengineering/Qwen3.5-0.8B-rk3588](https://huggingface.co/Qengineering/Qwen3.5-0.8B-rk3588)，
固定 revision `3f6ecb50c6e3c5e17f6a2c1ac0fd8bceaddf7d2a`。

下载入口为 `tools/prepare_qwen35_08b.py`，复用现有 Qwen 下载器的分片续传、
字节数检查与 SHA256 校验。独立目录为 `downloads/qwen3.5-0.8b-rk3588/`。

```powershell
.\.venv\Scripts\python.exe tools/prepare_qwen35_08b.py
```

| 文件 | 字节数 | SHA256 |
|---|---:|---|
| `qwen3.5-0.8b_w8a8_rk3588.rkllm` | 1337292780 | `ba85edac97e8f4ed2cdf0d94a3744b5609385b4706c45677f55cdaeb465ce054` |
| `qwen3.5-0.8b_vision_rk3588.rknn` | 218787569 | `e96a3f016163e7cf7ae516ed9878ccad7c576c658d71a60333f5cb154680fd81` |

语言部分 W8A8，视觉部分 FP16，目标为 RK3588。模型卡要求 RKLLM Runtime 1.3.0、
RKNN rknpu2 和图像预处理用 OpenCV，声明最高 16384 token KV 缓存。
转换 Toolkit/Header 的具体版本未独立核实，转换仓库模型卡元数据未声明许可证。
原模型卡与下载清单保存为下载目录中的 `MODEL-CARD.md` 和 `manifest.json`。

本次范围为主机下载准备。未运行板端验证，尚未构建或上传独立应用，
加载、中文回答和看图能力需通过后续实机验收确认。
