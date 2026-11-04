# 开始使用

板子已刷好 Ubuntu 22.04 Server，并已使用 NPU 跑通官方图片分类模型。
通过电脑远程操作即可，不需要为了这一步购买屏幕。

## 三个环境

2026-10-28 新增：DeepSeek-R1-Distill-Qwen-1.5B 已在板端 NPU 跑通。
双击项目根目录的 **运行DeepSeek.cmd** 可进入终端问答；输入 `exit` 退出。
模型来源、版本和验证结果见 [DeepSeek 使用说明](07-deepseek.md)。

Qwen3.5-4B 的独立实验入口为 **运行Qwen3.5-4B.cmd** / **看图Qwen3.5-4B.cmd**。量化格式及验收状态见 [4B 部署说明](11-qwen35-4b.md)。

| 位置 | 用途 |
|---|---|
| Windows 的 D:\RK | 写代码、准备图片、检查 ONNX、上传文件 |
| 电脑 WSL Ubuntu | 将 ONNX 转换成 RK3588 使用的 .rknn |
| 鲁班猫 ~/rk-edge-ai | 使用 NPU 运行模型 |

## 先跑已准备好的模型

保持板子正常供电，USB 线连接电脑和板子的烧录口。正常开机不按 MR；MR 用于刷机。
在 D:\RK 的 PowerShell 中运行：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/board.ps1 -Action resnet
```

密码提示时输入 `<RK_BOARD_PASSWORD>`，输入时不会显示字符。
成功时输出 `space shuttle`，本次实测分数 0.999680。
模型和图片在板子的 `~/rk-edge-ai/official-resnet18/`。

检查板端环境（也可将 check 换成 smoke，验证电脑转换的模型）：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/board.ps1 -Action check
```

## 登录开发板

```powershell
powershell -ExecutionPolicy Bypass -File scripts/board.ps1 -Action shell
```

用户名 `cat`，镜像默认密码 `<RK_BOARD_PASSWORD>`。进入后：

```bash
cd ~/rk-edge-ai
source .venv-board/bin/activate
bash scripts/run-board.sh resnet
```

USB 已配置本地地址，供电脑与板子直接通信。板子的网口目前未接入路由器；需要独立联网时接入路由器后确认 IP。
当前 USB 地址为 `169.254.207.141`；若以后地址改变，更新 `config/board.json` 与 `config/ssh_config`。

## 转换自己的模型

Windows 项目终端：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/open-ai.ps1
```

随后在 Ubuntu 终端中：

```bash
python tools/convert.py --input models/your_model.onnx --output models/your_model.rknn
```

图片的 RGB/BGR 顺序、缩放、均值和标准差必须与训练时一致。脚本用 `--mean`、`--std` 配置预处理，默认是 0、1。
模型的算子与输入形状需符合 RKNN 支持范围。
INT8 量化时准备真实业务图片清单（每行一个图片路径），加 `--dataset data/calibration.txt`。

转换后，从 Windows 上传：

```powershell
scp -F config/ssh_config models/your_model.rknn lubancat4-usb:~/rk-edge-ai/models/
```

不同模型的输入、输出和后处理不同，需要相应推理程序。

## 资料与验证记录

- [教程与示例](../downloads/README.md)
- [原理图](../downloads/hardware/README.md)
- `logs/board-npu-resnet18.txt`：官方模型实际 NPU 推理结果
- `logs/board-first-boot.txt`：板型、内存、存储与系统
- `logs/setup-linux.txt`：电脑转换环境安装记录
- `flash/flash-plan.json`：镜像校验与烧录结果

转换环境位于 WSL 的 `/root/.venvs/lubancat4-rknn-2.3.2`，已导入的此专用 WSL 默认用户为 root。通过 `open-ai.ps1` 会自动激活环境。

## 风扇自动温控

已确认风扇可以转动，保留官方默认策略：低于 40℃停转，40℃及以上开始转动，55℃、60℃、65℃继续提高输出。
这份固件的内核温控会覆盖手动写入 pwm1 的数值，因此不采用反复写入的方式强制开启。低温时风扇不转是正常情况。
临时启停测试已结束，未安装常转风扇配置。
