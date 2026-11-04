# Android remote protocol v1

This is the shared implementation contract for the Android app and the desktop remote gateway. The private native Hook server is never exposed through the tunnel. A separate loopback HTTP gateway is published by an outbound Cloudflare Quick Tunnel. Quick Tunnels are temporary development connections, with no uptime guarantee or stable hostname; the app supports replacing a host address without silently accepting a different host identity.

## Pairing payload

The desktop creates a short-lived, single-use QR payload:

```json
{
  "version": 1,
  "endpoint": "https://example.trycloudflare.com",
  "hostId": "UUID",
  "pairingId": "UUID",
  "secret": "32-BYTE-BASE64URL",
  "expiresAt": "ISO8601"
}
```

QR content is `coloop://pair?data=BASE64URL_UTF8_JSON`. The same content may be pasted manually. The secret is conveyed only by this local QR/copy action, never in HTTP URLs, logs, command arguments, normal snapshots or history. Use unpadded URL-safe Base64 throughout.

`GET /v1/remote/hello` returns `{version:1,hostId,epoch,serverTime}` (`serverTime` is Unix milliseconds). Host ID persists; epoch is a new UUID every gateway start. No authentication material or session content appears in hello.

## Encrypted frames

AES-256-GCM with random 12-byte nonce, 128-bit tag appended to ciphertext. AAD is UTF-8:

`coloop.remote.v1|DIRECTION|hostId|epoch|actorId|requestId|sequence`

`DIRECTION` is `request` or `response`. `actorId` is pairingId for pairing, deviceId for RPC. `requestId` is UUID; `sequence` is positive integer <= 9007199254740991. Response uses the request's identity/sequence and a fresh nonce.

Outer JSON:

```json
{
  "version": 1,
  "hostId": "UUID",
  "epoch": "UUID",
  "actorId": "UUID",
  "requestId": "UUID",
  "sequence": 1,
  "nonce": "BASE64URL",
  "data": "BASE64URL_CIPHERTEXT_AND_TAG"
}
```

Every request validates exact fields, size, source epoch, nonce/tag and payload schema before action. Reject Origin/Sec-Fetch browser requests. No redirects. Request body <= 65536 bytes. Ciphertext responses are no-store. Failures before authentication are generic, with no decrypted details. Authenticated failures are encrypted `{ok:false,error:{code:"FIXED_CODE",message:"safe user message"}}`.

## Pair

`POST /v1/remote/pair` uses the pairing secret as key and encrypted payload `{deviceName:"Phone model"}`. Successful response:

```json
{
  "ok": true,
  "value": { "deviceId": "UUID", "secret": "32-BYTE-BASE64URL", "hostName": "Computer name" }
}
```

The pairing is consumed once and expires in 5 minutes. Identical request retry may return the exact cached encrypted response within that original expiry, never issue another device. Other reuses fail. Max 8 paired devices. Desktop stores device secret using its existing DPAPI secret codec; Android uses Android Keystore-backed AES-GCM storage and excludes backups. Device can be revoked immediately at the desktop.

## RPC

`POST /v1/remote/rpc` uses that device's secret. Encrypted payload:

```json
{ "operation": "snapshot", "payload": {}, "expiresAt": 1793340000000 }
```

Operations:

- `violoop_message` (Android 0.3.0): `{commandId:UUID,text:"...",authorizeInput:true,replyTo?:UUID,windowTitle?:"...",expectedText?:"..."}` -> Violoop task receipt. Text <= 2000 characters. This is separate from native session `command`; no session handle is needed. Admission persists a device-bound UUID/content digest before asynchronous RK interpretation, and duplicate UUID/content returns the existing receipt. Replies can reference this device's task awaiting input. Accepted does not mean completed. No automatic resubmission on timeout or restart.
- Snapshots optionally add `violoop:{available,unavailableReason?,active,tasks:[{id,text,state,message,createdAt,updatedAt,desktopTaskId?,windowTitle?,phase?,planningSource?,steps?}]}` (at most 20). Task states: received, understanding, awaiting_input, running, completed, cancelled, failed, unconfirmed, interrupted. `planningSource` is local/cloud after an actual planning result. No key, native observation or hidden entity map is included. Old clients ignore this addition; new clients show an upgrade message only after an online snapshot without Violoop.
- `snapshot`: `{}` -> `{hostName,sessionControl:SessionControlSnapshot,progress:[{sessionHandle,text,at}]}`. Progress is bounded, already sanitized source observations; never raw native IDs, credentials or settings.
- `command`: `{commandId:UUID,sessionHandle:UUID,action:"send_message",text:"..."}` -> existing CommandSnapshot. The desktop must show its actual control indicator before delivering the command to the native source.
- `stop`: `{}` -> `{stopped:true}` only after source confirmation. Otherwise encrypted STOP_UNCONFIRMED; existing control notice stays visible.
- `resume`: `{}` -> `{stopped:false}`. Explicit action only, no resending old commands.
- `unpair`: `{}` -> `{revoked:true}` and revokes this device.

Normal success is `{ok:true,value:...}`. Requests from each Android client are serialized. Sequence increases strictly per device within a gateway epoch. The desktop retains a small bounded cache for identical frame retries; an old sequence outside that cache is rejected, not executed. Restart changes epoch, invalidating recorded frames. Android fetches hello on connection/reconnection, verifies the persisted hostId, and never automatically repeats a command after an ambiguous network failure. It keeps the command UUID to reconcile from a later snapshot. Foreground snapshot refresh every 2 seconds; no promise of background push in this version.

Android computes its clock offset from `hello.serverTime` and sets encrypted RPC `expiresAt` to estimated server time + 60 seconds. The host requires expiry to be current and at most 120 seconds ahead. Expiry is authenticated inside the ciphertext, preventing captured write requests from being delivered hours later within the same server epoch.

## Android build baseline

Native Kotlin + Jetpack Compose Material 3. Pinned baseline: AGP 8.13.2, Gradle 8.13, Kotlin/Compose compiler plugin 2.2.21, Compose BOM 2025.10.00, compile/target SDK 36, build tools 35.0.0, min SDK 26. Chinese phone UI, existing Coloop graphite/white brand, native dark theme and 48dp touch targets. QR scan + paste fallback; no hosted WebView shell.

## 0.4.0 聊天连接状态兼容

快照仍使用 `violoop` 任务投影，以兼容既有设备。可选 `connection` 含 `rk`、`message`、`autoConnect`，以及可选 `phase`（ready/connecting/starting_model/waiting/needs_setup/paused/disabled）。手机用 phase 区分 SSH 连接与模型启动。旧电脑没有任务投影时显示更新提示，不会静默禁用发送。

已配对、已认证的 `reconnect` RPC 使用严格空 payload，只请求恢复本机保存的连接，不接受密码或执行参数，也不恢复停止状态、重放任务。
