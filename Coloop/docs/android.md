# Coloop Android

## 2026-11-01 任务流程补齐（Android 0.6.0）

保持直接进入 Coloop 聊天与原生黑白界面。新增最近任务入口、筛选与对话定位，当前任务可从顶部查看进度或直接补充；补充模式明确原目标并支持取消，校验原任务与补充内容的合计长度。任务回复、完成、失败、停止或中断后可「编辑为新任务」，填入草稿供确认，不自动重发。覆盖非空草稿需先确认。连接阻断提供就地恢复操作，核对不明回执前要求当前电脑任务空闲并二次确认。

最近任务来自当前电脑的公开快照，最多20项；离线仅显示当前进程已有的上次同步内容，不是完整本地归档。本版不新增后台发送、进程结束后的草稿恢复、QQ邮箱跨应用能力或真实RK/HID验收。电脑端继续沿用0.13.0。版本号0.6.0/versionCode7、包名仍为`ai.coloop.mobile`；最终构建摘要和安装包见`release/android/verification-0.6.0.json`与`release/android/Coloop-Android-0.6.0-debug.apk`。本轮原生界面及加密网关验收使用明确的模拟模型/HID，证据位于`.impeccable/review/android-0.6.0/`。

---

## 2026-11-01 UI / UX 交互优化（Android 0.5.1）

安装包：`release/android/Coloop-Android-0.5.1-debug.apk`，versionCode 6。可覆盖同签名旧版，保留配对；电脑端继续使用 0.13.0。

消息超过 2000 的协议长度限制时，保留全文、标红并明确提示缩短，不再静默截断；接近限制时竖屏显示计数。缩短后清除超限错误。任务选项改为点击「完成」才应用，点击「取消」、系统返回或点外部关闭均撤销未应用的编辑；窗口标题与完成条件分别限制 250 / 128，超限时显示原因并禁用完成。离线或已暂停时不再显示缓存的 RK 连接动画。

这是现有黑白 Material 3 界面的交互加固；草稿仍只在当前进程内保留，未增加后台自动发送、进程结束后的草稿恢复或新 RK/HID 任务能力。原生模拟器局部验收见 `.impeccable/review/android-0.5.1/verification.json`，构建摘要见 `release/android/verification-0.5.1.json`；下方 0.5.0 的独立设计复核与硬件历史不作为本版新验收。

---

## 2026-10-31 设计细化交付（Android 0.5.0 / 电脑端沿用 0.13.0）

新版 APK：`release/android/Coloop-Android-0.5.0-debug.apk`；版本号 0.5.0、versionCode 5、包名 `ai.coloop.mobile`。同签名覆盖安装保留配对，不需要卸载。第一次配对仍在电脑「Agent 协调 → 安卓手机连接 → 配对安卓手机」生成二维码；手机顶部设备入口选择「连接另一台电脑」扫码。已配手机打开后自动连接上次选择的电脑，电脑须保持 Coloop 运行。现有电脑端 0.13.0 与固定服务器配置继续使用，无需为这次前端更新重启或重新导入。

这次细化保留石墨黑/白色、双弧标志与原生 Material 3：

- 对话目标与回复分开排布，状态、来源和时间可换行；正文可长按选择/复制，阅读旧消息时可回到最新。
- 输入框显示已设任务选项，点选项可清除；加号内仍可编辑窗口和完成条件。
- 配对采用三步引导，手动链接按需展开；错误保留输入，返回路径可预期。首次配对保留未发草稿，换到另一台电脑清除前一台的任务上下文。
- 连接设置先显示状态与修复，远程地址和电脑标识在高级操作中展开；移除需确认并可取消。离线可重新连接，在线暂停明确引导恢复。
- 横屏收紧顶部与底部布局，保留可读历史和完整的「最新消息」；键盘上方的发送、任务进行中的停止均可操作。离线发送显示原因且保留草稿。
- 修复连接轮询修改设备顺序的问题，重开 App 仍保留上次选定的电脑。

