# 工作台重绘

Scope: 六个桌面页面、品牌标志与发布图标。Mode: Operate。采用代码实现，真实 Electron 截图验证。

## Direction contract

THESIS: 让任务输入成为工作区的视觉核心，设备能力在旁侧清楚说明；克制的桌面布局服务持续使用。

OWN-WORLD: 石墨黑导航、白色任务工作区、浅灰设备栏；石墨黑主操作与灰阶反馈。轻重不同的圆弧 Logo 恢复 −35° 倾斜；UI 借用圆角、留白与线条轻重，不倾斜控件。

STORY: 用户输入任务或选择屏幕流程，选择推理位置，运行并回看结果。首次使用可从右侧到模型或设备配置。

FIRST VIEWPORT: 左侧 212px 导航；中央左对齐标题、突出任务输入、三条紧凑流程入口与最近任务；右侧 276px 连接概览和能力列表。运行按钮在输入区右下角。

FORM: 桌面文档工作区的精确排版和低噪声层级，连接路径是唯一图形表达。seed: none (unavailable)。该 unavailable 标记由本轮记录，未经过引擎验证；context 与 concept-seed 均已尝试，下载失败，未生成随机方向；按用户最新指定的黑白 Logo 风格实施。

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Verification

同时检查默认及最小桌面窗口，覆盖六页、输入/运行/取消、配置保存、OCR 和窄窗口溢出。Logo 以同一 SVG 几何生成应用图标和品牌预览。
