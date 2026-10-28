# 验收记录

日期：2026-10-28，Windows 11 x64，本机 `D:\Coloop`。

## 0.2.0 界面与品牌更新

使用 frontend-design skill 调整整体视觉、导航、任务画布、表单与设备示意图；基于 coolen 的字母结构设计 Coloop 标志，导出 SVG、PNG、ICO 与品牌预览。数据模型、设备与云端协议保持兼容。

TypeScript 与生产构建通过；真实 Electron 的 10 项通用联调通过，覆盖六页导航、凭据加密、模型调用、任务取消、离线 OCR、结果附加、截图和历史导出。此次界面更新没有额外运行板端推理。六个页面均生成截图做视觉复核，位于 `.qa/page-*.png` 和 `.qa/workspace.png`；最终 Windows 程序为 `release/Coloop-0.2.0-Windows-x64.exe`。

## 自动检查

- TypeScript：renderer、preload、主进程与测试均通过。
- Vitest：4 个文件、21 项测试通过。覆盖三种模型协议、中文分块 SSE、结束事件、空结果、HTTP 错误脱敏、重定向策略、凭据隔离与删除、存储恢复、任务取消、并发互斥、OCR 失败阻断、组合上下文、写盘失败回滚、shell 转义，以及 SSH 指纹验证。
- SSH 测试启动本机临时服务器，验证正确指纹可连接，错误指纹在密码认证前被拒绝。
- npm audit：0 个已知漏洞。初始 Zod 3 依赖已升级到 4.6.7 后重新测试。
- Prettier 与 `git diff --check` 用于最终格式检查。

## 桌面联调

`tests/e2e.mjs` 在独立 `.qa/profile-*` 资料目录运行，不写入实际工作区配置。模型服务使用临时环回 HTTP/SSE 测试服务器，不向云端发送屏幕或消耗账户额度。

11 项场景通过：

1. 真实 Electron 启动与 preload 调用。
2. 六个页面导航与渲染。
3. Windows DPAPI 实际加密测试 Key；磁盘没有明文，公开接口没有 Key。
4. 界面保存模型设置、测试连接与 HTTP SSE 任务完成。
5. 任务取消后保持 cancelled。
6. 已安装 RapidOCR 对真实测试 PNG 做离线中英文识别，验证 `COLOOP`、`128.50` 与 `本地`。
7. OCR 结果附加到任务。
8. 原生桌面截图，返回 2560×1440 图像。
9. 经 USB RNDIS 和固定指纹 SSH 读取真实 LubanCat-4 健康数据。
10. 没有 renderer 运行时异常。
11. 导出真实历史 JSON 文件，记录数与任务数一致。

开发运行与 `release/win-unpacked/Coloop.exe` 打包程序均已通过桌面联调。截图保存在本机 `.qa/workspace.png`、`.qa/ocr.png`、`.qa/device.png`，逐页查看并修正了 OCR 叠加层的布局。

## USB 实机结果

- hostname：`lubancat`。
- compatible：`rockchip,rk3588s-lubancat-4-v1 rockchip,rk3588`。
- 内存总量：15962 MB，约 15.6 GiB。
- 可用内存：约 15600 MB。
- 温度：多次读取约 36–44°C。
- Qwen3.5-9B 文本模型文件与运行入口存在。

这些是该次读取结果，不是固定产品性能指标。没有在本次验收中执行 Qwen 推理、修改板端环境或发送桌面键鼠动作。

## 未覆盖范围

- 正式云端账户、付费额度与服务商可用性，需要在界面配置自己的 Key 后测试。
- 多屏混合 DPI 下的物理点击坐标映射、HID 硬件协议、自动点击和跨应用流程未实现。
- 没有用下位机完成通用模型质量验收；现有 RK 算术测试有未通过记录。
- Windows 其他电脑、长期稳定性、安装签名与自动更新未做验收。portable 程序仍需要本机现有 RK OCR 环境。
