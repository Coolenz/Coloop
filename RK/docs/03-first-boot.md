# 接线、烧录与首次启动

## A. 先检查出厂系统

1. 确认板型、电源、散热器；断电安装必要附件。
2. 优先把网线连接到路由器，电脑也接入同一局域网。
3. 按板型接电；如有桌面显示设备，可以观察启动画面。
4. 从路由器设备列表查看分配到的 IP；也可在板上终端使用 `hostname -I`。
5. 能正常启动则先做下面的 SSH 验证，不必立即重刷。

如果用串口观察启动，按照官方板型图连接。串口默认参数与线材要求见[硬件清单](01-hardware.md)。
参考：[野火开机与登录](https://doc.embedfire.com/linux/rk3588/quick_start/zh/latest/quick_start/board_startup/board_startup.html)、[网络配置](https://doc.embedfire.com/linux/rk3588/quick_start/zh/latest/quick_start/network/network2.html)。

## B. 仅在需要时刷机

烧录会覆盖所选目标存储中的数据。先记录板型、镜像完整文件名和目标 eMMC/SD，备份已有数据。

| 情况 | 准备与入口 |
|---|---|
| 烧录到 eMMC | 匹配镜像、电脑端驱动、RKDevTool、USB 数据线连接 OTG |
| 烧录到 SD | 匹配镜像、microSD、读卡器、该镜像格式对应的写卡工具 |

官方对 Ubuntu 22/24 的 eMMC 镜像要求使用 MASKROM 流程，和部分旧 Debian/Ubuntu 镜像的烧录流程不同。Loader 文件、勾选项及写入方式按该镜像的官方说明操作，不套用另一种镜像的步骤。

完整步骤与按键照片见[官方烧录章节](https://doc.embedfire.com/linux/rk3588/quick_start/zh/latest/quick_start/flash1_img/flash1_img.html)。烧录后首次启动可能初始化或重启，按官方说明等待完成。

## C. 在 Windows 验证 SSH

把 `BOARD_IP` 替换为板上真实地址，`USER` 替换为镜像实际用户名。不要直接复制占位符；具体账号以镜像说明为准。

```powershell
Test-NetConnection BOARD_IP -Port 22
ssh USER@BOARD_IP
```

首次连接时核对主机身份提示，再输入密码。输入密码不显示字符是正常现象。登录后先确认下面的信息：

```bash
cat /etc/os-release
uname -a
uname -m
tr '\0' '\n' < /proc/device-tree/compatible
python3 --version
free -h
df -h /
hostname -I
```

这些命令只读取信息。正常目标是 Linux、`aarch64`，设备树中有 `rk3588` 系列标识。保存结果至[设备记录](06-device-record.md)。

可选检查 NPU 驱动信息：

```bash
ls /dev/dri
cat /sys/kernel/debug/rknpu/version
cat /sys/kernel/debug/rknpu/load
```

有些内核路径不同，或普通用户无权限，某条命令失败不能单独证明 NPU 不可用。先记录提示，结合驱动日志与实际推理判断，不要为了读取信息更改整个系统的设备权限。

## D. 安装并验证板端 Python 环境

先在电脑上完成 WSL 环境安装和 smoke.rknn 转换。然后按[项目主说明](../README.md)中的 `scp` 和 `setup-board.sh` 步骤复制文件并安装。

板上执行：

```bash
cd ~/rk-edge-ai
.venv-board/bin/python tools/doctor.py --board
.venv-board/bin/python tools/smoke_board.py
```

- `doctor.py` 通过：相关 Python 包可导入，识别板型，运行库可加载。
- `smoke_board.py` 通过：NPU 实际运行测试模型，输出与参考数值相符。

第一项通过不等于第二项一定通过。运行库和内核驱动兼容性仍需结合实际推理日志确认。[板端部署参考](https://doc.embedfire.com/linux/rk356x/Ai/zh/latest/lubancat_ai/env/toolkit_lite2.html)