Android JVM 14 项测试通过。实际模拟器的聊天/状态、次级页面、阅读、细化流程分别通过 9、4、2、4 项检查；最终修复验收及独立设计复核见 `release/android/verification-0.5.0.json`。界面证据位于 `.impeccable/review/android-0.5.0/`，规范位于 `android/DESIGN.md`。使用真实 Android、Keystore 与 AES-GCM 协议，RK 模型及 HID 为明确模拟；复制工具栏及动作经过检查，未做剪贴板逐字节比较。手机硬件、相机扫码、运营商网络和新硬件任务不属于本轮验收。

0.4.0 与电脑端 0.13.0 的历史真实 RK/HID 联调记录继续保留下文；这次界面版本没有新增跨应用邮件、中文输入或云端桌面规划能力。

---

## 2026-10-31 Coloop 聊天新版（Android 0.4.0 / 电脑端 0.13.0）

当前安卓包：`release/android/Coloop-Android-0.4.0-debug.apk`。启动电脑使用 `start.cmd` 或 `start-mobile.cmd`，统一优先打开 `release/coloop-connected-0.13.0/win-unpacked/Coloop.exe`。同签名可覆盖旧版；包名仍为 `ai.coloop.mobile`，不会为改名更换配对身份。

首页直接进入 Coloop 聊天，顶部区分电脑离线、RK 连接和本地模型启动。输入消息后，发送键可操作；未就绪时明确提示原因并保留草稿。进度、结果与停止在同一对话中，任务选项放在输入框旁的加号中，设备和原有其他 AI 会话仍可从右上角进入。界面名称统一为 Coloop，协议中的 `violoop` / `violoop_message` 保留以兼容旧客户端。

电脑连接 RK 成功一次后，将凭据绑定设备地址、用户和已验证指纹，用 Windows DPAPI 加密保存在当前用户的 `auto-connection.json`。以后启动和连接中断会自动重试，并按需启动已部署模型；不会自动重放任务或恢复已停止的控制。显式断开会暂停自动连接。手机服务器配置也使用 Windows 加密保存，开启过或已配置固定服务器时自动上线；显式关闭仍保持关闭。

本机已切换到新版并导入现有自有服务器配置。重启后真实 RK SSH 自动连接成功，公网手机通道返回 200 且匹配原电脑身份。隔离硬件连接验收另验证了断开 SSH 后自动恢复，见 `.qa/auto-connection-rk-1793385835399/verification.json`。原先占用模型锁的实验自行结束后，上位机自动启动了现有模型；新版 Android 0.4.0 与电脑端 0.13.0 随后完成 9 项真实公网、RK 和 HID 验收。真实聊天回复没有键鼠动作，随机屏幕数字 `01143524` 经 USB 输入并点击一次，独立窗口和安卓均核验完成，停止后没有第二次提交。记录：`.qa/violoop-rk-live-1793386785409/verification.json`。下面 0.3.0 的记录保留为原构建历史。

模拟器使用实际 Android APK 与 AES-GCM 协议验证聊天、启动等待、草稿保留、连接修复、进度/结果、停止/恢复、离线、深色与1.3字号；RK/HID 明确为模拟，报告 `.qa/coloop-chat-ui-r5/verification.json`。另有 542 项桌面单元测试与 12 项 Android JVM 测试通过。界面证据在 `.impeccable/review/`；设计规范在 `android/DESIGN.md`。这不等同于物理安卓手机运营商流量验收。

第一次连接手机：打开电脑「Agent 协调 → 安卓手机连接 → 配对安卓手机」，在手机从右上角设备入口选择连接新电脑并扫码。已配手机重新打开后自动连接；若旧版使用临时地址，使用新二维码更新到现有固定服务器。配对二维码含授权信息，不公开发布。

---


## 2026-10-31 真实 RK 联调完成

现有 Android 0.3.0 与新的 `release/violoop-rk-0.12.0/win-unpacked/Coloop.exe` 已通过真实公网、真实 RK 本地路由/规划、USB HID 输入点击、独立业务结果与安卓回执的闭环，另验证手机停止真实解析任务。启动使用 `start-violoop.cmd`，APK 无需更换。范围仍为已打开的单窗口 ASCII 输入，不包含 QQ 邮箱中文邮件；证据见 [实机联调](violoop-rk-live.md)。

## 2026-10-31 Violoop 任务入口（0.3.0）

