# Cua Driver 本地运行时

Coloop 的 Windows 构建固定使用官方稳定版 **Cua Driver 0.38.0**，不使用已弃用的 `cua-computer` / `cua-agent`。版本来源为 [cua-driver-rs-v0.38.0](https://github.com/trycua/cua/releases/tag/cua-driver-rs-v0.38.0)。业务挂接和执行边界参见同批次 Cua 集成代码。

## 准备与打包

在项目根目录运行：

```powershell
node scripts/setup-cua.mjs
```

需要 Windows x64、Node 及系统 Windows PowerShell。脚本下载固定发布资产，解包到项目 `.cache/cua-driver`，不运行上游安装脚本，不修改全局 PATH、登录自启、用户 Agent 配置，也不停止其他 Cua 进程。

校验依次为：

1. 固定 ZIP SHA256：`5edaa74d0afa1b55a9668dbc4f32736507bd2bd4d75b18ca1dc8881bb12402b5`。
2. 校验官方 `checksums.txt` 本身的固定 SHA256，再核对其中 ZIP 条目。
3. 三个可执行文件必须通过 Windows Authenticode 校验，发布者为 `Cua AI, Inc.`。
4. 读取 `--version` 必须为 `cua-driver 0.38.0`，`list-tools` 必须包含观察与鼠标接口。

上游同时提供 Sigstore bundle，本脚本没有验证该 bundle；签名验证采用 Windows Authenticode。首次下载通过 Windows PowerShell 使用 Windows 网络/代理配置；下载缓存每次都重新计算 SHA256。缓存完整时不必重新下载，但 Windows 信任链校验仍可能访问系统证书服务。

运行时目录包括：

```text
.cache/cua-driver/
  cua-driver.exe
  cua-driver-uia.exe
  cua-cursor-theme.exe
  LICENSE-cua-driver.txt
  manifest.json
```

Electron 打包应将该目录复制到 `resources/runtime/cua-driver`。`manifest.json` 包含来源、固定版本、归档及各 exe 的 SHA256、签名验证结果。Driver 为 MIT 许可；本安装不包含 Spaces 或可选感知模型扩展。

Coloop 启动自己拥有的进程时应设置独立 `CUA_DRIVER_RS_HOME`，并设置：

```text
CUA_DRIVER_RS_TELEMETRY_ENABLED=0
CUA_TELEMETRY_ENABLED=0
CUA_DRIVER_RS_UPDATE_CHECK=false
```

`cua-driver mcp --direct` 在 Windows 中让 stdio 子进程拥有运行时，stdin 结束后关闭。无需启动全局 daemon，也无需监听网络端口。安装脚本只执行版本和工具清单探测，不发出鼠标、键盘或窗口操作。

## 固定版本的坐标与观察契约

以下契约已同时核对 0.38.0 可执行文件的 `describe` 输出与该 tag 的源码；升级时应重做契约验证，不能把 `main` 分支的新描述直接用于旧二进制。

| 接口                     | 0.38.0 Windows 契约                                                                                                                                            |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get_window_state`       | 必须传 `pid` 和数值 `window_id`；`tree_format:"elements"` 返回结构化元素；`include_screenshot:false` 可以只读取 UIA，仍生成 `snapshot_id` 和 `element_token`。 |
| 元素 `frame`             | `{x,y,w,h}` 为全局屏幕坐标；不是相对窗口坐标。                                                                                                                 |
| 元素 `screenshot_frame`  | 带截图时额外返回，位于同次返回 PNG 的像素坐标系，已考虑窗口原点与缩放。                                                                                        |
| `click` / `double_click` | 优先用同一窗口最近观察的 `element_token`；像素模式 `x,y` 为窗口截图局部像素，不能直接传全局 `frame` 中的坐标。                                                 |
| `click.capture_id`       | 传入时与指定捕获绑定，并在原生输入前一次性消费。                                                                                                               |
| `move_cursor`            | 默认/window scope 只移动 Agent overlay；`scope:"desktop"` 才通过 `SetCursorPos` 移动真实 OS 指针。因此不能把默认调用成功当成真实鼠标移动。                     |
| `scroll`                 | `direction` 必填，`amount` 为 1–50，`by` 为 `line` 或 `page`；Windows 默认通过窗口消息滚动。`element_token` 在该版本 Windows 滚动中尚不用于 UIA 焦点切换。     |

`get_window_state` 默认有 250 元素预算，UIA 步行预算默认 1000 ms。读取结果可能标记 `truncated`、`elements_complete:false`，不能将被截断的树解释成完整屏幕。后一次同窗口观察会使前一次元素 token 失效。`delivery_mode:"background"` 是鼠标操作默认路径；`background_unavailable` 是明确能力限制，不代表任务成功，也不应无条件重复原动作。

原始依据：[Windows 工具实现](https://github.com/trycua/cua/blob/cua-driver-rs-v0.38.0/libs/cua-driver/rust/crates/platform-windows/src/tools/impl_.rs)、[元素坐标转换](https://github.com/trycua/cua/blob/cua-driver-rs-v0.38.0/libs/cua-driver/rust/crates/cua-driver-core/src/element_frame.rs)。

## 本轮验证范围

2026-11-05：已在本机实际下载固定 ZIP、核对上述 SHA256、验证三个 exe 的发布者签名，并通过版本与工具清单探测。安装脚本成功执行。此项证明运行时准备完成，不代表 Coloop 的模型任务已经完成桌面业务闭环；真实输入验收须由同批次业务测试另行记录。
