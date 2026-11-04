package ai.coloop.mobile

import android.os.Build
import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.util.UUID

class RemoteRepository(private val store: SecureStore, private val http: RemoteHttp = RemoteHttp()) {
    companion object {
        @Volatile private var shared: RemoteRepository? = null
        fun forApplication(context: Context): RemoteRepository = shared ?: synchronized(this) {
            shared ?: RemoteRepository(SecureStore(context.applicationContext)).also { shared = it }
        }
    }
    private val mutex = Mutex()
    private val runtime = mutableMapOf<String, Pair<Hello, Long>>()
    suspend fun hosts(): List<HostConnection> = mutex.withLock { withContext(Dispatchers.IO) { store.load() } }
    suspend fun prefer(hostId: String) = mutex.withLock { withContext(Dispatchers.IO) {
        val hosts = store.load()
        store.save(hosts.filter { it.hostId == hostId } + hosts.filterNot { it.hostId == hostId })
    } }
    private fun replace(host: HostConnection) {
        store.save(replaceHostConnection(store.load(), host))
    }
    suspend fun pair(raw: String): HostConnection = mutex.withLock { withContext(Dispatchers.IO) {
        val pairing = Pairing.parse(raw, BuildConfig.DEBUG)
        val hello = http.hello(pairing.endpoint, pairing.accessKey)
        if (hello.hostId != pairing.hostId) throw RemoteFailure("HOST_MISMATCH", safeError("HOST_MISMATCH"))
        if (pairing.expiresAt <= hello.serverTime) throw RemoteFailure("PAIRING_EXPIRED", safeError("PAIRING_EXPIRED"))
        require(store.load().size < 8 || store.load().any { it.hostId == pairing.hostId }) { "最多保存 8 台电脑，请先移除不用的配对" }
        val identity = FrameIdentity(hello.hostId, hello.epoch, pairing.pairingId, UUID.randomUUID().toString(), 1)
        val frame = WireCrypto.encrypt(WireCrypto.key(pairing.secret), identity, JSONObject().put("deviceName", Build.MODEL.take(64).ifBlank { "Android 手机" }))
        val answer = http.request(pairing.endpoint, "/v1/remote/pair", frame, accessKey = pairing.accessKey)
        val value = responseValue(WireCrypto.decrypt(WireCrypto.key(pairing.secret), identity, answer))
        val host = HostConnection(pairing.hostId, pairing.endpoint, value.getString("hostName").take(160), uuid(value.getString("deviceId")), value.getString("secret").also { WireCrypto.key(it) }, hello.epoch, accessKey = pairing.accessKey)
        replace(host); store.save(listOf(host) + store.load().filterNot { it.hostId == host.hostId }); runtime[host.hostId] = hello to System.currentTimeMillis()
        host
    } }
    suspend fun updateEndpoint(hostId: String, raw: String) = mutex.withLock { withContext(Dispatchers.IO) {
        val current = store.load().first { it.hostId == hostId }
        val replacement = if (raw.trim().startsWith("coloop://")) Pairing.parse(raw, BuildConfig.DEBUG) else null
        val accessKey = replacement?.accessKey ?: current.accessKey
        val endpoint = if (replacement != null) replacement.also {
            if (it.hostId != hostId) throw RemoteFailure("HOST_MISMATCH", safeError("HOST_MISMATCH"))
        }.endpoint else UrlPolicy.endpoint(raw, BuildConfig.DEBUG)
        val hello = http.hello(endpoint, accessKey)
        if (hello.hostId != hostId) throw RemoteFailure("HOST_MISMATCH", safeError("HOST_MISMATCH"))
        // A public hello cannot authenticate a replacement address. Reserve a
        // sequence while retaining both old address and epoch; a forged hello
        // must not roll back the old server's sequence on the next connection.
        val reserved = current.copy(sequence = current.sequence + 1)
        val identity = FrameIdentity(hostId, hello.epoch, current.deviceId, UUID.randomUUID().toString(), reserved.sequence)
        replace(reserved)
        val proof = JSONObject().put("operation", "snapshot").put("payload", JSONObject()).put("expiresAt", hello.serverTime + 60000)
        val encrypted = WireCrypto.encrypt(WireCrypto.key(current.secret), identity, proof)
        val answer = http.request(endpoint, "/v1/remote/rpc", encrypted, accessKey = accessKey)
        val verified = responseValue(WireCrypto.decrypt(WireCrypto.key(current.secret), identity, answer))
        require(verified.has("sessionControl") && verified.has("progress")) { "电脑响应格式不匹配" }
        replace(reserved.copy(endpoint = endpoint, epoch = hello.epoch, hostName = verified.getString("hostName").take(160), accessKey = accessKey))
        runtime[hostId] = hello to System.currentTimeMillis()
    } }
    suspend fun markPending(hostId: String, commandId: String?) = mutex.withLock { withContext(Dispatchers.IO) {
        val host = store.load().first { it.hostId == hostId }; replace(host.copy(pendingCommandId = commandId))
    } }
    suspend fun forget(hostId: String) = mutex.withLock { withContext(Dispatchers.IO) {
        store.save(store.load().filterNot { it.hostId == hostId }); runtime.remove(hostId)
    } }
    suspend fun rpc(hostId: String, operation: String, payload: JSONObject = JSONObject()): JSONObject = mutex.withLock { withContext(Dispatchers.IO) {
        require(operation in setOf("snapshot", "command", "stop", "resume", "unpair", "violoop_message", "reconnect"))
        var host = store.load().first { it.hostId == hostId }
        try {
            var live = runtime[hostId]
            if (live == null || System.currentTimeMillis() - live.second > 30000) {
                val hello = http.hello(host.endpoint, host.accessKey)
                if (hello.hostId != hostId) throw RemoteFailure("HOST_MISMATCH", safeError("HOST_MISMATCH"))
                live = hello to System.currentTimeMillis(); runtime[hostId] = live
            }
            val hello = live.first
            val sequence = if (host.epoch == hello.epoch) host.sequence + 1 else 1
            val identity = FrameIdentity(host.hostId, hello.epoch, host.deviceId, UUID.randomUUID().toString(), sequence)
            // Commit the sequence before network delivery, including ambiguous
            // failures and process death. Never replay a command automatically.
            host = host.copy(epoch = hello.epoch, sequence = sequence); replace(host)
            val offset = hello.serverTime - live.second
            val plain = JSONObject().put("operation", operation).put("payload", payload).put("expiresAt", System.currentTimeMillis() + offset + 60000)
            val frame = WireCrypto.encrypt(WireCrypto.key(host.secret), identity, plain)
            responseValue(WireCrypto.decrypt(WireCrypto.key(host.secret), identity, http.request(host.endpoint, "/v1/remote/rpc", frame, if (operation == "stop") 30000 else 20000, host.accessKey)))
        } catch (error: Exception) { runtime.remove(hostId); throw error }
    } }
}

// Sequence/key updates must not change which computer is preferred on restart.
internal fun replaceHostConnection(hosts: List<HostConnection>, replacement: HostConnection): List<HostConnection> =
    if (hosts.any { it.hostId == replacement.hostId }) hosts.map { if (it.hostId == replacement.hostId) replacement else it }
    else hosts + replacement
