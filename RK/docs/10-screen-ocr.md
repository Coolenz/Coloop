# Windows 本地 OCR 与桌面操作

2026-10-30 后续：模型输入整理已进入RK端侧桌面Agent默认流程；Windows只观察/校验，前台获取和键鼠动作由RK USB HID完成。新入口、真实模型业务闭环与边界见 [端侧桌面Agent](25-rk-desktop-agent.md)。

调研、安装、测试日期：2026-10-28。目标：为 VioLoop 风格的桌面助手提供文字、坐标、标准控件信息与键鼠执行基础。

## 已选方案

**RapidOCR 3.10.0 + PP-OCRv5 mobile 中英文模型 + ONNX Runtime CPU**。观察部分用 `mss` 截图、`pywinauto` 读取 Windows UI Automation 控件树。历史软件执行示例使用电脑端键鼠输入；后续HID主链路的输入由RK发出。正常识别完全在本机进行，不需要 API Key。

OCR 输出的是文字区域，不等于按钮边界，也不能证明某个区域可点击。文字按钮可用文字区域中心定位；标准窗口优先通过 UIA 获取 Button、Edit 等控件类型、边界和 enabled 状态。无文字图标、Canvas、自绘控件、远程桌面等情况，需要视觉检测、模板匹配或多模态模型补充。

按2026-10-30用户确认的HID方向，目标链路为：**电脑窗口/UIA → 必要区域OCR → RK任务规划 → RK本地执行器 → USB HID键鼠 → 电脑再次观察验证**。电脑侧在该主链路承担观察与校验；RK直接发送硬件报告，MCP作为可选调用适配。图像中的文字作为任务数据处理，不能直接作为可执行指令。硬件能力与直接入口见 [HID专题](24-rk-hid-input.md)。

