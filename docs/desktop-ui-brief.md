# 电脑操作页面

模式：Operate。目标平台为 Windows Electron 桌面，最小窗口 1060 × 720；本页不交付移动端。

## Direction contract

THESIS：让用户给一个明确窗口下达任务，并看见 RK 的真实执行与结果回读。沿用既有表单和运行状态布局。

OWN-WORLD：石墨黑导航、白色工作区、灰阶状态、Windows 字体栈和 Lucide 线条图标。复用 DESIGN.md，不新增视觉体系。

STORY：选择窗口、描述目标、填写完成条件、允许本次输入、开始；保持目标在前台，随时通过顶部提示停止。

FIRST VIEWPORT：页面标题和设备通道标识在顶部；依次排列窗口、任务、完成条件与规划方式。输入授权和开始按钮在表单底部，真实运行状态及最近事件在下方。小窗口允许纵向滚动；停止入口另在独立置顶提示窗中持续可用。

FORM：既有桌面世界内的局部功能扩展；沿用紧凑表单和分隔行，不运行开放概念选择。没有 comp 或新增图像素材。

FINISH：unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## 必须呈现的状态

未连接、未授权、正在准备、观察、规划、校验、执行、验证、完成、失败、停止中及停止未确认。完成文字来自实际观察；失败不展示成功。真实截图记录在每次隔离 QA 目录。
