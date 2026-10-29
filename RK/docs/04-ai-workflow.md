# AI 开发路线与验收

## 第 1 步：区分两台机器

```text
Windows 电脑
  ├─ VS Code：编辑代码
  ├─ .venv：图片处理、ONNX 检查和 CPU 参考推理
  └─ WSL Ubuntu：RKNN-Toolkit2 转换
           ONNX → RKNN
                    │ SSH / SCP 复制
                    ▼
鲁班猫 4：官方 Linux + Lite2 + 运行库 + 驱动
           RKNN → NPU 推理 → 处理结果
```

主机使用 x86_64 包，板端使用 aarch64 包；两边虚拟环境不能互相复制使用。普通 RK3588S / S2 的 NPU 转换使用本项目的 `rk3588` 目标，而系统镜像仍要匹配具体板型。[Toolkit2 官方平台说明](https://github.com/airockchip/rknn-toolkit2/tree/v2.3.2)

## 第 2 步：运行项目自检

| 环节 | 操作 | 合格条件 |
|---|---|---|
| Windows 环境 | `tools/doctor.py` | 依赖全部导入成功 |
| CPU 参考推理 | `tools/smoke_onnx.py` | 生成 ONNX，检查输出数值通过 |
| Linux 转换环境 | `scripts/setup-wsl.ps1` | RKNN 导入与转换成功，生成 smoke.rknn |
| 板端依赖 | `tools/doctor.py --board` | Lite2 和运行库可加载 |
| NPU 实际推理 | `tools/smoke_board.py` | 测试模型输出与 CPU 参考一致 |

这些脚本的运行位置和完整命令见[主说明](../README.md)。目前只完成了前两个环节的验证。

## 第 3 步：做一张图片的推理

建议先做分类模型或官方检测示例，每次只选一个。示例入口：[Rockchip Model Zoo](https://github.com/airockchip/rknn_model_zoo)、[野火 AI 示例](https://gitee.com/LubanCat/lubancat_ai_manual_code)。

1. 从同一示例获取模型、测试图、类别文件、转换方法和前后处理代码，记录出处与版本。
2. 用固定测试图检查输入尺寸、颜色通道、归一化方式和输出张量。
3. 先转换不量化模型，运行板端推理，确认结果合理。
4. 再根据实际应用收集校准图片，转换 INT8 模型，对比精度和速度。
5. 保存图像、模型版本和日志，保证下次可以复现。

`tools/convert.py` 是基础的单图像模型转换入口，不负责 YOLO 的框解码、NMS、类别映射，也不会自动为所有网络修改动态输入。检测模型应采用对应官方实例的完整流程。

## 第 4 步：加入摄像头

先只验证图像采集，再接推理。建议从已有 UVC USB 摄像头起步，MIPI 摄像头按官方兼容表和设备树配置选择。[野火摄像头教程](https://doc.embedfire.com/linux/rk3588/quick_start/zh/latest/quick_start/camera/camera.html)

板上采集测试可安装 `v4l-utils` 后运行 `v4l2-ctl --list-devices` 查看设备。不要假定摄像头总是 `/dev/video0`，也不要把板上的视频编解码节点当作摄像头节点。

静态图流程确认后，再按“采集 → 缩放/颜色变换 → NPU 推理 → 后处理 → 显示/发送结果”接起来。开始用较低分辨率，稳定后再调速度。

## 第 5 步：记录性能并决定优化方向

至少记录：模型文件、精度模式、输入尺寸、前处理耗时、纯推理耗时、后处理耗时、整帧耗时、温度和是否丢帧。帧率不能只用纯推理时间推算。

当正确性与稳定性已确认，再考虑多 NPU 核、流水线、RGA、MPP、C++ 或模型裁剪。不要在同一次实验里同时更换模型、SDK、镜像与前处理。

## 如果最终做大语言模型

单独规划 RKLLM 环境，先确定板上内存容量、模型规模、量化格式与上下文长度。视觉模型跑通不表示同一环境已具备大模型转换能力。[官方 RKLLM](https://github.com/airockchip/rknn-llm)
