# 模型文件管理

模型文件保留在本机，Git 记录生成脚本和必要的来源信息。
运行时原有模型文件不受 Git 初始化影响。

| 模型 | 获取或重建方式 | 用途 |
|---|---|---|
| `smoke.onnx` | Windows Python 执行 `tools/smoke_onnx.py` | Conv + ReLU 的 CPU 数值测试 |
| `smoke.rknn` | 在 WSL 中用 `tools/convert.py` 转换 smoke.onnx | RK3588 NPU 数值测试；Toolkit2 2.3.2 |
| 官方 ResNet18 RK3588 模型 | `tools/download_materials.py`；SDK v2.3.2 | 官方静态图片分类测试 |
| DeepSeek 部署所需模型 | `tools/prepare_deepseek.py` 内记录的来源与准备流程 | 沿用现有项目脚本，以实际部署日志为准 |

官方 RKNN SDK 当前固定提交：`42aa1d426c0a9e0869b6374edba009f7208a1926`。
下载后的摘要记录在对应 downloads/deployment 目录的 manifest 中。

新增模型时，在这里记录：

```text
模型名称：
来源链接和上游版本：
本地文件位置：
SHA256：
许可证或使用条件：
转换工具与版本：
输入尺寸、颜色顺序、归一化：
量化配置与校准数据版本：
验证日期、板端运行库/驱动版本及结果：
```

根目录的 `check*_*.onnx` 是转换工具生成的中间文件，也已设置 Git 忽略。
