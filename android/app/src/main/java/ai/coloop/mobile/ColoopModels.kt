package ai.coloop.mobile

import org.json.JSONObject

data class ColoopTask(val id: String, val text: String, val state: String, val message: String,
    val updatedAt: String, val phase: String, val planningSource: String, val steps: Int) {
    companion object {
        fun parse(value: JSONObject) = ColoopTask(uuid(value.getString("id")), value.getString("text"),
            value.getString("state"), value.getString("message").replace("Violoop", "Coloop"), value.getString("updatedAt"),
            value.optString("phase", ""), value.optString("planningSource", ""), value.optInt("steps", 0))
    }
}
data class ConnectionInfo(val rk: String, val message: String, val automatic: Boolean, val phase: String = "") {
    companion object {
        fun parse(value: JSONObject) = ConnectionInfo(value.getString("rk"), value.getString("message"), value.getBoolean("autoConnect"), value.optString("phase", ""))
    }
}
const val MESSAGE_LIMIT = 2000
fun draftError(text: String): String? = if (text.length > MESSAGE_LIMIT) "消息超过 2000 字，请缩短后再发送；全文已保留。" else null
fun connectionIsConnecting(state: MobileState): Boolean = state.link == LinkStatus.CONNECTING ||
    (state.link == LinkStatus.ONLINE && state.snapshot?.stopped != true && state.snapshot?.connection?.rk == "connecting")

fun messageBlocker(state: MobileState): String? = when {
    draftError(state.coloopDraft) != null -> draftError(state.coloopDraft)
    state.coloopReplyTo != null && state.snapshot?.coloop?.tasks?.find { it.id == state.coloopReplyTo }?.let { it.text.length + "\n补充：".length + state.coloopDraft.length > MESSAGE_LIMIT } == true -> "补充内容与原任务合计超过 2000 字，请缩短补充内容后再发送。"
    state.hostId == null -> "先连接一台电脑，就能给 Coloop 发消息。"
    state.link != LinkStatus.ONLINE -> "还没有连接到电脑，正在自动重连；消息会保留在输入框。"
    state.snapshot?.coloop == null -> "电脑端版本较旧，请打开新版 Coloop 后重新连接。"
    state.pendingId != null -> "上一条消息仍在核对，不会重复发送。"
    state.stopRequested -> "正在等待停止确认，请稍候。"
    state.snapshot.stopped -> "任务已停止，点击恢复后再发送新消息。"
    state.snapshot.coloop.active -> "Coloop 正在处理当前任务，可以先编辑下一条消息。"
    !state.snapshot.coloop.available -> (state.snapshot.connection?.message ?: state.snapshot.coloop.reason.ifBlank { "RK 还未就绪，请检查电脑端连接。" }) + "；消息会保留在输入框。"
    else -> null
}
fun connectionTitle(state: MobileState): String = when {
    state.hostId == null -> "尚未连接电脑"
    state.link == LinkStatus.CONNECTING -> "正在连接电脑"
    state.link != LinkStatus.ONLINE -> "电脑已离线"
    state.snapshot?.coloop == null -> "电脑端需要更新"
    state.snapshot.stopped -> "已暂停接收任务"
    state.snapshot.connection?.phase == "starting_model" -> "正在启动 RK 本地模型"
    state.snapshot.connection?.rk == "connecting" -> "正在自动连接 RK"
    state.snapshot.connection?.rk == "needs_setup" -> "RK 需要首次连接"
    state.snapshot.coloop.available || state.snapshot.coloop.active -> "电脑与 RK 已就绪"
    else -> "RK 暂未就绪"
}
data class ColoopSnapshot(val available: Boolean, val reason: String, val active: Boolean, val tasks: List<ColoopTask>) {
    companion object {
        fun parse(value: JSONObject) = ColoopSnapshot(value.getBoolean("available"), value.optString("unavailableReason", ""),
            value.getBoolean("active"), value.getJSONArray("tasks").objects().map(ColoopTask::parse))
    }
}
fun coloopStateLabel(state: String): String = when (state) {
    "received" -> "已接收"; "understanding" -> "RK 正在理解任务"; "awaiting_input" -> "需要补充"
    "running" -> "正在执行"; "completed" -> "结果已验证"; "answered" -> "已回复"; "cancelled" -> "已停止"
    "failed" -> "未完成"; "interrupted" -> "已中断，需核查"; else -> "状态尚未确认"
}
fun coloopPhaseLabel(phase: String): String = when (phase) {
    "preparing" -> "准备执行通道"; "observing" -> "观察电脑窗口"; "planning" -> "规划下一步"
    "validating" -> "检查动作与目标"; "executing" -> "执行键鼠动作"; "verifying" -> "核验操作结果"
    "stopping" -> "等待 RK 确认停止"; else -> ""
}

fun canResolvePending(state: MobileState): Boolean = state.pendingId != null && state.pendingCheckedId == state.pendingId && state.link == LinkStatus.ONLINE &&
    state.snapshot?.let { !it.active && it.unconfirmed == 0 && it.coloop?.active == false } == true
fun taskCanReuse(task: ColoopTask): Boolean = task.state in setOf("completed", "answered", "cancelled", "failed", "interrupted", "unconfirmed")
fun recoveryLabel(state: MobileState): String? = when {
    draftError(state.coloopDraft) != null -> null
    state.hostId == null -> "连接电脑"
    state.link != LinkStatus.ONLINE -> "重试连接"
    state.pendingId != null -> "核对回执"
    state.snapshot?.stopped == true -> "恢复接收"
    state.snapshot?.coloop?.active == true -> "查看当前任务"
    state.snapshot?.coloop?.available != true -> "恢复连接"
    else -> null
}

fun taskIsUnfinished(task: ColoopTask): Boolean = task.state !in setOf("completed", "answered")
