# RK 私密凭据库与 Coloop 登录（2026-10-30）

普通长期记忆继续使用 Mem0 2.2.1。凭据属于同一记忆系统的私密分区：Mem0 的 `private_refs` 集合保存可检索的引用，受保护的凭据服务保存账号密码正文。设备通过现有记忆工具知道对应记录在哪里、如何使用；正文不参与自动提取、摘要或模型上下文。Coloop 现在统一从「记忆」页面保存、搜索和管理两类记忆；填入阶段主机仅传记录编号和字段选择，板端根服务从密文库取原值，经 USB HID 填入经主机校验的专用登录窗口；没有读取密码接口或云端明文回包。

## 统一记忆目录

用户后续明确要求设备能够经记忆系统发现私密内容的获取位置，不能形成脱离记忆系统的孤立库。`agent/private_memory.py` 已接入真实 Mem0，形成「记忆目录＋受保护正文后端」。引用包括 `record_id`、网站、`rk-vault://<record_id>` 位置、`credential_vault` 提供方、`coloop_private_login` 执行器、`plaintext_readable=false` 与目标校验要求，不包含账号密码。

原有 `rk_memory_memory` 的 `search`、`get`（键 `private:credential:<记录编号>`）以及 `/recall` 可返回引用；新增 `lookup_private` 显式查询、`sync_private` 核对目录。每次查询先读取凭据服务的严格元数据目录，再使用本地 BGE 和 Mem0 `add(infer=False)` / `search` 维护专用集合，创建记录不需要另行手工写一条普通记忆。删除后的引用在下次查询前失效；提供方不可用时不返回旧引用。专用集合按配置绑定 user/project，不混入普通 facts/capsules、自动提取和摘要压缩。普通记忆 `set/delete` 不能改写或删除受保护引用，凭据仍须从 Coloop 的授权入口管理；引用也不授予 HID 执行许可。

```bash
cd ~/rk-opencode
python3 scripts/memoryctl.py lookup_private 'https://example.com 的登录信息在哪里'
python3 scripts/memoryctl.py search 'https://example.com 的登录凭据'
```

安装/更新目录连接使用 `scripts/setup-private-memory.py`，已有 Mem0 需启用。它保留旧源码和配置，等待自己的前台活动且无其他前台会话时重启记忆服务，仅新增 `private_credentials` 配置和引用集合；不移动凭据正文，不替换模型、库、嵌入或事实数据。当前已部署，记录在 `logs/private-memory-deploy-20261030-144435/manifest.json`。原 Coloop 独立包的凭据接口保持兼容；新启动的本地 Agent 可加载新增工具说明，原有 `search` 查询也走统一目录。

### 本次目录整合的实测证据

后续严格的完整 Agent 验收已通过：`logs/private-memory-final-20261030-155915/report.json` 共25项，真实 OpenCode/NPU 完成一次 `rk_memory_memory` 查询，最终整段精确返回未知 `rk-vault://<UUID> | coloop_private_login`，退出0，约39.96秒，秘密未进入会话。此前启动超时、错误工具参数、最终JSON拒绝及抄错SDK内部ID的各轮输出保留。`155332` 原报告曾因仅检查子串误判通过，补充的 `acceptance-audit.json` 明确不验收；最终采用整段严格匹配，不用那轮证明成功。这仍不是自动完成公网登录的验收。

`logs/private-memory-acceptance-20261030-150409/report.json` 的20项检查通过。使用板端真实 Mem02.2.1、本地BGE嵌入、生产记忆HTTP及真实MCP派发；不提供网站/编号的语义改写也找到了本轮随机引用（该例score约0.611，不是通用检索准确率）。另外验证了普通search、自动recall、1200字节预算、独立SDK重新打开后同ID恢复、项目隔离、普通记忆不可覆写/删除私密项、删除后生产及独立SDK索引失效，以及32个Mem0存储文件中未出现合成账号/密码。此前两条普通事实及任务队列状态不变，没有调用真实云账户。

`logs/private-memory-model-20261030-150717/report.json`：实际Mem0召回引用后交给已就绪的Qwen3.5-4B/Runtime1.3.0，模型准确返回本轮未知记录编号、完整 `rk-vault://` 位置与Coloop调用方式，正常stop，约19.23秒。请求cache off、metadata-only且确认回执，worker日志新增0字节，账号密码没有进入模型请求或答案；测试后仅删除自己的合成凭据及引用，释放自己的活动租约。没有启动、重建或停止共享模型。该测试证明真实本地模型能消费目录信息，不等于完整Agent自主查询或自动登录任务通过。

本地11项相关Python单测、1项记忆插件Node回归及Ruff/语法检查通过。私密引用索引使用真实SDK `infer=False`，独立验收中禁止其LLM provider运行；凭据正文没有进入Mem0。保留SDK原有未安装可选spaCy/BM25的离线告警，未下载或升级资源，当前仍是稠密BGE检索。

首轮完整OpenCode会话在240秒超时（`logs/private-memory-acceptance-20261030-144830/`），该轮此前15项目录检查通过，但不记作完整通过；下一轮保守活动闸门发现其他租约后未运行NPU（`145640`）。完整会话与上述HTTP/MCP/模型消费测试分别记录，不能用其中一层替代另一层，也不覆盖既有HID或公网登录验收。板端墙钟存在明显偏差，因此以上引用电脑侧固定目录，板端原目录在对应exit/report里保留；单次耗时采用monotonic。

### 普通与私密记忆的统一管理入口

