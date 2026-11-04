package ai.coloop.mobile

import android.Manifest
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.net.Uri
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.foundation.Image
import androidx.compose.foundation.clickable
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

class MainActivity : ComponentActivity() {
    private val model: RemoteViewModel by viewModels()
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        // Configuration/process restoration must not reopen an already used
        // pairing link. The ongoing route belongs to the retained ViewModel.
        if (savedInstanceState == null) consumePairIntent(intent)
        else clearPairIntent(intent)
        setContent { ColoopTheme { ColoopApp(model) } }
    }
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        consumePairIntent(intent)
    }
    private fun clearPairIntent(value: Intent?) {
        value?.data = null
        if (value != null) setIntent(value)
    }
    private fun consumePairIntent(value: Intent?) {
        val raw = value?.dataString
        clearPairIntent(value)
        raw?.let(model::openPair)
    }
}
@Composable fun ColoopTheme(content: @Composable () -> Unit) {
    val scheme = if (isSystemInDarkTheme()) darkColorScheme(
        primary = Color(0xFFE5E6E8), onPrimary = Color(0xFF202124), primaryContainer = Color(0xFF35373B), onPrimaryContainer = Color(0xFFF4F4F5),
        secondary = Color(0xFFCACCD0), surface = Color(0xFF17181A), onSurface = Color(0xFFF0F0F1), surfaceContainer = Color(0xFF222326),
        surfaceVariant = Color(0xFF34363A), onSurfaceVariant = Color(0xFFC5C6CB), outline = Color(0xFF909197),
        background = Color(0xFF17181A), onBackground = Color(0xFFF0F0F1), surfaceTint = Color(0xFFE5E6E8),
        surfaceBright = Color(0xFF393B3E), surfaceDim = Color(0xFF121315), surfaceContainerLowest = Color(0xFF101113),
        surfaceContainerLow = Color(0xFF1C1D20), surfaceContainerHigh = Color(0xFF2B2D31), surfaceContainerHighest = Color(0xFF36383D),
        onSecondary = Color(0xFF2A2C30), secondaryContainer = Color(0xFF393B40), onSecondaryContainer = Color(0xFFE6E6E9),
        tertiary = Color(0xFFCACCD0), onTertiary = Color(0xFF2A2C30), tertiaryContainer = Color(0xFF393B40), onTertiaryContainer = Color(0xFFE6E6E9),
        inverseSurface = Color(0xFFE5E6E8), inverseOnSurface = Color(0xFF24262A), inversePrimary = Color(0xFF55585E), outlineVariant = Color(0xFF47494E)
    ) else lightColorScheme(
        primary = Color(0xFF202124), onPrimary = Color.White, primaryContainer = Color(0xFFECEDEF), onPrimaryContainer = Color(0xFF202124),
        secondary = Color(0xFF55585E), surface = Color(0xFFFEFEFE), onSurface = Color(0xFF24262A), surfaceContainer = Color(0xFFF2F2F3),
        surfaceVariant = Color(0xFFECEDEF), onSurfaceVariant = Color(0xFF55585E), outline = Color(0xFF74777D),
        background = Color.White, onBackground = Color(0xFF24262A), surfaceTint = Color(0xFF202124),
        surfaceBright = Color.White, surfaceDim = Color(0xFFDADBDD), surfaceContainerLowest = Color.White,
        surfaceContainerLow = Color(0xFFF7F7F8), surfaceContainerHigh = Color(0xFFECEDEE), surfaceContainerHighest = Color(0xFFE5E6E8),
        onSecondary = Color.White, secondaryContainer = Color(0xFFECEDEF), onSecondaryContainer = Color(0xFF24262A),
        tertiary = Color(0xFF55585E), onTertiary = Color.White, tertiaryContainer = Color(0xFFECEDEF), onTertiaryContainer = Color(0xFF24262A),
        inverseSurface = Color(0xFF303236), inverseOnSurface = Color(0xFFF2F2F3), inversePrimary = Color(0xFFD6D7DA), outlineVariant = Color(0xFFD3D5D9)
    )
    val type = Typography(
        headlineMedium = Typography().headlineMedium.copy(fontSize = 28.sp, lineHeight = 36.sp, fontWeight = FontWeight.Medium),
        titleLarge = Typography().titleLarge.copy(fontSize = 22.sp, lineHeight = 28.sp, fontWeight = FontWeight.SemiBold),
        bodyLarge = Typography().bodyLarge.copy(fontSize = 16.sp, lineHeight = 25.sp),
        bodyMedium = Typography().bodyMedium.copy(fontSize = 14.sp, lineHeight = 21.sp),
    )
    MaterialTheme(colorScheme = scheme, typography = type, content = content)
}
@OptIn(ExperimentalMaterial3Api::class)
@Composable fun ColoopApp(model: RemoteViewModel) {
    val state by model.state.collectAsStateWithLifecycle()
    val owner = LocalLifecycleOwner.current
    val snackbar = remember { SnackbarHostState() }
    var settings by rememberSaveable(state.hostId) { mutableStateOf(false) }
    var more by remember { mutableStateOf(false) }
    var licenses by remember { mutableStateOf(false) }
    val context = LocalContext.current
    val licenseText = remember { context.assets.open("third-party-notices.txt").bufferedReader().use { it.readText() } + "\n\n" + context.assets.open("APACHE-2.0.txt").bufferedReader().use { it.readText() } }
    DisposableEffect(owner) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_START) model.foreground(true)
            if (event == Lifecycle.Event.ON_STOP) model.foreground(false)
        }
        owner.lifecycle.addObserver(observer)
        model.foreground(owner.lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED))
        onDispose { owner.lifecycle.removeObserver(observer); model.foreground(false) }
    }
    LaunchedEffect(state.notice) { state.notice?.let {
        if (state.route != Route.CHAT) snackbar.showSnackbar(it)
        model.clearNotice()
    } }
    BackHandler(state.route != Route.CHAT) { model.back() }
    val title = when (state.route) { Route.COMPUTERS -> "设备与连接"; Route.PAIR -> "配对电脑"; Route.COMPUTER -> "电脑会话"; Route.SESSION -> "会话"; Route.CHAT -> "Coloop" }
    Scaffold(
        contentWindowInsets = WindowInsets.safeDrawing,
        topBar = { if (!(state.route == Route.CHAT && compactChatLayout()) && !compactChatKeyboard()) TopAppBar(title = { Text(title, maxLines = 1, overflow = TextOverflow.Ellipsis) },
            navigationIcon = {
                if (state.route != Route.CHAT) IconButton(onClick = model::back) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "返回") }
                else Image(painterResource(R.drawable.ic_coloop), contentDescription = null, modifier = Modifier.padding(start = 20.dp).size(30.dp))
            }, actions = {
                if (state.route != Route.SESSION && state.route != Route.CHAT && state.snapshot?.let { it.active || it.unconfirmed > 0 } == true) {
                    IconButton(onClick = model::stop, enabled = state.link == LinkStatus.ONLINE && !state.stopRequested) { Icon(Icons.Default.Stop, "停止全部控制") }
                }
                if (state.route == Route.COMPUTER || state.route == Route.SESSION || state.route == Route.CHAT) {
                    if (state.route == Route.CHAT) IconButton(onClick = { model.showTaskHistory() }) { Icon(Icons.Default.History, "最近任务") }
                    if (state.route == Route.CHAT) IconButton(onClick = model::openComputers) { Icon(Icons.Default.Devices, "打开设备与连接") }
                    else IconButton(onClick = model::refresh, enabled = !state.busy && !state.refreshing) { Icon(Icons.Default.Refresh, "刷新连接") }
                    if (state.computer != null) IconButton(onClick = { settings = true }, enabled = !state.busy) { Icon(Icons.Default.Settings, "连接设置") }
                }
                if (state.route == Route.COMPUTERS) Box {
                    IconButton(onClick = { more = true }) { Icon(Icons.Default.MoreVert, "更多选项") }
                    DropdownMenu(expanded = more, onDismissRequest = { more = false }) {
                        if (state.computer != null) DropdownMenuItem(text = { Text("其他 AI 会话") }, leadingIcon = { Icon(Icons.Default.Forum, null) },
                            onClick = { more = false; model.openSessions() })
                        DropdownMenuItem(text = { Text("关于与开源许可") }, leadingIcon = { Icon(Icons.Default.Info, null) },
                            onClick = { more = false; licenses = true })
                    }
                }
            }) },
        snackbarHost = { SnackbarHost(snackbar) }
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(padding).consumeWindowInsets(padding), contentAlignment = Alignment.TopCenter) {
            val content = Modifier.widthIn(max = 840.dp).fillMaxWidth()
            when (state.route) {
                Route.COMPUTERS -> Computers(state, model, content) { settings = true }
                Route.PAIR -> PairComputer(state, model, content)
                Route.COMPUTER -> ComputerDetail(state, model, content)
                Route.SESSION -> SessionDetail(state, model, content)
                Route.CHAT -> ColoopChat(state, model, content)
            }
        }
    }
    if (settings && state.computer != null) ConnectionSettings(state, model) { settings = false }
    if (licenses) AlertDialog(onDismissRequest = { licenses = false }, title = { Text("关于与开源许可") },
        text = { Text(licenseText, style = MaterialTheme.typography.bodySmall, modifier = Modifier.verticalScroll(rememberScrollState())) },
        confirmButton = { TextButton(onClick = { licenses = false }) { Text("关闭") } })
}
@Composable private fun SectionTitle(text: String, modifier: Modifier = Modifier) {
    Text(text, style = MaterialTheme.typography.titleLarge, modifier = modifier.semantics { heading() })
}
@Composable private fun EmptyMessage(icon: ImageVector, title: String, body: String, modifier: Modifier = Modifier) {
    Column(modifier.padding(vertical = 32.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Icon(icon, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(40.dp))
        Text(title, style = MaterialTheme.typography.headlineSmall)
        Text(body, style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}
@Composable private fun ErrorMessage(text: String) {
    Row(Modifier.fillMaxWidth().padding(vertical = 12.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Icon(Icons.Default.Info, null, tint = MaterialTheme.colorScheme.error)
        Text(text, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.error, modifier = Modifier.weight(1f))
    }
}
@Composable private fun Computers(state: MobileState, model: RemoteViewModel, modifier: Modifier, openSettings: () -> Unit) {
    LazyColumn(modifier.fillMaxSize(), contentPadding = PaddingValues(horizontal = 24.dp, vertical = 16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item { SectionTitle("你的电脑") }
        if (state.loading) item { LinearProgressIndicator(Modifier.fillMaxWidth()); Text("正在读取安全连接资料", Modifier.padding(top = 16.dp)) }
        state.error?.let { item { ErrorMessage(it) } }
        if (!state.loading && state.computers.isEmpty()) item {
            EmptyMessage(Icons.Default.Computer, "让任务继续进行", "在电脑的「Agent 协调 → 安卓手机连接」中开启手机连接，再扫码配对。用手机流量也能查看会话、追加要求和停止控制。")
            Button(onClick = { model.openPair() }, Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Icon(Icons.Default.QrCodeScanner, null); Spacer(Modifier.width(8.dp)); Text("扫码连接电脑") }
        }
        items(state.computers, key = { it.hostId }) { computer ->
            ListItem(modifier = Modifier.fillMaxWidth().clickable { model.selectComputer(computer.hostId) }.heightIn(min = 88.dp),
                headlineContent = { Text(computer.name, maxLines = 2, overflow = TextOverflow.Ellipsis) },
                supportingContent = { Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(if (state.hostId == computer.hostId) "当前电脑 · ${connectionTitle(state)}" else "点按连接")
                    Text(Uri.parse(computer.endpoint).host ?: computer.endpoint, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodySmall)
                    if (computer.pendingCommandId != null) Text("有一条要求等待核对回执")
                } }, leadingContent = { Icon(Icons.Default.Computer, null) }, trailingContent = { Icon(Icons.Default.ChevronRight, null) })
            HorizontalDivider()
        }
        if (state.computers.isNotEmpty()) item {
            OutlinedButton(onClick = { model.openPair() }, Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Icon(Icons.Default.Add, null); Spacer(Modifier.width(8.dp)); Text("连接另一台电脑") }
            Text("配对后，打开 App 会自动连接。电脑需要保持 Coloop 运行。", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 16.dp))
            TextButton(onClick = openSettings, modifier = Modifier.heightIn(min = 48.dp)) { Icon(Icons.Default.Settings, null, Modifier.size(18.dp)); Spacer(Modifier.width(8.dp)); Text("连接设置") }
        }
    }
}
@Composable private fun PairComputer(state: MobileState, model: RemoteViewModel, modifier: Modifier) {
    val context = LocalContext.current
    var cameraDenied by remember { mutableStateOf(false) }
    var manual by rememberSaveable { mutableStateOf(false) }
    val hasInvitation = state.pairRaw.isNotBlank()
    val scanner = rememberLauncherForActivityResult(ScanContract()) { result -> result.contents?.let(model::pairDraft) }
    val launchScan = {
        scanner.launch(ScanOptions().setDesiredBarcodeFormats(ScanOptions.QR_CODE).setPrompt("扫描电脑 Coloop 中的配对码").setBeepEnabled(false).setOrientationLocked(false))
    }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted -> if (granted) launchScan() else cameraDenied = true }
    Column(modifier.fillMaxHeight().imePadding().verticalScroll(rememberScrollState()).padding(24.dp), verticalArrangement = Arrangement.spacedBy(20.dp)) {
        Icon(Icons.Default.Phonelink, null, Modifier.padding(top = 12.dp).size(40.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(if (hasInvitation) "确认配对" else "连接你的 Coloop", style = MaterialTheme.typography.headlineMedium)
        Text(if (hasInvitation) "请确认配对地址来自自己的电脑。Coloop 会先核对电脑身份。" else "首次配对需要在电脑旁完成。之后打开 App，就能连接这台电脑。", style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
        if (!hasInvitation) Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
            PairStep("1", "在电脑打开 Coloop", "进入「Agent 协调 → 安卓手机连接」。")
            PairStep("2", "显示配对码", "开启手机连接，再选择「配对安卓手机」。")
            PairStep("3", "用手机扫描", "核对电脑后确认连接，配对码只能使用一次。")
        }
        if (!hasInvitation) Button(onClick = {
            cameraDenied = false
            if (ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) launchScan()
            else permission.launch(Manifest.permission.CAMERA)
        }, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp), enabled = !state.busy) { Icon(Icons.Default.QrCodeScanner, null); Spacer(Modifier.width(8.dp)); Text("扫描配对码") }
        if (cameraDenied) Text("未获得相机权限，可以粘贴电脑复制的完整配对地址。", style = MaterialTheme.typography.bodyMedium)
        if (!hasInvitation) TextButton(onClick = { manual = !manual }, enabled = !state.busy, modifier = Modifier.heightIn(min = 48.dp)) {
            Icon(Icons.Default.ContentPaste, null, Modifier.size(18.dp)); Spacer(Modifier.width(8.dp)); Text("使用配对地址")
        }
        AnimatedVisibility(visible = manual || state.pairRaw.isNotBlank() || cameraDenied) {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                OutlinedTextField(value = state.pairRaw, onValueChange = model::pairDraft, label = { Text("完整配对地址") }, placeholder = { Text("coloop://pair?data=…") },
                    minLines = 2, maxLines = 4, enabled = !state.busy, modifier = Modifier.fillMaxWidth(), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri))
                TextButton(onClick = {
                    val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                    clipboard.primaryClip?.getItemAt(0)?.coerceToText(context)?.toString()?.let(model::pairDraft)
                }, enabled = !state.busy, modifier = Modifier.heightIn(min = 48.dp)) { Text("从剪贴板粘贴") }
            }
        }
        state.error?.let { ErrorMessage(it) }
        if (state.pairRaw.isNotBlank()) Button(onClick = model::pair, enabled = !state.busy, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
            if (state.busy) { CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp); Spacer(Modifier.width(12.dp)) }
            Text(if (state.busy) "正在验证并配对" else "连接电脑")
        }
        Text("连接资料由 Android 安全存储保护。App 在前台时自动刷新，退到后台后暂停。", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}
@Composable private fun PairStep(number: String, title: String, detail: String) {
    Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
        Text(number, style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.width(20.dp))
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(title, style = MaterialTheme.typography.titleSmall)
            Text(detail, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}
private fun linkLabel(status: LinkStatus) = when (status) { LinkStatus.DISCONNECTED -> "未连接"; LinkStatus.CONNECTING -> "正在连接"; LinkStatus.ONLINE -> "已连接"; LinkStatus.OFFLINE -> "连接已断开" }
private fun sessionLabel(session: RemoteSession, stopped: Boolean): String = if (!session.connected) "会话已断开" else if (stopped) "控制已暂停，请先恢复" else when (session.state) {
    "idle" -> if (session.host == "windows" && session.canSend) "空闲，可追加要求" else "空闲，仅可查看"; "running" -> "正在执行"; "awaiting_input" -> "等待输入"; "closed" -> "已关闭"; else -> "会话异常"
}
@Composable internal fun LinkHeader(state: MobileState) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Icon(if (state.link == LinkStatus.ONLINE) Icons.Default.Link else Icons.Default.LinkOff, null)
        Column(Modifier.weight(1f)) {
            Text(linkLabel(state.link), style = MaterialTheme.typography.titleMedium)
            Text(if (state.link == LinkStatus.ONLINE) "前台每 2 秒刷新" else "电脑在线且远程连接开启后可恢复", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        if (state.refreshing) CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 2.dp)
    }
    state.error?.let { ErrorMessage(it) }
    if (state.link == LinkStatus.OFFLINE && state.snapshot != null) Text("以下是上次同步的状态，当前执行结果需要重新连接后核对。", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 12.dp))
}
@Composable internal fun ControlActions(state: MobileState, model: RemoteViewModel) {
    val snapshot = state.snapshot ?: return
    if (snapshot.stopped || snapshot.active || snapshot.unconfirmed > 0 || state.pendingId != null) {
        Surface(color = MaterialTheme.colorScheme.surfaceContainer, shape = MaterialTheme.shapes.medium) {
            Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(when { snapshot.stopped -> "电脑控制已暂停"; snapshot.unconfirmed > 0 || state.pendingId != null -> "正在核对控制回执"; else -> "电脑控制进行中" }, style = MaterialTheme.typography.titleMedium)
                Text(if (state.pendingId != null) "这条要求正在核对。网络中断时不会自动重发，请等待来源回执或检查电脑。" else if (snapshot.stopped) "恢复只允许提交新要求，不会重新发送旧指令。" else "电脑会显示控制提示。停止需要等待原会话确认。", style = MaterialTheme.typography.bodyMedium)
                if (state.stopRequested) Text("正在等待原会话确认停止，请稍候。", style = MaterialTheme.typography.bodyMedium)
                if (snapshot.stopped && !snapshot.active && snapshot.unconfirmed == 0) Button(onClick = model::resume, enabled = state.link == LinkStatus.ONLINE && !state.busy && !state.stopRequested, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("明确恢复控制") }
                if (state.pendingId != null && !snapshot.active && snapshot.unconfirmed == 0) TextButton(onClick = model::acknowledgeUnknown, enabled = state.link == LinkStatus.ONLINE && !state.busy, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("我已检查原会话，结束核对") }
            }
        }
    }
}
@Composable private fun ComputerDetail(state: MobileState, model: RemoteViewModel, modifier: Modifier) {
    LazyColumn(modifier.fillMaxSize(), contentPadding = PaddingValues(24.dp), verticalArrangement = Arrangement.spacedBy(20.dp)) {
        item { LinkHeader(state) }
        item { ControlActions(state, model) }
        item {
            ListItem(modifier = Modifier.clickable(onClick = model::openColoop).heightIn(min = 88.dp),
                headlineContent = { Text("给 Coloop 发任务", style = MaterialTheme.typography.titleLarge) },
                supportingContent = { Text("交给 RK 处理，查看电脑操作进度") },
                leadingContent = { Icon(Icons.Default.Computer, null) }, trailingContent = { Icon(Icons.Default.ChevronRight, null) })
            HorizontalDivider()
        }
        item { SectionTitle("AI 会话") }
        if (state.snapshot?.sessions.isNullOrEmpty()) item {
            EmptyMessage(Icons.Default.Forum, "还没有接入的会话", "在电脑启动已接入 Coloop 的 OpenCode 会话。来源注册后，会话会显示在这里。")
            OutlinedButton(onClick = model::refresh, enabled = !state.refreshing, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("刷新会话") }
        }
        items(state.snapshot?.sessions.orEmpty(), key = { it.handle }) { session ->
            ListItem(modifier = Modifier.clickable { model.selectSession(session.handle) }.heightIn(min = 88.dp),
                headlineContent = { Text(session.title, maxLines = 2, overflow = TextOverflow.Ellipsis) }, supportingContent = { Column {
                    Text(sessionLabel(session, state.snapshot?.stopped == true)); Text(if (session.host == "windows") "OpenCode · Windows" else "OpenCode · ${session.host}", style = MaterialTheme.typography.bodySmall)
                } }, leadingContent = { Icon(Icons.Default.Forum, null) }, trailingContent = { Icon(Icons.Default.ChevronRight, null) })
            HorizontalDivider()
        }
        if (!state.snapshot?.commands.isNullOrEmpty()) item {
            SectionTitle("最近回执")
            state.snapshot?.commands?.take(5)?.forEach { receipt -> ReceiptLine(receipt) }
        }
    }
}
@Composable private fun SessionDetail(state: MobileState, model: RemoteViewModel, modifier: Modifier) {
    val session = state.session
    var draft by remember(state.sessionHandle) { mutableStateOf("") }
    val pending = state.pendingId != null
    val bytes = draft.toByteArray().size
    Column(modifier.fillMaxHeight().imePadding()) {
        LazyColumn(Modifier.weight(1f), contentPadding = PaddingValues(24.dp), verticalArrangement = Arrangement.spacedBy(20.dp)) {
            item { LinkHeader(state) }
            item { ControlActions(state, model) }
            if (session == null) item { EmptyMessage(Icons.Default.Forum, "会话已不可用", "返回电脑页面刷新，检查原会话是否已关闭。") }
            else {
                item { SectionTitle(session.title); Text(sessionLabel(session, state.snapshot?.stopped == true), style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(top = 8.dp)); Text(session.workspace, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 8.dp)) }
                item { SectionTitle("近期进度") }
                val progress = state.snapshot?.progress.orEmpty().filter { it.sessionHandle == session.handle }
                if (progress.isEmpty()) item { Text("尚未收到新的进度。来源上报后会自动显示。", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                items(progress) { item ->
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) { Text(item.text, style = MaterialTheme.typography.bodyLarge); Text(timeLabel(item.at), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                    HorizontalDivider(Modifier.padding(top = 16.dp))
                }
                val receipts = state.snapshot?.commands.orEmpty().filter { it.sessionHandle == session.handle }.take(5)
                if (receipts.isNotEmpty()) item { SectionTitle("命令回执"); receipts.forEach { ReceiptLine(it) } }
            }
        }
        val needsStop = state.snapshot?.let { it.active || it.unconfirmed > 0 } == true
        if (session != null || needsStop) Surface(tonalElevation = 2.dp) {
            Column(Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                if (needsStop) OutlinedButton(onClick = model::stop, enabled = state.link == LinkStatus.ONLINE && !state.stopRequested, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
                    Icon(Icons.Default.Stop, null); Spacer(Modifier.width(8.dp)); Text(if (state.stopRequested) "等待停止确认" else "停止全部控制")
                }
                if (session != null) {
                OutlinedTextField(draft, { draft = it }, label = { Text("追加新的要求") }, minLines = 2, maxLines = 6,
                    modifier = Modifier.fillMaxWidth(), enabled = !state.busy && !pending && !state.stopRequested && state.snapshot?.stopped == false, isError = bytes > 8192,
                    supportingText = { Text(when { state.snapshot?.stopped == true -> "控制已暂停，请先明确恢复控制"; bytes > 8192 -> "要求过长，请缩短到 8192 字节以内"; session.host != "windows" -> "当前仅支持 Windows 上的会话控制"; pending -> "上一条要求仍在核对，不会重复发送"; else -> "在会话空闲时追加；只控制当前选中的会话" }) },
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences))
                Button(onClick = { val text = draft; draft = ""; model.send(text) }, enabled = draft.isNotBlank() && bytes <= 8192 && !state.busy && !pending &&
                    state.link == LinkStatus.ONLINE && !state.stopRequested && state.snapshot?.stopped == false && session.connected && session.state == "idle" && session.host == "windows" && session.canSend,
                    modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
                    Icon(Icons.AutoMirrored.Filled.Send, null); Spacer(Modifier.width(8.dp)); Text(if (state.busy) "正在提交" else "发送到这个会话")
                }
                }
            }
        }
    }
}
internal fun timeLabel(value: String): String = runCatching { DateTimeFormatter.ofPattern("MM-dd HH:mm:ss").withZone(ZoneId.systemDefault()).format(Instant.parse(value)) }.getOrDefault("")
@Composable private fun ReceiptLine(receipt: Receipt) {
    Row(Modifier.fillMaxWidth().padding(vertical = 12.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Icon(if (receipt.status == "confirmed") Icons.Default.CheckCircle else Icons.Default.Info, null)
        Column(Modifier.weight(1f)) {
            Text("${if (receipt.action == "abort_turn") "停止控制" else "追加要求"} · ${receiptLabel(receipt.status)}", style = MaterialTheme.typography.bodyMedium)
            Text(timeLabel(receipt.at), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (receipt.status == "unknown") Text(if (receipt.resolved) "已另行确认停止，原发送结果仍未知" else "请检查原会话，不会自动重试", style = MaterialTheme.typography.bodySmall)
        }
    }
}
@Composable private fun ConnectionSettings(state: MobileState, model: RemoteViewModel, dismiss: () -> Unit) {
    var endpoint by rememberSaveable(state.hostId) { mutableStateOf(state.computer?.endpoint.orEmpty()) }
    var editing by rememberSaveable { mutableStateOf(false) }
    var forget by remember { mutableStateOf(false) }
    var onlyLocal by remember { mutableStateOf(state.link != LinkStatus.ONLINE) }
    val online = state.link == LinkStatus.ONLINE
    LaunchedEffect(state.notice) { if (state.notice == "已验证原电脑并更新地址") dismiss() }
    if (forget) {
        val local = onlyLocal || !online
        AlertDialog(onDismissRequest = { forget = false }, title = { Text(if (local) "移除本机连接资料？" else "解除这台手机的配对？") },
            text = { Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(if (local) "手机将删除这台电脑的连接资料。电脑上的访问授权不会撤销，请到电脑检查并撤销旧授权。" else "电脑会撤销这台手机的访问授权。以后需要重新扫码配对。")
                if (online) Row(Modifier.fillMaxWidth().heightIn(min = 48.dp).clickable { onlyLocal = !onlyLocal }, verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(onlyLocal, { onlyLocal = it }); Text("只移除本机资料", style = MaterialTheme.typography.bodyMedium)
                }
            } },
            confirmButton = { TextButton(onClick = { model.forget(!local); dismiss() }, enabled = !state.busy) { Text(if (local) "移除资料" else "解除配对", color = MaterialTheme.colorScheme.error) } },
            dismissButton = { TextButton(onClick = { forget = false }) { Text("取消") } })
    } else AlertDialog(onDismissRequest = dismiss, title = { Text(if (editing) "更新远程地址" else "连接设置") },
        text = { Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            Text(state.computer?.name.orEmpty(), style = MaterialTheme.typography.titleMedium)
            if (!editing) {
                Text(connectionTitle(state), style = MaterialTheme.typography.bodyMedium)
                Text("打开 App 后自动连接这台电脑。连接中断时会重试，消息不会重复发送。", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                if (online && state.snapshot?.stopped == true) Text("接收任务已暂停，可返回聊天后恢复。", style = MaterialTheme.typography.bodyMedium)
                else OutlinedButton(onClick = model::repairConnection, enabled = !state.busy && !state.stopRequested, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
                    Icon(Icons.Default.Refresh, null, Modifier.size(18.dp)); Spacer(Modifier.width(8.dp)); Text("重新连接")
                }
                HorizontalDivider()
                TextButton(onClick = { editing = true }, modifier = Modifier.heightIn(min = 48.dp)) { Icon(Icons.Default.Edit, null, Modifier.size(18.dp)); Spacer(Modifier.width(8.dp)); Text("更新远程地址") }
                TextButton(onClick = { forget = true }, modifier = Modifier.heightIn(min = 48.dp)) { Icon(Icons.Default.LinkOff, null, Modifier.size(18.dp)); Spacer(Modifier.width(8.dp)); Text("解除配对或移除本机资料", color = MaterialTheme.colorScheme.error) }
            } else {
                Text("地址改变时，粘贴电脑显示的新 HTTPS 地址。更新前会核对原来的电脑身份。", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                OutlinedTextField(endpoint, { endpoint = it }, label = { Text("电脑远程地址") }, minLines = 2, maxLines = 4, modifier = Modifier.fillMaxWidth(), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri))
                Text("电脑身份：${state.hostId}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            state.error?.let { ErrorMessage(it) }
        } },
        confirmButton = { TextButton(onClick = { if (editing) model.updateEndpoint(endpoint) else dismiss() }, enabled = !state.busy && (!editing || endpoint.isNotBlank())) { Text(if (editing) { if (state.busy) "正在核对…" else "验证并更新" } else "关闭") } },
        dismissButton = { if (editing) TextButton(onClick = { editing = false }, enabled = !state.busy) { Text("返回") } })
}
