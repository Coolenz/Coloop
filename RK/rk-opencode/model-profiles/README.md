# RK Agent 多模型接入

2026-10-30。普通 OpenCode、记忆和桌面业务不再依赖某个参数规模。模型描述负责声明权重、匹配的 RKLLM 头文件/运行库、模板、上下文、输出与缓存能力。默认仍用 `qwen35-4b`。这是当前 RKLLM C API 的适配结构；其他推理引擎或不兼容的 SDK ABI 仍需单独后端，不能只修改模型名。

## 接入一个 Qwen 8B

这里以 **Qwen3-8B** 为命名示例；如果实际使用其他 Qwen 8B，按实际模型创建新文件。仓库没有提供或验证 8B 权重，示例中的 4096 也不是转换上限证据。

1. 在独立应用目录准备适用于 RK3588 的 `.rkllm` 权重和匹配的 `include/rkllm.h`、`lib/librkllmrt.so`。沿用项目下载/转换/上传工具，记录 revision、许可证、大小、SHA256 和转换参数；不要覆盖原 4B 应用。
2. 复制 `qwen3-8b.example.json` 为 `qwen3-8b.json`。填写真实文件名、应用路径、Runtime 版本和模型转换允许的 `context_limit`，并核对 `context`、嵌入方式和运行参数。带 `.example` 的文件不能作为 profile 启动。新模型默认关闭原生缓存，完成增量缓存验证后再启用。
3. 使用主机 `host.py deploy --profile qwen3-8b` 上传描述与源码并编译。它不会下载或上传权重；构建失败会明确报错，现有常驻服务不因源码上传而停止。下一次启动会检查配置并切换。也可以只同步新增描述，复用已经更新的 Agent 源码。
4. 在板端预检，再启动指定 profile：

```bash
cd ~/rk-opencode
python3 model_profiles.py check --profile qwen3-8b
RK_AGENT_PROFILE=qwen3-8b bash scripts/opencode.sh
# 仅启动服务 / 验证真实文件工具：
RK_AGENT_PROFILE=qwen3-8b bash scripts/start.sh
RK_AGENT_PROFILE=qwen3-8b bash scripts/smoke-agent.sh
# 同时检查短答、中文、错误拒绝和未知随机文件工具闭环：
RK_AGENT_PROFILE=qwen3-8b python3 scripts/smoke-model-profile.py
```

Windows 从 `D:\RK` 启动，权限沿用所选 agent：

```powershell
powershell -ExecutionPolicy Bypass -File rk-opencode/scripts/launch.ps1 -Profile qwen3-8b
powershell -ExecutionPolicy Bypass -File rk-opencode/scripts/launch.ps1 -Profile qwen3-8b -Agent rk-memory
powershell -ExecutionPolicy Bypass -File rk-opencode/scripts/launch.ps1 -Profile qwen3-8b -Agent rk-desktop-fast
# 桌面助手仍需另行启动，并保持授权窗口前台。测试入口也可指定：
powershell -ExecutionPolicy Bypass -File rk-opencode/scripts/testbench.ps1 -Profile qwen3-8b
```

`RK_AGENT_PROFILE` 是本次进程选择，不会修改全局默认值。每个新会话应使用相同 profile 参数；未指定时仍选 4B。新模型应分别验收普通回答、模型产生的工具 JSON、实际随机文件读取、跨会话记忆和桌面动作。配置可加载、编译成功或 HTTP 200 都不能证明模型有合格的 Agent 能力。

## 配置与边界

