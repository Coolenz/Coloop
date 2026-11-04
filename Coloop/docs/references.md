# 参考来源与第三方组件

## 产品参考

[Violoop 官方介绍](https://violoop.ai/)：参考屏幕理解、云端/端侧模型、任务工作台、本地记录的产品思路。没有复制其品牌、页面、软件或硬件协议。本版的范围与当前未实现内容见 README。

## 前端 skill

按要求从 GitHub 安装 [anthropics/skills 的 frontend-design](https://github.com/anthropics/skills/tree/main/skills/frontend-design)。本机路径为 `C:\Users\52760\.codex\skills\frontend-design\SKILL.md`，安装日期 2026-10-28。先制定 `design.md` 中的视觉 token 与布局，再实现并用真实 Electron 截图复核。skill 本身及许可证保留在安装目录，不作为程序运行依赖。

## 工程依赖

原生 Agent Hook 采用 [OpenCode 1.19.5 / MIT](https://github.com/anomalyco/opencode/tree/810c0eba1a7348036f8bdf61e6632d0c36c6876c) 的插件与 SDK API，固定源码提交 `810c0eba1a7348036f8bdf61e6632d0c36c6876c`。参考 [HumanLayer / Apache-2.0](https://github.com/humanlayer/humanlayer/tree/316e74ef9af0b7b3d64ac45b5eb93415b3ed2204) 的会话镜像设计；其 OpenCode 2.x 插件和运行库没有安装或打包。适配器、固定版本差异与真实 pending 等待方式见 [原生 Hook 说明](native-agent-hooks.md)。

| 组件                 | 用途                             | 来源                                          |
| -------------------- | -------------------------------- | --------------------------------------------- |
| Electron             | Windows 桌面外壳、隔离与原生接口 | https://www.electronjs.org/                   |
| React                | 界面状态与组件                   | https://react.dev/                            |
| TypeScript           | 静态类型                         | https://www.typescriptlang.org/               |
| electron-vite / Vite | 主进程、preload、renderer 构建   | https://electron-vite.org/                    |
| electron-builder     | Windows portable 打包            | https://www.electron.build/                   |
| ssh2                 | USB 网络的 SSH 通道              | https://github.com/mscdex/ssh2                |
| Zod                  | IPC 与外部数据 schema            | https://zod.dev/                              |
| Lucide               | 界面图标                         | https://lucide.dev/                           |
| Vitest / Playwright  | 领域测试、真实 Electron 联调     | https://vitest.dev/ / https://playwright.dev/ |
| RapidOCR             | 复用本机中英文 OCR               | https://github.com/RapidAI/RapidOCR           |

具体版本见 package-lock 和 RK 的 `requirements-screen-ocr.lock.txt`，各依赖分别保留原许可证。RapidOCR 与模型沿用 RK 已有安装记录、model-manifest.json 和许可证；本仓库不复制模型、字体或整个 Python 环境。

安全架构参考 [Electron 官方 Security](https://www.electronjs.org/docs/latest/tutorial/security)。RK 接口以 `D:\RK\README.md`、`config/board.json`、`docs/09-qwen35.md`、`docs/10-screen-ocr.md` 和实际入口代码为准。
