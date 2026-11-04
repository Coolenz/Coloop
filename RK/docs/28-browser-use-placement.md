# Browser Use 集成位置评估与本机实测

核对日期：2026-11-02，Asia/Shanghai。任务是判断 Browser Use 放 RK 还是上位机效果更好。本次完成官方源码核对、真实 Windows SDK 浏览器闭环、板端只读预检及现有模型协议兼容性检查。

## 结论

**推荐将 Browser Use 作为 Windows 上位机的独立 Python sidecar，Coloop 管理任务、进程与结果；RK 保留本地模型、Mem0 和 USB 执行能力。** 模型部署位置与 Browser Use 部署位置可以分开选择。把 Python 框架搬到 RK 不会自动提升模型推理速度或网页规划质量。

这是结合当前工程与兼容性实测的架构判断，**没有完成两种部署的同题模型成功率/延迟 A/B，不能宣称已经证明全局最优**。本次也没有把试验替换为 Coloop 产品默认入口。

| 部署方式 | 适用性 | 当前判断 |
| --- | --- | --- |
| Browser Use、Chrome、Agent 全在 RK | 适合真正需要板端独立浏览器的设备 | 与当前 Windows 浏览器、登录态和窗口不一致；新增 Python 3.11+ 与浏览器维护、消耗板端资源。当前目标不选。 |
| Browser Use 在 RK，经隧道 CDP 控制 Windows Chrome | 可保持规划循环在设备侧 | 技术上可行，但 DOM/CDP 控制需要跨 USB 网络；仍属于软件浏览器控制，不会变成 USB HID。需要新环境，对当前目标缺少收益证据。 |
| Browser Use 与 Chrome 在 Windows，模型按任务选择 | 浏览器与框架同主机，易与 Electron/TS 衔接 | **推荐**。独立环境已经跑通；模型可用云端或另经鉴权隧道调用 RK，质量须分别验收。 |