2026-10-30：紧凑控件表、增量回传和逐步校验的批量填写，先在Windows软件通道实验，现已接入RK本地HID主接口。`hid-act.py --observe --compact --reset-view` 生成首帧，`--compact` 接收本地动作/批填并返回增量。复用现有RapidOCR+UIA的真实USB验收通过：初始观察2582→383字节，无变化增量70字节；一条请求经RK完成7个HID动作及逐项实值核对。随后独立六题真实Qwen4B观察A/B已测得input token 9156→2244、SDK prefill 168.088→41.082秒，均约减少75.5%；不调用HID，未验收模型自主跨应用业务。中文识别不等于纯HID中文输入。`tools/screen_ocr.py` 和单次 `scripts/screen-ocr.ps1` 的接口保持原有形式。源码、固定日志和限制见 [HID优化验收](24-rk-hid-input.md#紧凑观察与板端批量填写) 与 [真实模型A/B](24-rk-hid-input.md#真实模型处理量-ab)；历史软件通道证据仍见 [桌面skill专题](23-windows-desktop-skill.md)。

## 候选比较

Star 为当日 GitHub API 查询快照，会变化。未安装的候选不声称已在本机测过性能。

| 项目 | Star 快照 | 适用情况 | 本次决定 |
|---|---:|---|---|
| [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR) | 91,848 | 成熟 OCR 模型和完整训练/推理生态，Apache-2.0 | 使用其 PP-OCRv5 模型，经 RapidOCR/ONNX 推理 |
| [RapidOCR](https://github.com/RapidAI/RapidOCR) | 8,361 | 开发集成；直接取得文本、置信度、四角坐标；多种推理后端，Apache-2.0 | **已下载源码、安装 SDK、验证模型** |
| [Umi-OCR](https://github.com/hiroi-sora/Umi-OCR) | 48,246 | 开箱即用的离线截图 OCR 桌面软件，提供 CLI/HTTP；主项目 MIT | 适合手工截图提字，本次未另行安装 GUI |
| [Microsoft OmniParser](https://github.com/microsoft/OmniParser) | 25,579 | 屏幕元素检测、图标功能描述和坐标定位，功能更接近完整屏幕解析 | 有无文字图标需求时再评估；需检测/描述模型及更重依赖 |
| [pywinauto](https://github.com/pywinauto/pywinauto) | 6,286 | Windows UIA/Win32、鼠标与键盘，BSD-3-Clause | **已安装** |

OmniParser 的许可证需分组件看：当前仓库 CC-BY-4.0，README 标注新 YOLOv9 检测器 MIT、旧 Ultralytics 检测器 AGPL、caption 模型 MIT。不能只根据仓库一个许可证判断所有权重。RapidOCR 源码、模型、字体和推理运行时也分别保留各自来源；本地字体使用 Windows 自带微软雅黑，无需再联网下载字体。

截至当前，RapidOCR 已支持 PP-OCRv6，安装的 wheel 也自带 v6 small 模型。本入口显式选择并校验 PP-OCRv5 mobile，是本次验证配置；没有把 v6 与 v5 混合比较，也没有宣称 v5 是最新版本。

## 本机已安装的位置

| 内容 | 路径 |
|---|---|
| 双击测试入口 | `D:\RK\测试屏幕OCR.cmd` |
| Python 环境 | `D:\RK\deployment\screen-ocr\.venv`，Python 3.12.8 |
| RapidOCR 源码 | `D:\RK\third_party\RapidOCR` |
| 源码快照 | `80b427d69bfc5b91a12913394875910296c6f315` |
| 模型 | `D:\RK\deployment\screen-ocr\models` |
| 模型来源与 SHA256 | `D:\RK\deployment\screen-ocr\model-manifest.json` |
| 入口源码 | `D:\RK\tools\screen_ocr.py` |
| 精确依赖版本 | `D:\RK\requirements-screen-ocr.lock.txt` |
| 输出 | `D:\RK\deployment\screen-ocr\results` |

核心版本：RapidOCR 3.10.0、ONNX Runtime 1.31.1、mss 10.2.0、pywinauto 0.6.9。CPU 推理不依赖 CUDA；没有为本次 OCR 安装 GPU 推理环境。检测权重 4,819,576 字节，识别权重 16,631,306 字节，共约 21.5MB；整个 Python 环境还包含 OpenCV、运行库及 wheel 自带模型，体积会更大。

依赖安装时使用清华 PyPI 镜像；源码来自官方 GitHub，选用模型来自 RapidAI 官方 ModelScope 仓库，已按安装包的固定注册表 SHA256 校验。运行入口显式指定本地模型路径；离线验证禁止 requests 发出网络请求后依然通过。

## 立即使用

双击 `D:\RK\测试屏幕OCR.cmd`，在 3 秒内切回想识别的窗口。识别结束会打开标注图，原图和 JSON 保存在 `results/latest.*`。红框表示文字区域，蓝点表示文字中心。每次覆盖 latest，需要留存时指定不同 `--output`。

在 PowerShell 的 `D:\RK` 下运行：

```powershell
# 当前主屏；输出 latest.png、latest-marked.png、latest.json
.\scripts\screen-ocr.ps1

# 自动生成中英文界面测试图，重复识别并报告预热后的耗时
.\scripts\screen-ocr.ps1 --sample --repeat 6 --find '开始测试'

# 识别本地图片；这种坐标属于图片，不能直接当屏幕坐标
.\scripts\screen-ocr.ps1 --image 'D:\图片.png'

# 局部区域：左、上、宽、高，单位为桌面物理像素
.\scripts\screen-ocr.ps1 --region 100 200 600 300

# 所有显示器组成的虚拟桌面，支持负坐标
.\scripts\screen-ocr.ps1 --monitor 0

# 限定窗口截图，标题必须精确匹配且唯一
.\scripts\screen-ocr.ps1 --window-title '实际窗口标题'

# 提取同一窗口的 UIA 控件，输出 name/type/enabled/rect/center
.\scripts\screen-ocr.ps1 --uia --window-title '实际窗口标题'

# 生成点击计划；不发送点击
.\scripts\screen-ocr.ps1 --window-title '实际窗口标题' --find '确定' --click

# 执行文字点击：3 秒内切换到目标窗口
.\scripts\screen-ocr.ps1 --window-title '实际窗口标题' --find '确定' --click --execute --delay 3

# 执行按键；^a 表示 Ctrl+A，{ENTER} 表示回车
.\scripts\screen-ocr.ps1 --window-title '实际窗口标题' --keys '{ENTER}' --execute --delay 3
```

JSON 例子：

```json
{
  "text": "开始测试",
  "confidence": 1.0,
  "box": [[85,357],[224,357],[224,403],[85,403]],
  "rect": [85,357,224,403],
  "center": [154.5,380.0]
}
```

截图输出 `coordinate_space=physical_screen_pixels`，局部截图已加回桌面 origin；文件输出为 `image_pixels`。程序在导入截图和窗口库前设置 DPI awareness，以减少 Windows 缩放带来的坐标偏移。负 origin 映射已做数值验证，多屏混合缩放尚未逐屏实测。

点击入口限定为实时窗口截图、唯一同名文字且置信度至少 0.8，执行前检查前台窗口、边界以及目标文字像素是否改变。它是最小执行示例，没有实现自动重试、工作流规划、图标识别、控件 enabled 联合判断或动作后业务验证。键盘入口使用 pywinauto 按键语法；不含 `--execute` 时只生成动作记录。本次没有向用户正在使用的应用实际发送点击或按键，真实跨应用执行仍需单独验收。

## 实测与范围

Ryzen 9 8940HX，CPU，4 个 ONNX intra-op 线程、1 个 inter-op 线程；截图文字检测最长边 1280，方向分类关闭。每组固定图片识别 4～6 次，首轮单独计时，其余取中位数。耗时仅包括 OCR 调用，不包括截图、磁盘保存、规划器、键鼠动作或应用响应，也不是通用准确率评测。

| 图像 | 文字行数 | 首次 OCR | 预热后 OCR 中位数 |
|---|---:|---:|---:|
| 自建中英文 UI，1280×720 | 6 | 864.60ms | 309.59ms |
| 两个按钮局部，580×130 | 2 | 281.53ms | 22.36ms |
| 真实桌面，2560×1440 | 69 | 2365.72ms | 1711.40ms |

记录为 `sample-test.json`、`roi-test.json`、`screen-test.json`。测试图中“开始测试”“取消”及中英文数字均识别成功。真实桌面的 69 行是检测输出数，没有人工标注全部文字计算准确率。另一个 smoke 测试验证了：禁止联网后推理成功、负坐标映射正确、空白图不返回文字。UIA 对 Windows 桌面窗口 Program Manager 的只读查询成功返回 59 个控件，记录为 `uia-test.json`；启动器、独立局部截图与静态检查也通过。

要达到局部区域的低延迟，应在常驻进程中复用一个 `ScreenOCR` 实例。每次重新启动 Python 都有导入与模型加载开销。持续读屏的下一步优化是画面变化检测、局部 ROI、缓存与按需识别；当前脚本没有常驻服务或缓存。

```python
from tools.screen_ocr import ScreenOCR, capture

ocr = ScreenOCR()  # 常驻进程只初始化一次
image, origin = capture(region=[100, 200, 600, 300])
result = ocr.read(image, origin)
```

## 业界路线与硬件接入

- **Windows UIA + OCR + 输入注入**：本次采用的基础组合。UIA 提供标准控件的程序化访问，OCR 补充像素中的文字。微软 [UI Automation 文档](https://learn.microsoft.com/en-us/windows/win32/winauto/entry-uiauto-win32) 和 [SendInput 文档](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput) 解释了接口与进程完整性级别限制。
- **Microsoft Power Automate Desktop**：现成 RPA，官方 OCR 操作支持 Windows OCR 和 Tesseract，也提供在屏幕上判断/寻找文字的操作；适合固定业务流程。[OCR 操作参考](https://learn.microsoft.com/en-us/power-automate/desktop-flows/actions-reference/ocr)
- **UiPath Computer Vision**：结合 UI 元素检测与 OCR，覆盖远程桌面等场景；默认云端配置不满足“全部本地”，本地部署需另评估。[官方介绍](https://docs.uipath.com/ai-computer-vision/standalone/2023.10/user-guide/introduction)
- **Microsoft UFO**：开源桌面 Agent 架构参考，结合 GUI/API/UIA 与规划器，适合研究完整执行闭环。[官方仓库](https://github.com/microsoft/UFO)

VioLoop 官方描述 HDMI 采集、屏幕解析、USB HID 键鼠以及脚本/API、快捷键、辅助功能与 GUI 点击路由；其具体 OCR/视觉模型组合未完整公开。本次是针对能力的替代方案，不是原厂模型复现。[VioLoop 官方机制说明](https://violoop.ai/blog/ai-that-reads-your-screen/)

当前执行器属于 **Windows 软件输入**。若后续需要鲁班猫/MCU 的 USB HID，OCR 继续提供目标坐标，执行器改为向串口/HID 控制器发送动作；还需处理采集画面与显示器坐标映射、相对/绝对鼠标协议。没有硬件接线和固件就不能声称已实现 VioLoop 的硬件键鼠通道。锁屏、UAC 安全桌面、被遮挡目标及高权限应用也需要单独处理。

## 重建与复验

```powershell
uv venv --python 3.12 'D:\RK\deployment\screen-ocr\.venv'
uv pip install --python 'D:\RK\deployment\screen-ocr\.venv\Scripts\python.exe' --index-url https://pypi.tuna.tsinghua.edu.cn/simple -r 'D:\RK\requirements-screen-ocr.lock.txt'
& 'D:\RK\deployment\screen-ocr\.venv\Scripts\python.exe' 'D:\RK\tools\prepare_screen_ocr.py'
& 'D:\RK\deployment\screen-ocr\.venv\Scripts\python.exe' 'D:\RK\tools\smoke_screen_ocr.py'
```

模型、源码下载、环境与测试截图都保存在本机；没有部署公网服务，也没有连接开发板或修改其环境。
