package ai.coloop.mobile

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import org.json.JSONArray
import org.json.JSONObject
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

data class HostConnection(val hostId: String, val endpoint: String, val hostName: String, val deviceId: String, val secret: String,
    val epoch: String = "", val sequence: Long = 0, val pendingCommandId: String? = null, val accessKey: String = "") {
    override fun toString() = "HostConnection(hostId=$hostId, secret=REDACTED)"
    fun json() = JSONObject().put("hostId", hostId).put("endpoint", endpoint).put("hostName", hostName).put("deviceId", deviceId).put("secret", secret)
        .put("epoch", epoch).put("sequence", sequence).put("accessKey", accessKey).apply { pendingCommandId?.let { put("pendingCommandId", it) } }
    companion object {
        fun from(json: JSONObject) = HostConnection(uuid(json.getString("hostId")), UrlPolicy.endpoint(json.getString("endpoint"), BuildConfig.DEBUG), json.getString("hostName"),
            uuid(json.getString("deviceId")), json.getString("secret").also { WireCrypto.key(it) }, json.optString("epoch"), json.optLong("sequence", 0), json.optString("pendingCommandId").takeIf { it.isNotEmpty() }, json.optString("accessKey", ""))
    }
}
class SecureStore(context: Context) {
    private val prefs = context.getSharedPreferences("coloop.encrypted.v1", Context.MODE_PRIVATE)
    private val alias = "ai.coloop.mobile.storage.v1"
    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(alias, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setKeySize(256).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true).build())
        }.generateKey()
    }
    @Synchronized fun load(): List<HostConnection> {
        val encoded = prefs.getString("sealed", null) ?: return emptyList()
        val json = JSONObject(encoded)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, WireCrypto.decode(json.getString("nonce"))))
        cipher.updateAAD("coloop.android.storage.v1".toByteArray())
        val data = JSONObject(WireCrypto.utf8(cipher.doFinal(WireCrypto.decode(json.getString("data")))))
        require(data.getInt("version") == 1)
        return data.getJSONArray("hosts").objects().map(HostConnection::from)
    }
    @Synchronized fun save(hosts: List<HostConnection>) {
        require(hosts.size <= 8)
        val plain = JSONObject().put("version", 1).put("hosts", JSONArray(hosts.map(HostConnection::json))).toString().toByteArray()
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key()); cipher.updateAAD("coloop.android.storage.v1".toByteArray())
        val sealed = JSONObject().put("nonce", WireCrypto.encode(cipher.iv)).put("data", WireCrypto.encode(cipher.doFinal(plain)))
        check(prefs.edit().putString("sealed", sealed.toString()).commit()) { "安全存储写入失败" }
    }
}
