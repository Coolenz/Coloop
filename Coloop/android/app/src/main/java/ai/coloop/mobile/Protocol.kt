package ai.coloop.mobile

import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URI
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.security.SecureRandom
import java.time.Instant
import java.util.Base64
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

class RemoteFailure(val code: String, message: String) : Exception(message)
fun uuid(value: String): String {
    require(Regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$").matches(value)) { "标识无效" }
    return UUID.fromString(value).toString()
}
fun exact(json: JSONObject, required: Set<String>, optional: Set<String> = emptySet()) {
    val keys = json.keys().asSequence().toSet()
    require(keys.containsAll(required) && keys.all { it in required || it in optional }) { "响应格式不匹配" }
}
object UrlPolicy {
    fun endpoint(raw: String, debug: Boolean = false): String {
        require(raw.length in 1..2048) { "电脑地址无效" }
        val uri = URI(raw.trim())
        require(uri.host != null && uri.userInfo == null && uri.rawQuery == null && uri.rawFragment == null &&
            (uri.rawPath.isNullOrEmpty() || uri.rawPath == "/" ||
                Regex("^/h/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$").matches(uri.rawPath)) &&
            (uri.port == -1 || uri.port in 1..65535)) { "请使用完整的电脑 HTTPS 地址" }
        require(uri.scheme == "https" || (debug && uri.scheme == "http" && uri.host in setOf("10.0.2.2", "127.0.0.1"))) { "连接需要 HTTPS" }
        return uri.toASCIIString().removeSuffix("/")
    }
}
object WireCrypto {
    private val random = SecureRandom()
    fun encode(bytes: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
    fun decode(text: String): ByteArray {
        require(text.isNotEmpty() && Regex("^[A-Za-z0-9_-]+$").matches(text)) { "编码无效" }
        return Base64.getUrlDecoder().decode(text)
    }
    fun key(text: String): ByteArray = decode(text).also { require(it.size == 32) { "配对密钥无效" } }
    fun utf8(bytes: ByteArray): String = Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
        .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString()
    fun aad(direction: String, identity: FrameIdentity): ByteArray =
        "coloop.remote.v1|$direction|${identity.hostId}|${identity.epoch}|${identity.actorId}|${identity.requestId}|${identity.sequence}".toByteArray(Charsets.UTF_8)
    fun encrypt(key: ByteArray, identity: FrameIdentity, payload: JSONObject, direction: String = "request", nonce: ByteArray = ByteArray(12).also(random::nextBytes)): JSONObject {
        require(key.size == 32 && nonce.size == 12)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
        cipher.updateAAD(aad(direction, identity))
        return identity.json().put("nonce", encode(nonce)).put("data", encode(cipher.doFinal(payload.toString().toByteArray(Charsets.UTF_8))))
    }
    fun decrypt(key: ByteArray, expected: FrameIdentity, frame: JSONObject, direction: String = "response"): JSONObject {
        exact(frame, setOf("version", "hostId", "epoch", "actorId", "requestId", "sequence", "nonce", "data"))
        require(frame.get("version").toString() == "1" && frame.getString("hostId") == expected.hostId && frame.getString("epoch") == expected.epoch &&
            frame.getString("actorId") == expected.actorId && frame.getString("requestId") == expected.requestId &&
            frame.get("sequence").toString() == expected.sequence.toString()) { "连接身份校验失败" }
        val nonce = decode(frame.getString("nonce")); require(nonce.size == 12)
        val data = decode(frame.getString("data")); require(data.size in 16..262160)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
        cipher.updateAAD(aad(direction, expected))
        return JSONObject(utf8(cipher.doFinal(data)))
    }
}
data class FrameIdentity(val hostId: String, val epoch: String, val actorId: String, val requestId: String, val sequence: Long) {
    init { uuid(hostId); uuid(epoch); uuid(actorId); uuid(requestId); require(sequence in 1..9007199254740991L) }
    fun json() = JSONObject().put("version", 1).put("hostId", hostId).put("epoch", epoch).put("actorId", actorId).put("requestId", requestId).put("sequence", sequence)
}
data class Pairing(val endpoint: String, val hostId: String, val pairingId: String, val secret: String, val expiresAt: Long, val accessKey: String = "") {
    override fun toString() = "Pairing(hostId=$hostId, secret=REDACTED)"
    companion object {
        fun parse(raw: String, debug: Boolean = false): Pairing {
            require(raw.length in 1..16384) { "配对地址过长" }
            val uri = URI(raw.trim())
            require(uri.scheme == "coloop" && uri.host == "pair" && uri.port == -1 && uri.userInfo == null && uri.rawFragment == null && uri.rawPath.isNullOrEmpty()) { "请粘贴完整的 coloop://pair 配对地址" }
            val query = uri.rawQuery ?: error("配对内容缺失")
            require(query.startsWith("data=") && !query.contains('&')) { "配对内容无效" }
            val data = JSONObject(WireCrypto.utf8(WireCrypto.decode(query.substring(5))))
            exact(data, setOf("version", "endpoint", "hostId", "pairingId", "secret", "expiresAt"), setOf("accessKey"))
            require(data.get("version").toString() == "1") { "请更新 Coloop 后再配对" }
            val secret = data.getString("secret"); WireCrypto.key(secret)
            val accessKey = data.optString("accessKey", "").also { require(it.isEmpty() || Regex("^[\\x21-\\x7e]{6,128}$").matches(it)) { "服务器访问口令无效" } }
            return Pairing(UrlPolicy.endpoint(data.getString("endpoint"), debug), uuid(data.getString("hostId")), uuid(data.getString("pairingId")), secret, Instant.parse(data.getString("expiresAt")).toEpochMilli(), accessKey)
        }
    }
}
data class Hello(val hostId: String, val epoch: String, val serverTime: Long)
class RemoteHttp {
    fun request(endpoint: String, path: String, body: JSONObject? = null, timeout: Int = 20000, accessKey: String = ""): JSONObject {
        require(path in setOf("/v1/remote/hello", "/v1/remote/pair", "/v1/remote/rpc"))
        val connection = URI(endpoint + path).toURL().openConnection() as HttpURLConnection
        try {
            connection.instanceFollowRedirects = false
            connection.connectTimeout = 10000; connection.readTimeout = timeout
            connection.requestMethod = if (body == null) "GET" else "POST"
            connection.setRequestProperty("Accept", "application/json")
            connection.setRequestProperty("User-Agent", "Coloop-Android/0.1")
            if (accessKey.isNotEmpty()) connection.setRequestProperty("X-Coloop-Access-Key", accessKey)
            if (body != null) {
                val bytes = body.toString().toByteArray(Charsets.UTF_8)
                require(bytes.size <= 65536)
                connection.doOutput = true; connection.setFixedLengthStreamingMode(bytes.size)
                connection.setRequestProperty("Content-Type", "application/json")
                connection.outputStream.use { it.write(bytes) }
            }
            val status = connection.responseCode
            if (status != 200) throw RemoteFailure("HTTP_$status", if (status in 300..399) "电脑地址发生跳转，请在电脑更新远程地址后重试" else "电脑未接受连接，请检查电脑端远程连接与配对状态")
            require(connection.contentType.orEmpty().startsWith("application/json", ignoreCase = true)) { "电脑返回了无法识别的响应" }
            val bytes = connection.inputStream.use { stream ->
                val result = java.io.ByteArrayOutputStream(); val buffer = ByteArray(4096)
                while (true) { val count = stream.read(buffer); if (count < 0) break; require(result.size() + count <= 409600) { "响应超出限制" }; result.write(buffer, 0, count) }
                result.toByteArray()
            }
            return JSONObject(WireCrypto.utf8(bytes))
        } finally { connection.disconnect() }
    }
    fun hello(endpoint: String, accessKey: String = ""): Hello {
        val value = request(endpoint, "/v1/remote/hello", accessKey = accessKey)
        exact(value, setOf("version", "hostId", "epoch", "serverTime"))
        require(value.get("version").toString() == "1" && value.getLong("serverTime") > 0) { "电脑协议版本不匹配" }
        return Hello(uuid(value.getString("hostId")), uuid(value.getString("epoch")), value.getLong("serverTime"))
    }
}
fun responseValue(value: JSONObject): JSONObject {
    if (!value.getBoolean("ok")) {
        val error = value.optJSONObject("error")
        val code = error?.optString("code")?.takeIf { Regex("^[A-Z][A-Z0-9_]{0,79}$").matches(it) } ?: "REMOTE_ERROR"
        throw RemoteFailure(code, safeError(code))
    }
    return value.getJSONObject("value")
}
fun safeError(code: String): String = when (code) {
    "APPROVAL_STALE" -> "审批已处理或已结束，请刷新当前任务"
    "APPROVAL_UNAVAILABLE" -> "请更新电脑端 Coloop 后审批"
    "VIOLOOP_UNAVAILABLE" -> "Coloop 暂不可用，请在电脑检查 RK 连接与服务版本，再刷新状态"
    "VIOLOOP_BUSY" -> "Coloop 正在执行任务，请先停止或等待结束"
    "VIOLOOP_CONFLICT" -> "任务编号已被使用，请刷新并核对原任务"
    "VIOLOOP_REPLY_INVALID" -> "原任务已不再等待补充，请刷新后发送新任务"
    "VIOLOOP_MESSAGE_TOO_LONG" -> "补充后的任务过长，请缩短后重新提交"
    "VIOLOOP_JOURNAL_FULL", "VIOLOOP_STORAGE_UNAVAILABLE" -> "电脑任务记录无法继续保存，请在电脑检查后重试"
    "STOP_UNCONFIRMED" -> "停止尚未确认，请检查电脑原会话；控制提示会继续保留"
    "SESSION_BUSY" -> "会话正在运行，请等它空闲后追加要求"
    "CONTROL_STOPPED" -> "控制已暂停，请先明确恢复控制"
    "SESSION_OFFLINE", "SESSION_UNAVAILABLE", "SESSION_CLOSED" -> "会话已断开或关闭，请回到会话列表刷新"
    "HOST_MISMATCH" -> "这不是原来配对的电脑，已停止连接"
    "UNAUTHORIZED", "DEVICE_REVOKED" -> "这台手机的配对已被撤销，请重新扫码"
    "PAIRING_EXPIRED", "PAIRING_UNAVAILABLE" -> "配对码已过期或使用，请在电脑上刷新后扫码"
    else -> "操作未完成，请刷新状态后检查电脑；不会自动重复发送要求"
}
fun JSONArray.objects(): List<JSONObject> = (0 until length()).map { getJSONObject(it) }
