# 本机交付约定

用户于 2026-11-06 明确要求：以后修改 Coloop 后，验证通过就直接替换本机安装版，不再只交付源码或独立 release 包，也不重复询问是否部署。

- 固定安装目录：`%LOCALAPPDATA%\Programs\Coloop`。桌面快捷方式与所有根目录 `start*.cmd` 统一启动这里的 `Coloop.exe`。
- 每次应用代码修改完成后，执行相应测试和 `npm run build`，将完整目录包构建到新的 release 暂存目录。包含全部生产依赖和 `extraResources`，不可只覆盖 exe 或 out。
- 打包的 `afterPack` hook 必须补齐并校验生产依赖和必需 peerDependencies；不可仅在项目 release 子目录做启动验证，因为 Node 会向上借用开发目录依赖。
- 使用隔离的 `COLOOP_DATA_DIR` 验证目录包启动，并以 `COLOOP_EXECUTABLE` 指定实际安装路径运行 `tests/proactive-package-smoke.mjs`；相关改动涉及运行依赖时还需运行 `tests/runtime-package-smoke.mjs`。
- 使用 `scripts/install-local.ps1 -PackageDirectory <已验证的 win-unpacked 目录>` 替换安装版。脚本保留旧安装备份，不触碰 `%APPDATA%\coloop` 等用户数据。旧版 `app.asar` 不应混入新的非 asar 包。
- 安装前检查当前进程和任务；需要重启时先正常退出应用，不强杀正在执行的用户任务。然后验证实际安装路径并从统一入口启动。
- 完成时报告安装版验证结果；如果有实际阻塞，明确说明，不能把源码构建完成等同于部署完成。
- 仅文档修改不必重新打包。用户明确要求暂不部署时，以该次指示为准。