Coloop 左侧仅保留一个「记忆」入口：共用搜索、分页列表、「全部／普通记忆／私密记忆」分类和「新建记忆」。普通内容由原 Mem0 facts 保存，可编辑、删除；编辑生成新版本，保留原来源历史、到期时间并标为未核实。删除按当前记录的逻辑键清理全部版本，避免旧值复活。派生摘要继续由原来源失效规则管理，页面展示当前事实。私密项只显示网站、编号位置和「本地使用」，新建／删除仍走受保护凭据后端，然后同步同一目录；目录暂不可用不会重复保存凭据。当前私密正文没有查看／导出／修改接口，需删除后重新保存。

板端 `Mem0Engine.browse/revise/remove_record` 与固定 stdio 客户端 `agent/credential_memory_client.py` 为可信本地管理入口；MCP 工具枚举没有开放这些管理操作。搜索优先跨两类做字面匹配，无匹配时再使用原本地 BGE/Mem0 语义候选；页面标明语义候选。`browse` 不返回私密正文。整页进入既有观察保护，离页且专用登录窗口关闭后解除。

部署使用 `scripts/setup-memory-management.py`，它更新现有 Mem0 源码并安装 root 所有的固定客户端，保留源码备份，不更换模型／嵌入／USB 或重启凭据服务。更新记录为 `logs/private-memory-deploy-20261030-163228/manifest.json`；真实 SDK 管理检查在 `logs/unified-memory-sdk-20261030-164144/report.json`：27项通过，覆盖两类浏览、分页、字面搜索、版本与TTL保留、删除不复活，以及32个实际存储文件的秘密扫描。14项相关Python测试、Ruff与语法检查通过；Coloop全量502项通过，包含并行模块，不能全算本功能新增。

源码界面真实板端流程在 `D:\Coloop\.qa\memory-management-1793349671356/report.json` 通过新建／搜索／分类／编辑／两类删除及专用登录窗口打开，1440×940与1060×720已目视检查。该轮Mem0文件扫描路径错误、实际扫描0文件，因此补充 `acceptance-audit.json` 明确该项不构成证据；真实非空文件扫描以SDK和后续打包版记录为准。两轮小窗口溢出失败也保留。新版独立包和最终界面验收以 [Coloop专题](../../Coloop/docs/private-credentials.md) 为准；旧 `credentials-20261030140855` 包没有统一管理页面。

最终统一管理包为 `D:\Coloop\release\memory-20261030165137\Coloop-0.12.0-memory-Windows-x64.exe`，SHA256 `e3ab86e4b193f67e6a1bc5aa9aa7d302b77b08097d407268ce56d06d9a32ea73`。打包版真实板端管理16项通过，`D:\Coloop\.qa\memory-management-1793350369301/report.json`：实际扫描16个Mem0文件和70个Coloop profile文件均无合成秘密，普通事实／队列不变，cloud调用0，requests／worker日志增量0字节。源码修正后同项16项亦通过。首个memory包漏依赖启动失败，已改为冻结生产依赖闭包，最终包输入及运行依赖通过精确校验，失败产物保留。电脑子仓库当前全量131项（122通过、9项按平台跳过），Coloop 502项通过；未把并行功能当成本任务新增，也未重跑HID／NPU／公网登录。当前安装版和默认启动器未替换。

维护来源为 `rk-opencode/agent/credential_vault.py`、`agent/credential_client.py`、已有 `agent/hid.py` 的匹配副本及 `scripts/rk-credential-vault.service`。安装器 `rk-opencode/scripts/setup-credential-vault.py` 复用固定指纹 SSH、会话级密码与既有 HID 锁；安装独立 systemd 服务，不改 USB Gadget、模型、Mem0 或其他环境。服务使用系统 Python3.10.12 / 发行版 cryptography3.4.8，未升级依赖。数据与密钥位于 root0700 的 `/var/lib/rk-credential-vault`，普通 cat 不可读取；Unix socket 接口仅提供保存、元数据、删除和有心跳/一次性请求的填入。

部署证据在 `logs/credential-vault-deploy-20261030-135035/manifest.json`。本次 root 服务已实际启动，库/密钥权限已验证，Linux5项专项、已有HID2项和桌面4项回归通过。真实 Electron + 根服务 + USB 输入七组验收通过，证据为 `D:\Coloop\.qa\credential-vault-1793340008295\report.json`：账号密码原样输入、失焦中止、跨源拒绝、观察/任务拦截、无云调用、Mem0状态不变、模型请求和worker日志新增0字节。使用合成HTTPS scheme页面，不是公网登录或模型规划验收。

首版每字段1–64可打印ASCII字符，需美式英文键盘及Caps Lock关闭，只支持同源HTTPS网站。普通/跨源iframe、SSO、验证码、第三方资源和弹窗可能不可用，不自动清空字段、重试或提交登录。窗口/页面焦点持续检查不构成原子硬件事务；失焦、断线或超时可留下部分输入，不能承诺瞬间零字符误投。观察屏蔽覆盖Coloop自身和系统提供的窗口捕获保护，不控制其他软件或管理员。凭据会交给被允许的登录网站；不交云端AI，不等于网站不会处理它。

完整协议、存储权限、密钥/备份、明文生命周期、信任边界、失败迭代和使用说明见 [Coloop专题](../../Coloop/docs/private-credentials.md)。源码存在、板端服务已运行、独立桌面产物及已安装程序的状态分别记录；本次没有覆盖已安装版或发布到远端。

历史独立凭据程序（不含统一管理页）：`D:\Coloop\release\credentials-20261030140855\Coloop-0.12.0-credentials-Windows-x64.exe`，SHA256 `56a469a81b0d3fad7e98c9084cdc26324395cba8380421bd29870a683837934f`。包内冻结文件与附加资源逐项匹配，实际打包版界面启动和两个尺寸检查通过。ARM64再次运行5项专项并确认已部署Python源码SHA一致，证据 `logs/credential-vault-board-tests-20261030-141148/`。没有把独立包当作用户当前安装版已更新。
