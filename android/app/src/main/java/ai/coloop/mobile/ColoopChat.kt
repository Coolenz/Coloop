package ai.coloop.mobile

import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.Image
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.first
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import android.content.res.Configuration
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable fun ColoopChat(state: MobileState, model: RemoteViewModel, modifier: Modifier) {
    val tasks = state.snapshot?.coloop?.tasks.orEmpty().reversed()
    val listState = rememberLazyListState()
    val keyboard = LocalSoftwareKeyboardController.current
    val compactKeyboard = compactChatKeyboard()
    val hostView = LocalView.current
    val navigationBottom = with(LocalDensity.current) {
        (ViewCompat.getRootWindowInsets(hostView)?.getInsetsIgnoringVisibility(WindowInsetsCompat.Type.navigationBars())?.bottom ?: 0).toDp()
    }
    val optionsSheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    var details by rememberSaveable(state.hostId) { mutableStateOf(false) }
    var optionWindow by rememberSaveable(state.hostId) { mutableStateOf("") }
    var optionResult by rememberSaveable(state.hostId) { mutableStateOf("") }
    val focus = remember { FocusRequester() }
    var replaceTask by remember(state.hostId) { mutableStateOf<Pair<ColoopTask, Boolean>?>(null) }
    var resolvePending by remember { mutableStateOf(false) }
    val composeTask: (ColoopTask, Boolean) -> Unit = { task, supplement ->
        if (state.coloopDraft.isNotBlank()) replaceTask = task to supplement else model.prepareTask(task.id, supplement)
    }
    LaunchedEffect(state.taskHistory) { if (state.taskHistory) keyboard?.hide() }
    LaunchedEffect(state.composeRequest) { if (state.composeRequest > 0) { focus.requestFocus(); keyboard?.show() } }
    val active = state.snapshot?.let { it.active || it.unconfirmed > 0 || it.coloop?.active == true } == true
    LaunchedEffect(tasks.lastOrNull()?.id) {
        if (tasks.isNotEmpty()) {
            snapshotFlow { listState.layoutInfo.totalItemsCount }.first { it == tasks.size * 2 }
            withFrameNanos { }
            listState.animateScrollToItem(tasks.size * 2 - 1)
        }
    }
    LaunchedEffect(state.focusTaskId) {
        state.focusTaskId?.let { id ->
            val index = tasks.indexOfFirst { it.id == id }
            if (index >= 0) { keyboard?.hide(); listState.animateScrollToItem(index * 2 + 1) }
            model.taskLocated()
        }
    }
    Column(modifier.fillMaxHeight().imePadding()) {
        ConnectionStrip(state, model)
        val currentTask = tasks.lastOrNull()?.takeIf { it.state in setOf("received", "understanding", "running", "awaiting_input") }
        if (currentTask != null && !compactChatLayout()) Row(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(if (currentTask.state == "awaiting_input") "需要你的补充" else "当前任务 · ${coloopStateLabel(currentTask.state)}", style = MaterialTheme.typography.labelLarge)
                Text(currentTask.text, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            TextButton(onClick = { if (currentTask.state == "awaiting_input") composeTask(currentTask, true) else model.locateTask(currentTask.id) }, modifier = Modifier.heightIn(min = 48.dp)) { Text(if (currentTask.state == "awaiting_input") "补充信息" else "查看任务") }
        }
        if (tasks.isEmpty()) Column(Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 28.dp, vertical = 24.dp),
            verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.Start) {
            Image(painterResource(R.drawable.ic_coloop), null, Modifier.size(52.dp))
            Text(if (state.hostId != null && state.link != LinkStatus.ONLINE) "连接后同步任务" else "想让电脑做什么？", style = MaterialTheme.typography.headlineMedium,
                modifier = Modifier.padding(top = 24.dp, bottom = 10.dp))
            Text("把目标告诉 Coloop。\n进度和结果都会回到这里。", style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (state.hostId == null) FilledTonalButton(onClick = { model.openPair() },
                modifier = Modifier.padding(top = 24.dp).heightIn(min = 48.dp)) {
                Icon(Icons.Default.Add, null, Modifier.size(18.dp)); Spacer(Modifier.width(8.dp)); Text("连接我的电脑")
            }
        } else BoxWithConstraints(Modifier.weight(1f)) {
            LazyColumn(Modifier.fillMaxSize(), state = listState,
                contentPadding = PaddingValues(horizontal = 20.dp, vertical = 20.dp),
                verticalArrangement = Arrangement.spacedBy(20.dp)) {
                tasks.forEach { task ->
                    item(key = "${task.id}-goal") {
                        BoxWithConstraints(Modifier.fillMaxWidth().padding(top = 8.dp)) {
                            Surface(modifier = Modifier.align(Alignment.CenterEnd).widthIn(max = minOf(560.dp, maxWidth * .88f)),
                                color = MaterialTheme.colorScheme.surfaceContainerHigh,
                                shape = RoundedCornerShape(16.dp, 16.dp, 4.dp, 16.dp)) {
                                SelectionContainer { Text(task.text, style = MaterialTheme.typography.bodyLarge,
                                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp)) }
                            }
                        }
                    }
                    item(key = "${task.id}-reply") { ColoopReply(task, state, model, active, composeTask) }
                }
            }
            val awayFromLatest by remember { derivedStateOf {
                val info = listState.layoutInfo
                info.totalItemsCount > 0 && (info.visibleItemsInfo.lastOrNull()?.index ?: 0) < info.totalItemsCount - 1
            } }
            val scope = rememberCoroutineScope()
            if (awayFromLatest && maxHeight >= 56.dp) FilledTonalButton(onClick = {
                scope.launch { listState.animateScrollToItem(tasks.size * 2 - 1) }
            }, modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = 8.dp).heightIn(min = 48.dp)) {
                Icon(Icons.Default.ArrowDownward, null, Modifier.size(18.dp)); Spacer(Modifier.width(8.dp)); Text("最新消息")
            }
        }
        state.error?.takeIf { !compactChatKeyboard() }?.let { problem ->
            val waiting = state.link == LinkStatus.ONLINE && state.snapshot?.connection?.rk == "connecting"
            val dark = isSystemInDarkTheme()
            val ground = if (waiting) { if (dark) Color(0xFF3C3013) else Color(0xFFFFF1CC) } else MaterialTheme.colorScheme.errorContainer
            val ink = if (waiting) { if (dark) Color(0xFFF2D080) else Color(0xFF715000) } else MaterialTheme.colorScheme.onErrorContainer
            Row(Modifier.fillMaxWidth().background(ground).padding(horizontal = 20.dp, vertical = 10.dp),
                horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Default.Info, null, Modifier.size(18.dp), tint = ink)
                Column(Modifier.weight(1f)) {
                    Text(problem, style = MaterialTheme.typography.bodySmall, color = ink)
                    recoveryLabel(state)?.let { label -> TextButton(onClick = {
                        when (label) {
                            "连接电脑" -> model.openPair()
                            "恢复接收" -> model.resume()
                            "查看当前任务" -> currentTask?.let { model.locateTask(it.id) }
                            "核对回执" -> model.refresh()
                            else -> model.repairConnection()
                        }
                    }, modifier = Modifier.heightIn(min = 48.dp)) { Text(label, color = ink) } }
                }
            }
        }
        Surface(color = MaterialTheme.colorScheme.surface) {
            Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                if (active && !compactChatLayout()) OutlinedButton(onClick = model::stop, enabled = state.link == LinkStatus.ONLINE && !state.stopRequested,
                    modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
                    Icon(Icons.Default.Stop, null, Modifier.size(18.dp)); Spacer(Modifier.width(8.dp)); Text(if (state.stopRequested) "等待停止确认" else "停止任务")
                }
                if (state.snapshot?.stopped == true && !active && !compactChatLayout()) TextButton(onClick = model::resume,
                    enabled = state.link == LinkStatus.ONLINE && !state.busy, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("恢复接收新任务") }
                if (state.pendingId != null && !active && !compactChatKeyboard()) TextButton(onClick = { resolvePending = true },
                    enabled = canResolvePending(state) && !state.busy, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("已检查电脑，结束上条消息核对") }
                if (state.coloopReplyTo != null && !compactChatKeyboard()) Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("补充原任务", style = MaterialTheme.typography.labelMedium)
                        Text(tasks.find { it.id == state.coloopReplyTo }?.text ?: "原任务已不在近期记录中，请先刷新核对", maxLines = 2, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodySmall)
                    }
                    IconButton(onClick = { model.replyToTask(null) }) { Icon(Icons.Default.Close, "取消补充") }
                }
                if (!compactChatLayout() && (state.coloopWindow.isNotBlank() || state.coloopResult.isNotBlank())) FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (state.coloopWindow.isNotBlank()) InputChip(selected = false, onClick = { model.coloopWindow("") },
                        modifier = Modifier.heightIn(min = 48.dp).semantics { contentDescription = "清除窗口限制" },
                        label = { Text("窗口：${state.coloopWindow}", maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.widthIn(max = 128.dp)) },
                        trailingIcon = { Icon(Icons.Default.Close, null, Modifier.size(16.dp)) })
                    if (state.coloopResult.isNotBlank()) InputChip(selected = false, onClick = { model.coloopResult("") },
                        modifier = Modifier.heightIn(min = 48.dp).semantics { contentDescription = "清除完成条件" },
                        label = { Text("已设置完成条件") },
                        trailingIcon = { Icon(Icons.Default.Close, null, Modifier.size(16.dp)) })
                }
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(state.coloopDraft, model::coloopDraft, modifier = Modifier.weight(1f).focusRequester(focus),
                        isError = draftError(state.coloopDraft) != null,
                        placeholder = { Text(if (state.coloopReplyTo == null) "给 Coloop 发消息…" else "补充任务信息…") },
                        minLines = 1, maxLines = if (compactChatKeyboard()) 1 else if (compactChatLayout()) 2 else 4, shape = RoundedCornerShape(24.dp),
                        trailingIcon = { IconButton(onClick = { optionWindow = state.coloopWindow; optionResult = state.coloopResult; details = true }) {
                            BadgedBox(badge = { val count = listOf(state.coloopWindow, state.coloopResult).count { it.isNotBlank() }; if (count > 0) Badge(containerColor = MaterialTheme.colorScheme.secondaryContainer, contentColor = MaterialTheme.colorScheme.onSecondaryContainer) { Text(count.toString()) } }) {
                                Icon(Icons.Default.Add, "任务选项")
                            }
                        } })
                    if (active && compactChatLayout()) FilledTonalIconButton(onClick = model::stop,
                        enabled = state.link == LinkStatus.ONLINE && !state.stopRequested, modifier = Modifier.size(48.dp)) {
                        Icon(Icons.Default.Stop, if (state.stopRequested) "等待停止确认" else "停止任务")
                    }
                    FilledIconButton(onClick = { if (compactKeyboard && messageBlocker(state) != null) keyboard?.hide(); model.sendColoop() },
                        enabled = state.coloopDraft.isNotBlank() && !state.busy && !state.stopRequested,
                        modifier = Modifier.padding(bottom = 4.dp).size(48.dp)) {
                        if (state.busy) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp, color = MaterialTheme.colorScheme.onPrimary)
                        else Icon(Icons.Default.ArrowUpward, "发送消息")
                    }
                }
                if (!compactChatLayout() && state.coloopDraft.length >= 1800) Text(
                    "${state.coloopDraft.length} / $MESSAGE_LIMIT" + if (draftError(state.coloopDraft) != null) " · 请缩短后发送，全文已保留" else "",
                    style = MaterialTheme.typography.labelSmall, color = if (draftError(state.coloopDraft) != null) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(horizontal = 12.dp))
                if (!compactChatLayout()) Text(if (state.pendingId != null) "正在核对上一条消息，不会重复发送" else if (active) "当前任务进行中，你可以先编辑下一条消息" else "发送即授权本次操作，可随时停止",
                    style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(horizontal = 12.dp))
            }
        }
    }
    replaceTask?.let { (task, supplement) -> AlertDialog(onDismissRequest = { replaceTask = null },
        title = { Text(if (supplement) "改为补充这条任务？" else "替换当前草稿？") }, text = { Text(if (supplement) "当前未发送的草稿和旧任务选项将被清空。补充内容关联这条原任务，仍需你手动发送。" else "输入框已有未发送的内容。替换后将填入所选任务并清除旧任务选项；不会自动发送或操作电脑。") },
        confirmButton = { TextButton(onClick = { model.prepareTask(task.id, supplement); replaceTask = null }) { Text("替换草稿") } },
        dismissButton = { TextButton(onClick = { replaceTask = null }) { Text("保留草稿") } }) }
    if (resolvePending) AlertDialog(onDismissRequest = { resolvePending = false }, title = { Text("已核对电脑上的结果？") },
        text = { Text("仅结束这条消息在手机上的待核对状态，不会重发要求。请先在电脑确认是否已执行，避免再次操作。") },
        confirmButton = { TextButton(enabled = canResolvePending(state), onClick = { model.acknowledgeUnknown(); resolvePending = false }) { Text("已核对，结束核对") } },
        dismissButton = { TextButton(onClick = { resolvePending = false }) { Text("继续核对") } })
    if (state.taskHistory) TaskHistorySheet(state, model)
    if (details) ModalBottomSheet(onDismissRequest = { details = false }, sheetState = optionsSheet) {
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).imePadding().padding(horizontal = 24.dp).padding(bottom = navigationBottom + 32.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            Text("任务选项", style = MaterialTheme.typography.titleLarge)
            Text("需要操作特定窗口时再填写。Coloop 也会在对话中询问缺少的信息。", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            OutlinedTextField(optionWindow, { optionWindow = it }, maxLines = 3, label = { Text("窗口标题（可选）") }, isError = optionWindow.length > 250,
                supportingText = { if (optionWindow.length > 250) Text("${optionWindow.length} / 250 · 请缩短窗口标题") }, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(optionResult, { optionResult = it }, maxLines = 3, label = { Text("完成后出现的文字（可选）") }, isError = optionResult.length > 128,
                supportingText = { if (optionResult.length > 128) Text("${optionResult.length} / 128 · 请缩短完成条件") }, modifier = Modifier.fillMaxWidth())
            Button(onClick = { model.coloopWindow(optionWindow); model.coloopResult(optionResult); details = false }, enabled = optionWindow.length <= 250 && optionResult.length <= 128, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("完成") }
            TextButton(onClick = { details = false }, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("取消") }
        }
    }
}

