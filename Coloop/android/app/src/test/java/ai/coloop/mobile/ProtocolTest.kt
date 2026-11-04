package ai.coloop.mobile

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.time.Instant

class ProtocolTest {
    private val identity = FrameIdentity("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333", "44444444-4444-4444-8444-444444444444", 7)
    @Test fun matchesIndependentNodeAesGcmVector() {
        val json = JSONObject("""{"operation":"snapshot","payload":{},"expiresAt":1793330000000}""")
        // org.json on Android preserves insertion order; construct the byte
        // vector directly to make this test independent of JVM map ordering.
        val cipher = javax.crypto.Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(javax.crypto.Cipher.ENCRYPT_MODE, javax.crypto.spec.SecretKeySpec(ByteArray(32), "AES"), javax.crypto.spec.GCMParameterSpec(128, ByteArray(12)))
        cipher.updateAAD(WireCrypto.aad("request", identity))
        val encoded = WireCrypto.encode(cipher.doFinal("""{"operation":"snapshot","payload":{},"expiresAt":1793330000000}""".toByteArray()))
        assertEquals("tYUvTSgSChpuIavxgNHudhMQcKJY0ghY89KU9xlpVOr_cMpVYWiEAzGBK0E0TULVfXD82LKITABRTC3TmzxHnxqdgidLs9JE_QLeeNEQyg", encoded)
        val frame = identity.json().put("nonce", WireCrypto.encode(ByteArray(12))).put("data", encoded)
        assertEquals("snapshot", WireCrypto.decrypt(ByteArray(32), identity, frame, "request").getString("operation"))
        assertEquals(1793330000000L, json.getLong("expiresAt"))
    }
    @Test fun bindsDirectionIdentitySequenceAndTag() {
        val frame = WireCrypto.encrypt(ByteArray(32), identity, JSONObject().put("ok", true), "response", ByteArray(12))
        assertTrue(WireCrypto.decrypt(ByteArray(32), identity, frame).getBoolean("ok"))
        assertFails { WireCrypto.decrypt(ByteArray(32), identity, frame, "request") }
        assertFails { WireCrypto.decrypt(ByteArray(32), identity.copy(sequence = 8), frame) }
        val changed = JSONObject(frame.toString()).put("actorId", identity.requestId)
        assertFails { WireCrypto.decrypt(ByteArray(32), identity, changed) }
        val data = WireCrypto.decode(frame.getString("data")); data[0] = (data[0].toInt() xor 1).toByte()
        assertFails { WireCrypto.decrypt(ByteArray(32), identity, JSONObject(frame.toString()).put("data", WireCrypto.encode(data))) }
    }
    @Test fun rejectsInsecureOrCredentialBearingEndpointsAndRedirectShapes() {
        assertEquals("https://computer.example", UrlPolicy.endpoint("https://computer.example/"))
        for (url in listOf("http://computer.example", "https://user:password@computer.example", "https://computer.example/path", "https://computer.example?token=x", "https://computer.example/#data", "file:///tmp/test", "https://computer.example:0")) assertFails { UrlPolicy.endpoint(url) }
        assertEquals("http://10.0.2.2:8080", UrlPolicy.endpoint("http://10.0.2.2:8080", true))
        assertFails { UrlPolicy.endpoint("http://10.0.2.2:8080") }
        assertFails { UrlPolicy.endpoint("http://192.168.1.2:8080", true) }
    }
    @Test fun pairingIsExactAndDoesNotExposeSecretsInToString() {
        val payload = JSONObject().put("version", 1).put("endpoint", "https://computer.example").put("hostId", identity.hostId).put("pairingId", identity.actorId)
            .put("secret", WireCrypto.encode(ByteArray(32))).put("expiresAt", Instant.ofEpochMilli(1793330000000L).toString())
        val link = "coloop://pair?data=" + WireCrypto.encode(payload.toString().toByteArray())
        val pairing = Pairing.parse(link)
        assertEquals(identity.hostId, pairing.hostId)
        assertFalse(pairing.toString().contains(pairing.secret))
        assertFails { Pairing.parse(link + "&other=1") }
        payload.put("extra", true)
        assertFails { Pairing.parse("coloop://pair?data=" + WireCrypto.encode(payload.toString().toByteArray())) }
    }
    @Test fun acceptsOnlyFixedOwnedServerChannelPaths() {
        val address = "https://8.215.122.37/h/11111111-1111-4111-8111-111111111111"
        assertEquals(address, UrlPolicy.endpoint(address))
        assertFails { UrlPolicy.endpoint(address + "/anything") }
        assertFails { UrlPolicy.endpoint(address + "?token=secret") }
        assertFails { UrlPolicy.endpoint("https://example.com/h/not-a-channel") }
    }
    @Test fun serverAccessKeyTravelsOnlyWithPrivatePairingAndEncryptedHostStorage() {
        val accessKey = "fixture-server-key"
        val payload = JSONObject().put("version", 1).put("endpoint", "https://server.example/h/${identity.hostId}")
            .put("hostId", identity.hostId).put("pairingId", identity.actorId).put("secret", WireCrypto.encode(ByteArray(32)))
            .put("expiresAt", Instant.ofEpochMilli(1793330000000L).toString()).put("accessKey", accessKey)
        val pairing = Pairing.parse("coloop://pair?data=" + WireCrypto.encode(payload.toString().toByteArray()))
        assertEquals(accessKey, pairing.accessKey)
        assertFalse(pairing.toString().contains(accessKey))
        val host = HostConnection(identity.hostId, pairing.endpoint, "Test host", identity.actorId,
            pairing.secret, accessKey = accessKey)
        assertEquals(accessKey, HostConnection.from(host.json()).accessKey)
        assertFalse(host.toString().contains(accessKey))
        payload.put("accessKey", "key\r\nInjected: value")
        assertFails { Pairing.parse("coloop://pair?data=" + WireCrypto.encode(payload.toString().toByteArray())) }
    }
    @Test fun fixedErrorsAndUnknownReceiptsDoNotClaimCompletion() {
        assertEquals("结果尚未确认", receiptLabel("unknown"))
        assertTrue(safeError("STOP_UNCONFIRMED").contains("尚未确认"))
        assertTrue(safeError("SECRET_FROM_SERVER").contains("不会自动重复"))
    }
    @Test fun acceptsGatewayBoundedSnapshotsAboveRequestSizeLimit() {
        val text = "x".repeat(131072)
        val frame = WireCrypto.encrypt(ByteArray(32), identity, JSONObject().put("text", text), "response", ByteArray(12))
        assertEquals(text, WireCrypto.decrypt(ByteArray(32), identity, frame).getString("text"))
    }
    private fun assertFails(block: () -> Unit) {
        try { block(); fail("Expected protocol rejection") } catch (error: Exception) { /* Expected validation/authentication failure. */ }
    }
}