| 字段 | 含义 |
| --- | --- |
| `model_id` / `name` | HTTP 模型 ID 与界面名称；ID 不决定模板或模型能力 |
| `app` / `model` | 独立应用目录与权重名；相对权重路径以应用目录为基准 |
| `runtime` / `include` | 应用内运行库/头文件目录，默认 `lib` / `include` |
| `runtime_version` | 核对过的版本说明，不是自动检测结果 |
| `lock` | 相对应用目录的锁路径；必须与该权重的其他启动入口使用同一把锁 |
| `context_limit` / `context` | 已核对的转换上限 / 本次运行上限，允许 512..262144，但实际受权重、SDK 和内存约束 |
| `max_output` / `default_output` | HTTP 允许的最大 / 默认输出；当前 worker 支持至 2048，必须小于运行上下文 |
| `prompt_format` | `embedded` 使用权重内置模板，桥接只构建文本会话；`deepseek-r1` 使用既有显式 R1 模板并要求完整结束思考 |
| `thinking` | 传给 SDK 的思考开关；桥接不向 OpenCode 暴露推理段 |
| `native_cache` / `cache_mode` | 是否已允许原生增量能力 / 默认模式。手写 R1 模板禁止原生增量 |
| `embed_flash` / `base_domain_id` / `n_keep` | 必须按该模型与 SDK 的真实要求核对，不能仅按“Qwen”名称复制 |
| `agent_config` | 选择已有权限模板 `opencode-qwen.json` 或 `opencode.json`，不在 profile 中新增工具授权 |

支持进程环境覆盖 `RKLLM_APP`、`RKLLM_MODEL`、`RKLLM_RUNTIME`、`RKLLM_CONTEXT`、`RK_AGENT_MODEL_ID`、`RK_AGENT_CACHE_MODE`。覆盖上下文仍不能超过描述的转换上限。应用目录改变时锁仍需与其他应用入口一致。

启动器从同一描述生成 `.runtime/opencode-<profile>-<fingerprint>.json`，同步 `model`、`small_model`、provider 模型目录、上下文和输出限制，保留原提示、插件、MCP 与权限。生成文件只含环境密钥占位符。原 `opencode*.json` 是权限模板，直接修改其中模型 ID 不再是正常切换方式。

健康检查核对 profile 指纹、上下文、缓存及 worker 协议；指纹包含模型文件大小/mtime、头文件/库信息和关键源码摘要，**不是模型 SHA256，也不是完整性或质量证明**。权重必须另按部署规程校验。构建签名记录 worker 源码、头文件与库的 SHA256，变更后重新编译。二进制更新保留归档；缺少新资产或编译失败时保留正在运行的服务。

Mem0 常驻进程每次维护从已鉴权 `/health` 读取当前实际模型 ID，避免继承启动时的旧 profile。切换期间请求失败按原作业错误处理，不自动猜模型或补造事实。既有事实库、嵌入模型和来源规则不变。

从旧版首次升级时，需在板端正常运行 `bash scripts/stop-memory.sh`、`bash scripts/start-memory.sh`，让常驻 CPU 服务加载新适配器；本次实机已完成。后续切换模型无需因此重启记忆服务。

服务仍只监听 `127.0.0.1:8088`，一次只运行一个模型。切换会结束旧服务并清空它的 KV；已有 OpenCode 会话不能在后台继续使用旧模型 ID。模型锁按描述保留，各应用之间仍需检查 NPU 占用，不意味着跨应用拥有一把全局锁。

## Coloop 受控入口

普通 Hook 和 benchmark 会跟随选定 profile。受控插件的模型 ID 来自主机登记、摘要校验过的固定配置，不接受环境变量改写，仍固定本地 provider、回环地址、metadata-only、cache off、签名许可和原权限。

`python3 model_profiles.py config --profile qwen3-8b --managed` 只生成候选固定配置，不能自行获得登记或签名授权。外部 `D:\Coloop` 当前连接/登记协议仍固定 4B，本次未改动那个独立项目。切换后必须由该主机完成相应模型支持与重新登记；当前不一致会报 `MANAGED_LIVE_MODEL_MISMATCH_REENROLL_REQUIRED` 或限制不匹配错误。普通 RK Agent 的多模型支持不能扩大为完整 Coloop 8B 验收。

## 本次验证

本地 Python、插件测试以及板端构建/真实 HTTP、随机文件读取与模型切换记录见 [VALIDATION.md](../VALIDATION.md)。8B 本身尚未实机验证；桌面 HID 本次不重新执行。原有历史模型质量与性能结论不变。