@Composable private fun ConnectionStrip(state: MobileState, model: RemoteViewModel) {
    val paused = state.link == LinkStatus.ONLINE && state.snapshot?.stopped == true
    val ready = !paused && state.link == LinkStatus.ONLINE && state.snapshot?.coloop?.let { it.available || it.active } == true
    val connecting = connectionIsConnecting(state)
    val tone = if (ready) { if (isSystemInDarkTheme()) Color(0xFF84D6B1) else Color(0xFF28775B) } else MaterialTheme.colorScheme.onSurfaceVariant
    Row(Modifier.fillMaxWidth().heightIn(min = 48.dp).clickable(onClick = model::openComputers).padding(horizontal = 20.dp, vertical = if (compactChatLayout()) 0.dp else 10.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        if (connecting) CircularProgressIndicator(Modifier.size(12.dp), strokeWidth = 1.5.dp)
        else Box(Modifier.size(7.dp).clip(CircleShape).background(tone))
        Column(Modifier.weight(1f)) {
            Text(connectionTitle(state), style = MaterialTheme.typography.labelLarge, color = tone)
            if (!compactChatLayout()) Text(state.computer?.name ?: "配对一次，之后自动连接", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        if (compactChatLayout()) IconButton(onClick = { model.showTaskHistory() }) { Icon(Icons.Default.History, "最近任务") }
        if (paused && compactChatLayout()) TextButton(onClick = model::resume, enabled = !state.busy && !state.stopRequested,
            modifier = Modifier.heightIn(min = 48.dp)) { Text("恢复") }
        else if (!ready && !paused && state.hostId != null && compactChatLayout()) IconButton(onClick = model::repairConnection,
            enabled = !state.busy && !state.stopRequested) { Icon(Icons.Default.Refresh, "重新连接") }
        else if (!ready && !paused && state.hostId != null) TextButton(onClick = model::repairConnection,
            enabled = !state.busy && !state.stopRequested, modifier = Modifier.heightIn(min = 48.dp)) { Text(if (connecting) "重试" else "重新连接") }
        else Icon(Icons.Default.ChevronRight, "设备与连接", Modifier.size(18.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
    }
    HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
}

@OptIn(ExperimentalLayoutApi::class)
@Composable private fun ColoopReply(task: ColoopTask, state: MobileState, model: RemoteViewModel, active: Boolean, composeTask: (ColoopTask, Boolean) -> Unit) {
    val success = task.state == "completed"
    val statusColor = when {
        success -> if (isSystemInDarkTheme()) Color(0xFF84D6B1) else Color(0xFF28775B)
        task.state in setOf("failed", "unconfirmed", "interrupted") -> MaterialTheme.colorScheme.error
        else -> MaterialTheme.colorScheme.onSurfaceVariant
    }
    Row(Modifier.fillMaxWidth().padding(bottom = 8.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Image(painterResource(R.drawable.ic_coloop), null, Modifier.padding(top = 2.dp).size(24.dp))
        Column(Modifier.weight(1f).animateContentSize(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text("Coloop", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    if (success) Icon(Icons.Default.CheckCircle, null, Modifier.size(16.dp), tint = statusColor)
                    Text(coloopStateLabel(task.state), style = MaterialTheme.typography.labelMedium, color = statusColor)
                }
            }
            SelectionContainer { Text(task.message, style = MaterialTheme.typography.bodyLarge,
                modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite }) }
            val phase = coloopPhaseLabel(task.phase)
            if (phase.isNotBlank() && task.state == "running") Text(phase, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            FlowRow(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                if (task.planningSource.isNotEmpty()) Text(if (task.planningSource == "cloud") "云端协作" else "RK 本地处理", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text(timeLabel(task.updatedAt), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            if (taskCanReuse(task)) TextButton(onClick = { composeTask(task, false) }, enabled = !state.busy && state.pendingId == null,
                modifier = Modifier.heightIn(min = 48.dp)) { Text("编辑为新任务") }
            if (task.state == "awaiting_input") TextButton(onClick = { composeTask(task, true) }, enabled = !state.busy && !active,
                modifier = Modifier.heightIn(min = 48.dp)) { Text("补充信息") }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable internal fun compactChatKeyboard(): Boolean =
    compactChatLayout() && WindowInsets.isImeVisible

@Composable internal fun compactChatLayout(): Boolean =
    LocalConfiguration.current.orientation == Configuration.ORIENTATION_LANDSCAPE
