package ai.coloop.mobile

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

@OptIn(ExperimentalMaterial3Api::class)
@Composable fun TaskHistorySheet(state: MobileState, model: RemoteViewModel) {
    var failuresOnly by rememberSaveable(state.hostId) { mutableStateOf(false) }
    val sheetMax = LocalConfiguration.current.screenHeightDp.dp * .85f
    val tasks = state.snapshot?.coloop?.tasks.orEmpty()
    val shown = if (failuresOnly) tasks.filter(::taskIsUnfinished) else tasks
    ModalBottomSheet(onDismissRequest = { model.showTaskHistory(false) }, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
        Column(Modifier.fillMaxWidth().heightIn(max = sheetMax).padding(horizontal = 24.dp).navigationBarsPadding().padding(bottom = 24.dp)) {
            Text("最近任务", style = MaterialTheme.typography.titleLarge)
            Text(if (state.link == LinkStatus.ONLINE) "由当前电脑同步，最多显示最近 20 项。点选可定位到对话。" else "当前电脑离线，显示上次同步的记录；重新连接后更新。", style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(vertical = 12.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                FilterChip(selected = !failuresOnly, onClick = { failuresOnly = false }, label = { Text("全部") }, modifier = Modifier.heightIn(min = 48.dp))
                FilterChip(selected = failuresOnly, onClick = { failuresOnly = true }, label = { Text("未完成") }, modifier = Modifier.heightIn(min = 48.dp))
            }
            if (shown.isEmpty()) Text(if (failuresOnly) "没有未完成的任务记录" else if (state.link == LinkStatus.ONLINE) "还没有任务，回到聊天发送第一条消息。" else "连接电脑后，在这里查看最近任务。", modifier = Modifier.padding(vertical = 24.dp))
            LazyColumn(Modifier.fillMaxWidth().weight(1f, fill = false)) {
                items(shown, key = { it.id }) { task ->
                    Column(Modifier.fillMaxWidth().clickable { model.locateTask(task.id) }.padding(vertical = 16.dp)) {
                        Text(task.text, style = MaterialTheme.typography.bodyLarge, maxLines = 2, overflow = TextOverflow.Ellipsis)
                        Text("${coloopStateLabel(task.state)} · ${timeLabel(task.updatedAt)}", style = MaterialTheme.typography.labelMedium, modifier = Modifier.padding(top = 8.dp))
                    }
                    HorizontalDivider()
                }
            }
            TextButton(onClick = { model.showTaskHistory(false) }, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("回到聊天") }
        }
    }
}
