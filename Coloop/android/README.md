# Coloop Android

原生 Kotlin / Jetpack Compose Material 3 客户端，包名 `ai.coloop.mobile`。入口为 `MainActivity`，没有 WebView。通过电脑临时 HTTPS 连接与配对码访问同一台电脑；手机可以使用移动数据。临时隧道地址改变后，在连接设置中更新地址，仍校验原电脑身份。

构建基线：JDK 21、Gradle 8.13、AGP 8.13.2、Kotlin 2.2.21、Compose BOM 2025.10.00、Android SDK 36 / build-tools 35.0.0，最低 Android 8.0（API 26）。

```powershell
# 在已配置 JDK 与 Android SDK 的终端
gradle --no-daemon :app:testDebugUnitTest :app:assembleDebug
```

产物：`app/build/outputs/apk/debug/app-debug.apk`。这是调试签名 APK，不是 Play Store 发行版本。

电脑入口为「Agent 协调 → 安卓手机连接 → 开启手机连接 / 配对安卓手机」。配对资料与发送序号、待核对命令 UUID 经过 Android Keystore AES-GCM 加密后持久化；备份与设备迁移关闭。网络仅接受 HTTPS，不跟随重定向。Debug 额外允许 `http://10.0.2.2` 与 `http://127.0.0.1`，用于仿真验收；其他公网或局域网明文地址仍拒绝。

协议实现见 `Protocol.kt` 与 `RemoteRepository.kt`，对应 `../docs/mobile-protocol.md`。RPC 串行、单调序号、60 秒有效期；epoch 与服务器时钟在 hello 中核对。未知发送结果保存 UUID 并从 snapshot 核对，不自动重发。前台每 2 秒刷新，后台停止轮询，无后台推送承诺。停止确认失败时保留真实状态；恢复必须手动操作。

扫码只在用户启动扫描时申请相机权限；也可粘贴完整 `coloop://pair` 地址。解除配对要求电脑在线；离线时可明确只移除本机资料，并在电脑撤销旧授权。

源码入口与新 Intent 只消费一次配对链接；主题、字号及其他配置重建不会重新显示已消费链接。第三方归属及 Apache 2.0 许可随 APK 放在 assets 中，可从电脑列表右上角「关于与开源许可」查看。
