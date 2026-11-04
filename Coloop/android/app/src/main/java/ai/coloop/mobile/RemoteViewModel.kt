package ai.coloop.mobile

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.util.UUID

enum class Route { COMPUTERS, PAIR, COMPUTER, SESSION, CHAT }
enum class LinkStatus { DISCONNECTED, CONNECTING, ONLINE, OFFLINE }
data class Computer(val hostId: String, val endpoint: String, val name: String, val pendingCommandId: String?)
data class RemoteSession(val handle: String, val title: String, val workspace: String, val host: String, val state: String,
    val connected: Boolean, val controlActive: Boolean, val stopping: Boolean, val canSend: Boolean)
data class Receipt(val id: String, val sessionHandle: String, val action: String, val status: String, val resolved: Boolean, val at: String)
data class Progress(val sessionHandle: String, val text: String, val at: String)
data class RemoteSnapshot(val hostName: String, val stopped: Boolean, val active: Boolean, val unconfirmed: Int,
    val sessions: List<RemoteSession>, val commands: List<Receipt>, val progress: List<Progress>, val coloop: ColoopSnapshot? = null,
    val connection: ConnectionInfo? = null) {
    companion object {
        fun parse(value: JSONObject): RemoteSnapshot {
            val control = value.getJSONObject("sessionControl")
            return RemoteSnapshot(value.getString("hostName"), control.getBoolean("stopped"), control.getBoolean("controlActive"), control.getInt("unconfirmedCount"),
                control.getJSONArray("sessions").objects().map { session -> RemoteSession(session.getString("handle"), session.getString("title"), session.getString("workspace"), session.getString("host"), session.getString("state"),
                    session.getBoolean("connected"), session.getBoolean("controlActive"), session.getBoolean("stopping"), (0 until session.getJSONArray("capabilities").length()).any { session.getJSONArray("capabilities").getString(it) == "send_message" }) },
                control.getJSONArray("commands").objects().map { command -> Receipt(command.getString("commandId"), command.getString("sessionHandle"), command.getString("action"), command.getString("status"), command.optBoolean("controlResolved", false), command.getString("updatedAt")) },
                value.getJSONArray("progress").objects().map { Progress(it.getString("sessionHandle"), it.getString("text"), it.getString("at")) },
                value.optJSONObject("violoop")?.let(ColoopSnapshot::parse), value.optJSONObject("connection")?.let(ConnectionInfo::parse))
        }
    }
}
data class MobileState(val loading: Boolean = true, val computers: List<Computer> = emptyList(), val hostId: String? = null,
    val sessionHandle: String? = null, val route: Route = Route.CHAT, val pairRaw: String = "", val snapshot: RemoteSnapshot? = null,
    val link: LinkStatus = LinkStatus.DISCONNECTED, val busy: Boolean = false, val refreshing: Boolean = false, val stopRequested: Boolean = false,
    val error: String? = null, val notice: String? = null, val lastSync: Long? = null,
    val pendingCheckedId: String? = null, val taskHistory: Boolean = false, val focusTaskId: String? = null, val composeRequest: Int = 0,
    val coloopDraft: String = "", val coloopWindow: String = "", val coloopResult: String = "", val coloopReplyTo: String? = null) {
    val computer get() = computers.find { it.hostId == hostId }
    val session get() = snapshot?.sessions?.find { it.handle == sessionHandle }
    val pendingId get() = computer?.pendingCommandId
}
fun receiptLabel(status: String): String = when (status) {
    "queued" -> "等待发送"; "dispatched" -> "已交给来源，等待回执"; "accepted" -> "来源已接收"
    "confirmed" -> "来源已确认"; "failed" -> "执行失败"; "cancelled" -> "已撤销"; "expired" -> "已过期"
    else -> "结果尚未确认"
}
class RemoteViewModel(application: Application) : AndroidViewModel(application) {
    private val repository = RemoteRepository.forApplication(application)
    private val mutable = MutableStateFlow(MobileState())
    val state = mutable.asStateFlow()
    private var poll: Job? = null
    private var foreground = false
    private var submittedDraft: Pair<String, String>? = null
    private var lastRefreshError: String? = null
    init { viewModelScope.launch {
        try { reloadComputers(); mutable.update { it.copy(loading = false) } }
        catch (_: Exception) { mutable.update { it.copy(loading = false, error = "无法读取安全存储，请重新打开应用后重试；连接资料不会以明文恢复") } }
    } }
    private suspend fun reloadComputers() {
        val list = repository.hosts().map { Computer(it.hostId, it.endpoint, it.hostName, it.pendingCommandId) }
        mutable.update { it.copy(computers = list, hostId = it.hostId?.takeIf { id -> list.any { host -> host.hostId == id } } ?: list.firstOrNull()?.hostId) }
    }
    fun foreground(active: Boolean) {
        foreground = active
        poll?.cancel(); poll = null
        if (active) poll = viewModelScope.launch {
            while (foreground) { if (!state.value.busy && !state.value.stopRequested && state.value.hostId != null && state.value.route != Route.PAIR) refreshOnce(); delay(2000) }
        }
    }
    private fun explain(error: Exception, pairing: Boolean = false): String = when (error) {
        is RemoteFailure -> error.message ?: safeError(error.code)
        is java.io.IOException -> "无法连接电脑，请检查手机网络、电脑是否在线，以及远程地址是否已更新"
        else -> if (pairing) "配对内容无效或连接未完成，请在电脑刷新配对码后重试" else "连接校验或操作未完成，请刷新并检查电脑状态；不会自动重复发送要求"
    }
    private suspend fun refreshOnce() {
        val hostId = state.value.hostId ?: return
        val pending = state.value.computer?.pendingCommandId
        if (state.value.refreshing) return
        mutable.update { it.copy(refreshing = true, link = if (it.snapshot == null && it.link == LinkStatus.DISCONNECTED) LinkStatus.CONNECTING else it.link) }
        try {
            val snapshot = RemoteSnapshot.parse(repository.rpc(hostId, "snapshot"))
            val receipt = snapshot.commands.find { it.id == pending }
            val task = snapshot.coloop?.tasks?.find { it.id == pending }
            if (pending != null && (task != null || (receipt != null && (receipt.status in setOf("confirmed", "failed", "cancelled", "expired") || receipt.resolved)))) {
                repository.markPending(hostId, null); reloadComputers()
                if (task != null && state.value.hostId == hostId && submittedDraft == (hostId to state.value.coloopDraft)) mutable.update { it.copy(coloopDraft = "", coloopReplyTo = null) }
            }
            if (state.value.hostId == hostId) mutable.update { it.copy(snapshot = snapshot, link = LinkStatus.ONLINE, pendingCheckedId = pending,
                error = if (it.error == lastRefreshError) null else it.error, lastSync = System.currentTimeMillis()) }
            lastRefreshError = null
        } catch (error: Exception) {
            if (error is CancellationException) throw error
            val problem = explain(error)
            if (state.value.hostId == hostId) mutable.update { it.copy(link = LinkStatus.OFFLINE,
                error = if (it.error == null || it.error == lastRefreshError) problem else it.error) }
            lastRefreshError = problem
        } finally { mutable.update { it.copy(refreshing = false) } }
    }
    fun refresh() { viewModelScope.launch { refreshOnce() } }
    fun openPair(raw: String = "") { mutable.update { it.copy(route = Route.PAIR, pairRaw = raw, error = null) } }
    fun pairDraft(value: String) { mutable.update { it.copy(pairRaw = value.take(16384)) } }
    fun selectComputer(id: String) {
        mutable.update { it.copy(hostId = id, route = Route.CHAT, sessionHandle = null, snapshot = if (it.hostId == id) it.snapshot else null,
            coloopDraft = if (it.hostId == id) it.coloopDraft else "", coloopReplyTo = null,
            coloopWindow = if (it.hostId == id) it.coloopWindow else "", coloopResult = if (it.hostId == id) it.coloopResult else "",
            link = if (it.hostId == id) it.link else LinkStatus.CONNECTING, error = null) }
        refresh()
        viewModelScope.launch { try { repository.prefer(id) } catch (_: Exception) {} }
    }
    fun selectSession(handle: String) { mutable.update { it.copy(sessionHandle = handle, route = Route.SESSION, error = null) } }
    fun openColoop() { mutable.update { it.copy(route = Route.CHAT, error = null) } }
    fun openComputers() { mutable.update { it.copy(route = Route.COMPUTERS, error = null) } }
    fun openSessions() { mutable.update { it.copy(route = Route.COMPUTER, error = null) } }
    fun back() { mutable.update { it.copy(route = when (it.route) { Route.SESSION -> Route.COMPUTER; Route.COMPUTER, Route.PAIR -> Route.COMPUTERS; else -> Route.CHAT }, pairRaw = "", error = null) } }
    fun coloopDraft(value: String) { mutable.update { it.copy(coloopDraft = value, error = null) } }
    fun coloopWindow(value: String) { mutable.update { it.copy(coloopWindow = value.take(250)) } }
    fun coloopResult(value: String) { mutable.update { it.copy(coloopResult = value.take(128)) } }
    fun replyToTask(id: String?) { mutable.update { it.copy(coloopReplyTo = id) } }
    fun showTaskHistory(show: Boolean = true) { mutable.update { it.copy(taskHistory = show) } }
    fun locateTask(id: String) { mutable.update { it.copy(taskHistory = false, focusTaskId = id) } }
    fun taskLocated() { mutable.update { it.copy(focusTaskId = null) } }
    fun prepareTask(id: String, supplement: Boolean) {
        val task = state.value.snapshot?.coloop?.tasks?.find { it.id == id } ?: return
        if (supplement && task.state != "awaiting_input") return
        mutable.update { it.copy(coloopDraft = if (supplement) "" else task.text,
            coloopReplyTo = if (supplement) id else null, coloopWindow = "", coloopResult = "",
            composeRequest = it.composeRequest + 1, error = null) }
    }
    fun sendColoop() {
        val reason = messageBlocker(state.value)
        if (reason != null) { mutable.update { it.copy(error = reason) }; return }
        submitColoop()
    }
    fun repairConnection() {
        if (state.value.hostId == null) { openComputers(); return }
        if (state.value.link != LinkStatus.ONLINE) { refresh(); return }
        action {
            repository.rpc(state.value.hostId!!, "reconnect")
            mutable.update { it.copy(notice = "正在恢复 RK 连接，消息会保留") }
            refreshOnce()
        }
    }
    private fun submitColoop() = action {
        val current = state.value
        val hostId = current.hostId ?: return@action
        require(current.pendingId == null && current.coloopDraft.isNotBlank() && current.coloopDraft.length <= 2000)
        require(current.link == LinkStatus.ONLINE && current.snapshot?.coloop?.available == true && !current.snapshot.coloop.active && !current.snapshot.stopped)
        val commandId = UUID.randomUUID().toString()
        val payload = JSONObject().put("commandId", commandId).put("text", current.coloopDraft).put("authorizeInput", true)
        current.coloopReplyTo?.let { payload.put("replyTo", it) }
        if (current.coloopWindow.isNotBlank()) payload.put("windowTitle", current.coloopWindow.trim())
        if (current.coloopResult.isNotBlank()) payload.put("expectedText", current.coloopResult.trim())
        repository.markPending(hostId, commandId); reloadComputers()
        submittedDraft = hostId to current.coloopDraft
        try {
            repository.rpc(hostId, "violoop_message", payload)
            // A task receipt proves admission, never successful desktop execution.
            repository.markPending(hostId, null); reloadComputers()
            if (state.value.hostId == hostId) mutable.update { it.copy(coloopDraft = if (it.coloopDraft == current.coloopDraft) "" else it.coloopDraft, coloopReplyTo = null, notice = "Coloop 已接收") }
            refreshOnce()
        } catch (error: RemoteFailure) {
            if (error.code in setOf("VIOLOOP_BUSY", "VIOLOOP_CONFLICT", "VIOLOOP_REPLY_INVALID", "VIOLOOP_MESSAGE_TOO_LONG", "VIOLOOP_JOURNAL_FULL", "CONTROL_STOPPED")) {
                repository.markPending(hostId, null); reloadComputers()
            }
            throw error
        }
    }
    fun clearNotice() { mutable.update { it.copy(notice = null) } }
    private fun action(pairing: Boolean = false, block: suspend () -> Unit) {
        if (state.value.busy || state.value.stopRequested) return
        mutable.update { it.copy(busy = true, error = null) }
        viewModelScope.launch {
            try { block() }
            catch (error: Exception) { if (error is CancellationException) throw error; mutable.update { it.copy(error = explain(error, pairing)) } }
            finally { mutable.update { it.copy(busy = false) } }
        }
    }
    fun pair() = action(pairing = true) {
        val host = repository.pair(state.value.pairRaw)
        val keepDraft = state.value.hostId == null || state.value.hostId == host.hostId
        if (!keepDraft) submittedDraft = null
        reloadComputers()
        mutable.update { it.copy(hostId = host.hostId, route = Route.CHAT, pairRaw = "", snapshot = null,
            coloopDraft = if (keepDraft) it.coloopDraft else "", coloopWindow = if (keepDraft) it.coloopWindow else "", coloopResult = if (keepDraft) it.coloopResult else "", coloopReplyTo = null,
            link = LinkStatus.CONNECTING, notice = "已完成配对") }
        refreshOnce()
    }
    fun updateEndpoint(raw: String) = action(pairing = true) {
        val hostId = state.value.hostId ?: return@action
        repository.updateEndpoint(hostId, raw); reloadComputers()
        mutable.update { it.copy(link = LinkStatus.CONNECTING, notice = "已验证原电脑并更新地址") }; refreshOnce()
    }
    fun send(text: String) = action {
        val current = state.value
        val hostId = current.hostId ?: return@action
        val session = current.session ?: return@action
        require(current.pendingId == null && text.isNotBlank() && text.toByteArray().size <= 8192)
        val commandId = UUID.randomUUID().toString()
        repository.markPending(hostId, commandId); reloadComputers()
        // UUID survives a crash or uncertain transport; only a later snapshot
        // reconciles delivery. No network retry can create a second command.
        repository.rpc(hostId, "command", JSONObject().put("commandId", commandId).put("sessionHandle", session.handle).put("action", "send_message").put("text", text))
        mutable.update { it.copy(notice = "要求已提交，正在核对来源回执") }; refreshOnce()
    }
    fun stop() {
        val hostId = state.value.hostId ?: return
        if (state.value.stopRequested) return
        mutable.update { it.copy(stopRequested = true, error = null) }
        viewModelScope.launch {
            try {
                // The repository mutex keeps wire requests serialized. Stop
                // remains reachable while an earlier command awaits its reply.
                repository.rpc(hostId, "stop")
                mutable.update { it.copy(notice = "来源已确认停止控制") }; refreshOnce()
            } catch (error: Exception) {
                if (error is CancellationException) throw error
                mutable.update { it.copy(error = explain(error)) }
            } finally { mutable.update { it.copy(stopRequested = false) } }
        }
    }
    fun resume() = action {
        val hostId = state.value.hostId ?: return@action
        repository.rpc(hostId, "resume")
        mutable.update { it.copy(notice = "已恢复，可提交新的要求") }; refreshOnce()
    }
    fun acknowledgeUnknown() = action {
        val current = state.value
        val hostId = current.hostId ?: return@action
        val pending = current.pendingId ?: return@action
        // A prior idle snapshot cannot establish what happened after submission.
        // Invalidate it and obtain a fresh encrypted snapshot on every confirmation.
        mutable.update { it.copy(pendingCheckedId = null) }
        val fresh = RemoteSnapshot.parse(repository.rpc(hostId, "snapshot"))
        if (state.value.hostId != hostId || state.value.pendingId != pending) return@action
        mutable.update { it.copy(snapshot = fresh, link = LinkStatus.ONLINE, lastSync = System.currentTimeMillis(), pendingCheckedId = pending) }
        val task = fresh.coloop?.tasks?.find { it.id == pending }
        val receipt = fresh.commands.find { it.id == pending }
        val knownReceipt = receipt != null && (receipt.status in setOf("confirmed", "failed", "cancelled", "expired") || receipt.resolved)
        if (task != null || knownReceipt) {
            repository.markPending(hostId, null); reloadComputers()
            mutable.update { it.copy(coloopDraft = if (task != null && submittedDraft == (hostId to it.coloopDraft)) "" else it.coloopDraft,
                focusTaskId = task?.id, notice = "已找到原任务回执，没有重复发送") }
            return@action
        }
        require(receipt == null && canResolvePending(state.value)) { "电脑仍有待确认的任务，请继续核对" }
        repository.markPending(hostId, null); reloadComputers()
        mutable.update { it.copy(notice = "已结束本机核对；旧要求不会重新发送") }
    }
    fun forget(remote: Boolean) = action {
        val hostId = state.value.hostId ?: return@action
        if (remote) repository.rpc(hostId, "unpair")
        repository.forget(hostId); reloadComputers()
        mutable.update { it.copy(route = Route.CHAT, snapshot = null, link = LinkStatus.DISCONNECTED, notice = if (remote) "已解除这台手机的配对" else "已从本机移除，请到电脑检查并撤销旧授权") }
    }
}
