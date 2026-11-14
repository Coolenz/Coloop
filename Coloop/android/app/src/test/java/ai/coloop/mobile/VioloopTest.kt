package ai.coloop.mobile

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class ColoopTest {
    private fun ready() = RemoteSnapshot("Test PC", false, false, 0, emptyList(), emptyList(), emptyList(),
        ColoopSnapshot(true, "", false, emptyList()), ConnectionInfo("ready", "RK 已连接", true))
    @Test fun explainsEveryConnectionBlockInsteadOfSilentlyDisablingTheSender() {
        val state = MobileState(hostId = "11111111-1111-4111-8111-111111111111", link = LinkStatus.ONLINE, snapshot = ready())
        assertNull(messageBlocker(state))
        assertTrue(messageBlocker(state.copy(link = LinkStatus.OFFLINE))!!.contains("自动重连"))
        assertTrue(messageBlocker(state.copy(snapshot = ready().copy(coloop = null)))!!.contains("版本较旧"))
        assertTrue(messageBlocker(state.copy(snapshot = ready().copy(stopped = true)))!!.contains("恢复"))
        assertEquals("已暂停接收任务", connectionTitle(state.copy(snapshot = ready().copy(stopped = true))))
        assertEquals("电脑已离线", connectionTitle(state.copy(link = LinkStatus.OFFLINE, snapshot = ready().copy(stopped = true))))
        assertEquals("RK 需要首次连接", connectionTitle(state.copy(snapshot = ready().copy(connection = ConnectionInfo("needs_setup", "请连接一次", true)))))
    }
    private fun base() = JSONObject("""{"hostName":"Test PC","sessionControl":{"stopped":false,"controlActive":false,"unconfirmedCount":0,"sessions":[],"commands":[]},"progress":[]}""")
    @Test fun projectsSharedApprovalAndClearsItFromTheNextSnapshot() {
        val request = JSONObject("""{"taskId":"task-1","questionId":"11111111-1111-4111-8111-111111111111","title":"整理资料","question":"是否允许操作？","toolName":"coloop_workspace","callId":"call-1"}""")
        val snapshot = RemoteSnapshot.parse(base().put("approval", request))
        assertEquals("coloop_workspace", snapshot.approval!!.toolName)
        assertEquals("task-1", snapshot.approval.taskId)
        assertNull(RemoteSnapshot.parse(base()).approval)
        assertTrue(safeError("APPROVAL_STALE").contains("已处理"))
    }
    @Test fun olderHostsRemainReadableWithoutColoop() {
        assertNull(RemoteSnapshot.parse(base()).coloop)
    }
    @Test fun parsesTaskReceiptSeparatelyFromVerifiedCompletion() {
        val wire = JSONObject("""{"available":true,"active":true,"tasks":[{"id":"11111111-1111-4111-8111-111111111111","text":"Fill code","state":"understanding","message":"RK is reading","updatedAt":"2026-10-31T00:00:00Z"}]}""")
        val snapshot = RemoteSnapshot.parse(base().put("violoop", wire))
        assertTrue(snapshot.coloop!!.active)
        assertEquals("RK 正在理解任务", coloopStateLabel(snapshot.coloop.tasks[0].state))
        assertNotEquals(coloopStateLabel("completed"), coloopStateLabel("received"))
    }
    @Test fun interruptionAndUnconfirmedStopNeverClaimCompletion() {
        assertEquals("已中断，需核查", coloopStateLabel("interrupted"))
        assertEquals("状态尚未确认", coloopStateLabel("unconfirmed"))
        assertEquals("等待 RK 确认停止", coloopPhaseLabel("stopping"))
        assertTrue(safeError("VIOLOOP_BUSY").contains("等待"))
    }
    @Test fun longDraftIsExplainedBeforeAnyConnectionOrAdmissionAttempt() {
        assertNull(draftError("a".repeat(2000)))
        val full = "a".repeat(2001)
        assertTrue(draftError(full)!!.contains("全文已保留"))
        assertEquals(draftError(full), messageBlocker(MobileState(coloopDraft = full)))
    }
    @Test fun staleRkConnectingSnapshotNeverAnimatesOfflineOrPaused() {
        val state = MobileState(link = LinkStatus.ONLINE, snapshot = ready().copy(connection = ConnectionInfo("connecting", "", true)))
        assertTrue(connectionIsConnecting(state))
        assertFalse(connectionIsConnecting(state.copy(link = LinkStatus.OFFLINE)))
        assertFalse(connectionIsConnecting(state.copy(snapshot = state.snapshot!!.copy(stopped = true))))
        assertTrue(connectionIsConnecting(MobileState(link = LinkStatus.CONNECTING)))
    }
    @Test fun recoveryActionsFollowCurrentBlockerInsteadOfReplayingTasks() {
        assertEquals("连接电脑", recoveryLabel(MobileState()))
        assertEquals("重试连接", recoveryLabel(MobileState(hostId = "test", link = LinkStatus.OFFLINE)))
        assertNull(recoveryLabel(MobileState(coloopDraft = "a".repeat(2001))))
        assertEquals("恢复接收", recoveryLabel(MobileState(hostId = "test", link = LinkStatus.ONLINE, snapshot = ready().copy(stopped = true))))
    }
    @Test fun pendingReceiptCannotBeClearedWhileColoopIsActive() {
        val id = "11111111-1111-4111-8111-111111111111"
        val state = MobileState(hostId = id, computers = listOf(Computer(id, "https://test.invalid", "PC", "pending")), pendingCheckedId = "pending", link = LinkStatus.ONLINE, snapshot = ready())
        assertTrue(canResolvePending(state))
        assertFalse(canResolvePending(state.copy(pendingCheckedId = null)))
        assertFalse(canResolvePending(state.copy(pendingCheckedId = "another-request")))
        assertFalse(canResolvePending(state.copy(snapshot = ready().copy(coloop = ready().coloop!!.copy(active = true)))))
        assertFalse(canResolvePending(state.copy(link = LinkStatus.OFFLINE)))
    }
    @Test fun supplementLengthIncludesItsOriginalTask() {
        val id = "11111111-1111-4111-8111-111111111111"
        val task = ColoopTask(id, "a".repeat(1990), "awaiting_input", "More", "", "", "", 0)
        val state = MobileState(hostId = id, link = LinkStatus.ONLINE, snapshot = ready().copy(coloop = ColoopSnapshot(true,"",false,listOf(task))), coloopReplyTo = id, coloopDraft = "b".repeat(20))
        assertTrue(messageBlocker(state)!!.contains("合计"))
        assertFalse(taskCanReuse(task))
        assertTrue(taskCanReuse(task.copy(state = "failed")))
    }
    @Test fun unfinishedHistoryIncludesEveryNonterminalOrUnsuccessfulOutcome() {
        val task = ColoopTask("id", "goal", "awaiting_input", "", "", "", "", 0)
        for (state in listOf("received", "understanding", "awaiting_input", "running", "failed", "interrupted", "unconfirmed", "cancelled")) assertTrue(taskIsUnfinished(task.copy(state = state)))
        for (state in listOf("completed", "answered")) assertFalse(taskIsUnfinished(task.copy(state = state)))
    }
}
