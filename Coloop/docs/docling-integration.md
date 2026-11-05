# Docling 本地资料解析

2026-11-05 新增官方 Docling 2.147.0 的本地适配。它提供 PDF、DOCX 的结构化来源读取，不替代 WPS 写入、PDF 渲染审阅或最终业务核验，也不把解析成功当成任务完成。

## 安装与离线运行

在仓库运行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/setup-docling.ps1
```

独立环境为 `.cache/docling/.venv`，官方模型位于 `.cache/docling/models`。安装过程联网下载 Python 包、布局模型、TableFormer 和简体中文 RapidOCR ONNX 模型。固定直接依赖 Docling 2.147.0、CPU Torch 2.9.1、TorchVision 0.24.1；完整已安装依赖写入 `installed-requirements.txt`。模型文件清单和 SHA-256 写入 `models/manifest.json`。不要把该环境放到 RK 的模型目录或改写原 OCR 环境。

转换过程只接收本地文件路径，关闭远程服务、外部插件、Hugging Face 网络及遥测，并在 Python worker 内拒绝 socket 连接。启动环境只传系统运行所需变量，不传云端模型密钥。`-I -X utf8` 隔离 Python 用户环境并保证中文协议编码。模型应提前准备，执行任务时不自动联网下载。该限制不是操作系统级沙箱声明。

## 宿主接口

`DoclingService` 位于 `src/main/infrastructure/docling.ts`，构造参数为 `pythonPath`、`workerPath`、`cacheDirectory`、`modelDirectory` 与可选 `timeoutMs`。

```typescript
await docling.read(
  authorizedAbsolutePath,
  {
    start_block: 0,
    max_blocks: 20,
    max_characters: 8000,
  },
  signal,
)
```

调用方必须先通过 WorkspaceSession 的目录授权和真实路径检查。服务不接受 URL、不替用户选择目录。传入源会先复制为不可变临时快照，解析前后核对原文件摘要。

返回 `source_sha256`、`parser_version`、`document_id`、`block_count`、`blocks`、`truncated`、`next_block`、`cache_hit` 和 `channel: host_docling`。按 `next_block` 续读，每次至多 40 块、16,000 个 Unicode 字符、1 MiB JSON。段落与单元格正文超过 2,000 字符会分块，`source_id` 与 `text_offset` 保持定位。表格块含行列位置、跨行跨列及表头标记。PDF 返回 Docling 的真实页码、边界框与坐标原点；DOCX 没有排版页码时返回空页码数组，不能把段落编号冒充页码。

输入至多 30 MiB、PDF 至多 200 页、至多 20,000 块，转换默认 180 秒超时。取消或超时终止该次 Python worker，等待进程退出后返回，不接受迟到成功结果。缓存原子提交，键绑定来源 SHA-256、适配器格式、解析器及 OCR 版本、安装模型清单摘要。缓存包含原始文档内容，应放在宿主私有数据目录，不向模型暴露缓存路径，也不把全文一次塞进提示词。

## 验证

边界测试：

```powershell
npx vitest run tests/docling.test.ts
python -m unittest discover -s tests -p test_docling_worker.py
```

真实官方模型测试：

```powershell
$env:COLOOP_DOCLING_REAL = '1'
& .cache/docling/.venv/Scripts/python.exe -m unittest tests.test_docling_worker
```

真实样本和解析结果留在 `.cache/docling/verification/real-*`。本轮已通过中文 DOCX 正文和六个表格单元格、分页续读、缓存命中，以及两页人工生成扫描 PDF 的本地 OCR、金额、表格单元格和页码来源检查。它们是组件真实执行证据，不是 Coloop 模型自主任务、复杂中文票据准确率或26项业务套件通过证明。没有调用付费模型。

官方文档：[Docling](https://github.com/docling-project/docling)、[文档结构](https://docling-project.github.io/docling/concepts/docling_document/)、[离线运行](https://docling-project.github.io/docling/usage/advanced_options/)。代码 MIT；模型许可分别以下载模型附带说明为准。

## Windows 打包

开发用 `.venv/pyvenv.cfg` 绑定创建它的系统 Python，不能直接作为其他电脑的运行时。运行 `scripts/package-docling.ps1` 生成 `.cache/docling-portable`，将这个目录复制到 `resources/runtime/docling`。应用仍通过 `.venv/Scripts/python.exe` 启动，无需改变宿主接口；此路径内实际是官方 Python 3.12.10 embeddable，而非 venv 重定向启动器。

脚本固定官方 Python ZIP 的 SHA-256，使用相对 `python312._pth` 定位标准库及依赖，不包含 `pyvenv.cfg`。安装依赖及全部模型一起携带，跳过开发环境的 Python 字节码缓存。构建探针清除 PATH 中的 Python 路径，并将 PYTHONHOME/PYTHONPATH 指向不存在位置，验证 `sys.prefix`、`sys.base_prefix`、全部 `sys.path` 都在打包目录中。

本轮暂存产物约 1.86 GB，适合随 `win-unpacked` 目录交付；打成单一 portable EXE 会增加启动解压负担。保留 `COLOOP_DOCLING_HOME` 可覆盖运行时位置，但默认包必须自带该目录。当前没有裁剪模型或主要 Python 依赖，后续瘦身应单独验收。

`tests/workspace-migration.test.ts` 另外验证目录逃逸、解析期间源变更、恢复产物摘要和 PDF 重新审阅。设置 `COLOOP_DOCLING_REAL=1` 后，其中实际集成测试使用可移植解释器和包内模型，通过 WorkspaceSession 的 `read_structured` 读取中文 DOCX 表格与扫描 PDF。本轮 5 项均通过，真实结果留在 `.cache/docling/portable-validation/workspace-read-structured.json`。这证明当前 Windows 上的包内依赖和转换链路；尚未执行另一台干净 Windows 的整包安装验收。

[Python 官方嵌入式发行说明](https://docs.python.org/3.12/using/windows.html#the-embeddable-package)