上游 [Python 依赖声明](https://github.com/browser-use/browser-use/blob/0.13.14/pyproject.toml)要求 Python >=3.11，提供 CDP、浏览器和多种模型客户端；[官方 CDP 示例](https://github.com/browser-use/browser-use/blob/main/examples/browser/using_cdp.py)展示控制独立浏览器的方式。当前板端实测 Python 3.10.12/aarch64，因此不是在现有虚拟环境直接安装即可。ARM 不是这里的否决理由，独立升级环境仍可另行评估。

## 推荐的两种运行模式

### 完整网页自动化

```text
Coloop（任务、取消、结果、模型选择）
  → Windows Python sidecar：Browser Use Agent / DOM / 工具执行 / 回读
      → 独立 Chrome profile，通过 CDP 控制
      → 明确选择的模型：云端，或鉴权 SSH 隧道后的 RK HTTP
RK：按需提供本地推理与 Mem0；该模式的网页输入不经过 RK USB
```

若目标优先是通用网页能力、中文表单、结构化提取和维护成本，这一模式最值得推进。模型质量由实际任务评测决定，不能把使用框架等同于提升 Qwen 4B 的推理能力。云端规划会接收实际传给模型的 DOM、任务与历史，视觉开启时还可能有截图；仅将程序安装在 Windows 或 RK，都不代表数据留在本地。

后续产品接入建议使用受管理的子进程与带任务 ID 的 JSONL/stdin/stdout 协议，将 SDK 诊断放 stderr；取消/超时需要结束本任务拥有的浏览器与进程。现有 Python stdout 会输出 SDK 日志，**本次 probe 不是已经实现该协议的产品 sidecar**。独立 profile 不复用个人默认 Chrome；调试接口仅回环，不向 LAN 暴露。模型凭据由已有受保护服务传入内存，不写网页或普通结果日志。

### 保留现有纯 USB 鼠标路径

当前默认主线见 [云端规划与 RK USB](27-cloud-hid-relay.md)及 `D:/Coloop/docs/cloud-ui-agent.md`：UIA/OCR 观察、云端语义计划、实时绑定、RK HID、业务核验。Browser Use 的原生点击、填入、导航及脚本执行属于 CDP 软件控制，不能与该主线混称硬件输入。

在此约束下，Browser Use 只能作为上位机候选观察/规划组件；需要**另行实现**受限工具适配，禁用原生执行动作，并把当前 DOM 元素经窗口身份、可见性、DPI/视口、前台、遮挡及新鲜度校验后交给既有 RK HID 许可链。动作后重新观察和验证业务状态，可能已发送的输入不能盲目重试。DOM 坐标不能直接当成桌面物理像素。

仅注册自定义工具不会自动移除 SDK 默认的 CDP 动作，不能借此声称保留纯 USB。浏览器导航、焦点改变、滚动以及页面脚本也必须按模式明确约束。私密凭据继续走现有 vault 执行器，不传入 Agent 的 `sensitive_data`、DOM 日志或云端模型。此类 HID 适配本次未实现、未验收。

## 本次实际执行与证据

使用 Windows Python 3.12.8，在 `D:/RK/deployment/browser-use/.venv` 新建独立环境，安装 **browser-use==0.13.14**。顶层版本在 `requirements-browser-use.txt`，本轮 Windows 完整解析结果在 `requirements-browser-use.lock.txt`，未修改 host/OCR/Qwen/RKLLM 环境与 Coloop 依赖。

真实 SDK 入口为 [probe_browser_use.py](../tools/probe_browser_use.py)。它启动回环随机端口的合成页面和独立 headless Chrome，依次完成 DOM 观察、中文随机串填写、按钮点击、精确回读、链接跳转、下一页核验与清理。不是手写 CDP 冒充 Browser Use，也没有使用假浏览器。

| 记录 | 结果与范围 |
| --- | --- |
| `logs/browser-use-host-20261102-run-1/summary.json` | SDK 闭环成功，总计 4.172 秒，含浏览器启动/清理；服务端在 Chrome 关闭预连接时有连接重置诊断，保留原始记录。 |
| `logs/browser-use-host-20261102-run-2/summary.json` | 处理上述正常断连后的最终源码复测成功，总计 3.469 秒；DOM 130 UTF-8 字节，中文随机串精确一致，下一页通过。 |
| 同目录 `dom.txt` / `page.png` | 真实 SDK DOM 投影及填写后截图。独立 profile 保留在日志目录及 SDK 管理的临时目录，不含个人登录态。 |
| `logs/browser-use-board-20261102-preflight.txt` | 首次未带模型服务鉴权，health 401，不能作为模型未就绪证据。 |
| `logs/browser-use-board-20261102-preflight-2.txt` | 使用板端已有令牌在板端本地只读查询，未输出令牌。health ready=true，Qwen4B/Runtime1.3.0/context16384/protocol3，原 worker PID2207；板端只读段约11.7ms。 |
| `logs/browser-use-assessment-20261102/assessment.json` | 实际包版本、PyPI wheel/sdist URL/字节/SHA256、关键源码哈希，以及离线协议兼容性结果。 |

两次浏览器运行均 **0 次模型调用、0 次 RK USB 动作**。3.469 秒只是固定小型合成页面 SDK 执行探针，不能与历史 Bilibili 模型/HID业务的32.309秒比较，不能推断提速倍数或通用成功率。每步保存开始/结束、成功/失败及本机单调耗时；总计与内部阶段存在包含关系，不能再相加。板端墙钟与 Windows 不一致，分别保留原值，不跨主机相减。

### 现有 RK 模型接口不是即插即用

在本机直接调用当前 `rk-opencode/bridge/protocol.py` 的 `prepare`，用已安装 SDK 的 `SystemPrompt` 生成实际提示，输出预算256、单步1动作：

| SDK 提示模式 | 系统提示 UTF-8 字节 | 桥接后字节 | 是否通过现有16K保守字节预算 |
| --- | ---: | ---: | --- |
| 默认 | 24,121 | 24,175 | 否 |
| 关闭思考 | 22,120 | 22,174 | 否 |
| Flash | 2,399 | 2,453 | 仅该最小输入通过；尚未加真实 DOM/历史/schema |

此处16K是当前桥接层的字节保护规则，**不是 tokenizer 实测 token 数**；未删保护或静默截断来让测试通过。RK 的 `thinking=false` 与 SDK 的 `use_thinking=False` 是两层不同配置。

[SDK ChatOpenAI 实现](https://github.com/browser-use/browser-use/blob/0.13.14/browser_use/llm/openai/chat.py)默认使用 `response_format=json_schema` 请求结构化结果。现有 RK prepare 对有无该字段生成完全相同的提示，未将 schema 注入或施加服务端约束；图像 content 被当前文字桥明确拒绝。因此设置 `base_url` 不等于完成模型适配。Flash、小动作集、纯文本、显式 schema 提示、预算控制和严格解析都需独立验证。当前 RK API 的输出参数是 `max_tokens`；SDK 的 `max_completion_tokens` 也需要适配，不能假定生效。

没有运行板端 Browser Use 部署、NPU 浏览器 Agent 或 HID 业务验收；原因是本次选型已确认环境及协议差异，未为调研改动正在运行的服务。没有调用付费云账户，也未打开真实账号网站。现有板端模型、权重、运行库、worker、默认启动器及记忆内容均未变。

## 复现

从 `D:/RK` 执行，使用独立解释器，日志目录必须是新目录：

```powershell
uv venv --python D:/RK/.venv/Scripts/python.exe D:/RK/deployment/browser-use/.venv
uv pip install --python D:/RK/deployment/browser-use/.venv/Scripts/python.exe -r requirements-browser-use.lock.txt
./deployment/browser-use/.venv/Scripts/python.exe tools/probe_browser_use.py --output-dir logs/browser-use-host-新时间戳
./.venv/Scripts/python.exe -m ruff check tools/probe_browser_use.py
./.venv/Scripts/python.exe -m py_compile tools/probe_browser_use.py
```

环境已经存在时跳过创建步骤。默认使用 `C:/Program Files/Google/Chrome/Application/chrome.exe`，可用 `--chrome` 指定其他 Chromium 路径。遥测、Browser Use 云同步、云提示及默认扩展在探针内关闭，未使用 Browser Use Cloud；这些开关不是通用网络隔离或 DLP。允许域名仅用于该合成回环页面，不代表任意网页子资源被网络沙箱拦截。

后续优先级：先做上位机独立 CDP 模式的有限任务 Agent 与取消/结果协议，再按确有需要做 RK Flash 模型适配；若必须纯 USB，则将 HID 后端适配作为单独能力验收。最终用相同题集比较成功率、端到端P50/P95、模型调用与输入量，而不是仅比较框架安装位置。
