# 许可与第三方来源

- `Coloop/` 的原创应用代码采用 [MIT License](../Coloop/LICENSE)。`RK/` 的原创文件尚未单独声明新的开源许可，本次上传不擅自将其改成 MIT。
- Sora 字体保留 [OFL](../Coloop/resources/fonts/OFL-Sora.txt) 和 [来源](../Coloop/resources/fonts/README.md)。Coloop 图形源与生成记录见 [brand-provenance.json](../Coloop/resources/brand-provenance.json)。
- OpenCode、Mem0、嵌入模型和 Rockchip 组件分别见 [RK 第三方声明](../RK/rk-opencode/THIRD_PARTY_NOTICES.md)。本仓库包含集成代码，运行依赖、模型和 SDK 二进制由用户另外下载。
- `RK/tools/evalsets/ceval-val-all52-seed42-260.json` 包含原 C-Eval 固定抽样题目，来源、固定 revision、抽样方法和作者署名在该文件 `provenance` 中。题集采用 CC BY-NC-SA 4.0，不能按应用 MIT 许可使用。许可：[CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/)，来源：[ceval/ceval-exam](https://huggingface.co/datasets/ceval/ceval-exam)。仅抽样/增加复现字段，保留原题、选项和答案。
- CMMLU 固定子集保留 [官方来源和固定 revision](https://github.com/haonan-li/CMMLU/tree/d6e7b716d8ac694f38969a6c0407437d1fded799) 及逐文件校验和抽样行号。题目权利与使用条件遵循原数据集说明，不因本仓库其他部分的许可发生变化。
- 自编小题集与公开题库分别标记；历史评测是固定抽样，不是完整官方榜单分数。

其他参考来源见 [Coloop references](../Coloop/docs/references.md)。依赖锁文件固定安装版本，上游许可仍分别适用。