开发源码已增加手机到 RK 桌面任务的独立入口、持久任务编号、解析/执行/结果状态、原任务补充和停止。手机选中已配电脑后进入「给 Violoop 发任务」，配套启动器为 `start-violoop.cmd`。桌面专用 RK 路由接入现有本地/云端隐私协作，当前执行范围仍为已打开的单窗口 ASCII 输入；QQ 邮箱完整流程待实现。本轮模拟器使用明确的模拟 RK/HID，不算真实电脑操作通过。详情及产物见 [Violoop 手机任务](violoop-mobile.md)。

## 2026-10-31 手机端目标更新（待实现）

手机 App 的核心任务是向用户自己的 Violoop 发自然语言消息，由 RK 处理并决定是否调用云端模型，再通过键鼠操作电脑完成指定工作，最后回传进度和结果。首个完整业务场景为打开 QQ 邮箱并发送用户指定邮件。职责、开发顺序与验收条件见 [手机任务主线](development-direction.md#手机任务主线2026-10-31)。

本节为当时的目标记录，任务入口现已进入上文 0.3.0 开发构建。下方 0.2.0/0.1.0 记录仅描述旧版会话远程控制；OpenCode 消息送达不代表 Violoop 已启动电脑操作。跨应用邮件操作与发送结果核验仍待开发。

## 2026-10-30 自有服务器更新（0.2.0）

新版 APK 为 `release/android/Coloop-Android-0.2.0-debug.apk`，配套桌面程序为 `release/aliyun-companion-0.12.0/win-unpacked/Coloop.exe`，独立启动入口 `start-mobile.cmd`，没有改动其他桌面版本的启动优先级。安装 0.2.0 可以覆盖本项目同签名调试版本。

已在用户购买的阿里云雅加达 Ubuntu 24.04 部署 HTTPS 应用后端。未带或错误访问口令返回 401；电脑连接另用随机 256 位密钥，控制消息继续端到端加密。用户口令不写在仓库、通用安装包或普通状态快照中。第一次在新版桌面「Agent 协调 → 安卓手机连接」导入私有服务器 JSON，再开启连接并扫码。配置文件保存在用户目录 `.codex/secrets/coloop` 中，不放在项目发布包里。

无域名也可用受信任的公网 IP 证书；服务器定时续期和续期演练已经验证。部署、鉴权、协议与运维细节见 [自有服务器连接](owned-server.md)。下面的 0.1.0 文档保留为旧版行为记录；自有服务器是新增连接方式，不要求 Cloudflare。

本轮验证：513 项 Vitest、8 项 Android JVM 测试，打包后的桌面程序经真实阿里云 HTTPS 完成 6 项流程验收。实际 Android Emulator 完成配对、发送要求、进度与来源回执、停止等待确认、强制结束进程后恢复已配连接。使用明确的合成会话，没有调用真实模型或操控用户的真实 AI 任务；没有把模拟器测试记作手机运营商异网实测。

验收记录：`.qa/mobile-1793373082121/results.json`、`.qa/owned-server-proof/verification.json`、`.qa/android-owned-live/`。测试期间的配对邀请只用于隔离配置，收尾关闭测试电脑连接。

---

日期：2026-10-30。原生 Kotlin / Jetpack Compose Material 3 应用，包名 `ai.coloop.mobile`，最低 Android 8.0（API 26），目标 API 36。手机端以中文操作，品牌沿用 Coloop 石墨黑与白色；支持系统深色主题与字号设置。

交付文件：

- 安卓安装包：`release/android/Coloop-Android-0.1.0-debug.apk`（18,693,731 字节）。SHA256 `3745293844a8c57fa04e971c0be2de6e5df5ad71ea8b70fb81436f6968eff560`。
- 配套上位机：`release/android-companion-0.12.0/win-unpacked/Coloop.exe`。保留整个 `win-unpacked` 文件夹；不要单独移动 EXE。
- 启动入口：`start.cmd`。先从托盘退出旧版，以免单实例机制只切回旧窗口。未覆盖系统安装版或用户设置。
- 构建与验收摘要：`release/android/verification.json`。

## 能做什么

- 扫电脑上的配对二维码，或粘贴 `coloop://pair` 链接。
- 查看已配电脑、电脑 AI 会话、净化后的近期进度和控制回执。
- 给已接入的空闲 Windows OpenCode 会话追加要求。
- 停止 Coloop 发起的控制，等待源会话确认；明确恢复后接受新指令，不补发旧指令。
- 更新临时公网地址并用已有设备密钥验证原电脑，或解除配对。

手机不是远程桌面，也没有直接的任意键鼠、Shell、Codex 桌面接管或 RK 桌面任务入口。当前可控制的 Agent 范围沿用 [电脑会话控制](session-control.md)，不是新建一个替代 AI 会话。

## 电脑与手机连接

1. 运行配套 Coloop 0.12 程序，在「Agent 协调 → 安卓手机连接」点「开启手机连接」。
2. 电脑主动建立 Cloudflare Quick Tunnel，不需要用户的服务器、域名或 Cloudflare 账号。
3. 点「配对安卓手机」，在 Android App 选择「配对电脑」扫码；无法使用相机时可复制配对链接到手机粘贴。
4. 配对成功后，选择该电脑和目标会话。电脑及 Coloop 必须持续运行；关闭主窗口会驻留托盘。

这是首版临时隧道。Cloudflare 官方说明其定位为开发测试，无在线保证，重建隧道会改变主机名，且不支持 SSE。本应用使用有界前台轮询，不依赖 SSE。地址改变后，在电脑复制新地址，再在已配电脑的菜单中更新并验证；不必把新地址当作另一台电脑重新信任。[Cloudflare Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)

手机 App 当前在前台约每 2 秒刷新；进入后台即停止轮询。本轮没有提供手机关闭后的推送、后台保活、开机自启、自动唤醒电脑或稳定域名托管。

## 加密与凭据

隧道只发布独立远程网关，不发布原有 Hook 服务、Electron IPC、模型服务或 SSH。控制明文在手机/电脑使用 AES-256-GCM 加解密；配对密钥由电脑上的一次性二维码带出，不放在公网请求 URL。中继可见连接元信息与密文，不持有解密密钥。

配对码 5 分钟有效，单次消费；最多 8 台手机，电脑端可立即吊销。手机凭据使用 Android Keystore 加密并禁止备份/设备迁移；电脑凭据沿 Windows DPAPI 保存。请求包含实例 epoch、严格递增序号、UUID、随机 nonce 和已加密的到期时间；超时结果不明的写命令不会自动重发。

手机得到的是会话公共投影和净化摘要，不接收模型 Key、SSH 密码、配置或原生会话路由。电脑的私密输入保护同样阻止手机读取进度和发出新控制；停止入口保持可用。详细报文见 [跨端协议](mobile-protocol.md)。这些实现及测试不等同于第三方密码学审计。

## 构建

工具链隔离在 `.cache/android-toolchain`，不修改系统 Java、Android SDK、代理或 Windows 虚拟化配置。固定版本：JDK 21、Gradle 8.13、AGP 8.13.2、Kotlin 2.2.21、Compose BOM 2025.10.00、SDK 36、Build Tools 35.0.0。

```powershell
# 安装项目工具链（首次下载，显式接受 SDK 许可证）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/android-toolchain.ps1 -Install -AcceptLicenses

# 编译 APK，单 worker，避免与模拟器争用内存
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/android-build.ps1

# 编译并运行 JVM 协议测试（PowerShell 中传数组）
& ./scripts/android-build.ps1 -Tasks @('assembleDebug', 'testDebugUnitTest')

# 电脑端独立公网组件与配套程序
npm run setup:remote
npm run build
```

APK 来源为 `android/app/build/outputs/apk/debug/app-debug.apk`。首版提供已签名的调试安装包供本地安装验证，没有上传应用商店，也没有替用户创建发布签名账户。正式长期发布需要独立的版本、签名与稳定公网连接安排。

## 验证口径

Android 页面截图来自实际 Android Emulator，不以浏览器预览代替。区分 JVM 协议测试、真实安卓网络/Keystore/界面测试、真实公网隧道测试与真实 Agent 任务质量。模拟器通过公网 HTTPS 域名连接电脑，可验证异网传输路径；不是手机运营商网络或真实手机硬件实测。模拟器以配对链接完成配对，没有把物理摄像头扫码记作已验收。
