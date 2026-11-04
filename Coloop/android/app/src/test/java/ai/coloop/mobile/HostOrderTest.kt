package ai.coloop.mobile

import org.junit.Assert.*
import org.junit.Test

class HostOrderTest {
    private val first = HostConnection("11111111-1111-4111-8111-111111111111", "https://first.example", "First", "33333333-3333-4333-8333-333333333333", WireCrypto.encode(ByteArray(32)))
    private val preferred = HostConnection("22222222-2222-4222-8222-222222222222", "https://preferred.example", "Preferred", "44444444-4444-4444-8444-444444444444", WireCrypto.encode(ByteArray(32) { 1 }))
    @Test fun pollingAnyComputerKeepsTheLastSelectedComputerFirst() {
        var hosts = listOf(preferred, first)
        repeat(8) { round ->
            hosts = replaceHostConnection(hosts, hosts[0].copy(sequence = round.toLong() + 1))
            assertEquals(preferred.hostId, hosts.first().hostId)
            hosts = replaceHostConnection(hosts, hosts[1].copy(sequence = round.toLong() + 20))
            assertEquals(preferred.hostId, hosts.first().hostId)
            assertEquals(preferred.secret, hosts.first().secret)
            assertEquals(first.deviceId, hosts.last().deviceId)
        }
    }
    @Test fun receiptUpdatesPreserveOtherComputerAndDoNotDuplicateHosts() {
        val updated = preferred.copy(sequence = 42, pendingCommandId = "55555555-5555-4555-8555-555555555555")
        val hosts = replaceHostConnection(listOf(preferred, first), updated)
        assertEquals(listOf(updated, first), hosts)
        val cleared = replaceHostConnection(hosts, updated.copy(pendingCommandId = null))
        assertEquals(2, cleared.size)
        assertNull(cleared.first().pendingCommandId)
        assertEquals(42L, cleared.first().sequence)
        assertEquals(first, cleared.last())
    }
}
