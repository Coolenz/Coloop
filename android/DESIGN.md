---
name: Coloop Android
description: Native phone chat for goals, connection readiness, and verified computer-task replies.
colors:
  primary: "#202124"
  on-primary: "#FFFFFF"
  canvas: "#FFFFFF"
  surface: "#FEFEFE"
  ink: "#24262A"
  supporting-ink: "#55585E"
  container: "#F2F2F3"
  message-surface: "#ECEDEE"
  tonal-container: "#ECEDEF"
  line: "#D3D5D9"
  outline: "#74777D"
  dark-primary: "#E5E6E8"
  dark-on-primary: "#202124"
  dark-canvas: "#17181A"
  dark-surface: "#17181A"
  dark-ink: "#F0F0F1"
  dark-supporting-ink: "#C5C6CB"
  dark-container: "#222326"
  dark-message-surface: "#2B2D31"
  dark-tonal-container: "#393B40"
  dark-line: "#47494E"
  dark-outline: "#909197"
  connected: "#28775B"
  dark-connected: "#84D6B1"
  waiting-surface: "#FFF1CC"
  waiting-ink: "#715000"
  dark-waiting-surface: "#3C3013"
  dark-waiting-ink: "#F2D080"
typography:
  headline:
    fontFamily: "Roboto, sans-serif"
    fontSize: "28sp"
    fontWeight: 500
    lineHeight: "36sp"
  title:
    fontFamily: "Roboto, sans-serif"
    fontSize: "22sp"
    fontWeight: 600
    lineHeight: "28sp"
  body:
    fontFamily: "Roboto, sans-serif"
    fontSize: "16sp"
    fontWeight: 400
    lineHeight: "25sp"
  body-medium:
    fontFamily: "Roboto, sans-serif"
    fontSize: "14sp"
    fontWeight: 400
    lineHeight: "21sp"
rounded:
  bubble: "16dp"
  bubble-tail: "4dp"
  composer: "24dp"
spacing:
  compact: "8dp"
  related: "12dp"
  control: "16dp"
  conversation-edge: "20dp"
  section: "24dp"
  task-gap: "28dp"
  sheet-bottom: "32dp"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    height: "48dp"
  button-primary-dark:
    backgroundColor: "{colors.dark-primary}"
    textColor: "{colors.dark-on-primary}"
    height: "48dp"
  send:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    size: "48dp"
  user-message:
    backgroundColor: "{colors.message-surface}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    padding: "12dp 16dp"
    width: "560dp"
  user-message-dark:
    backgroundColor: "{colors.dark-message-surface}"
    textColor: "{colors.dark-ink}"
    typography: "{typography.body}"
    padding: "12dp 16dp"
    width: "560dp"
  composer:
    textColor: "{colors.ink}"
    rounded: "{rounded.composer}"
  connection-strip:
    padding: "10dp 20dp"
  task-options:
    padding: "0dp 24dp"
---

# Design System: Coloop Android

## Overview

**Creative North Star: "The Connected Conversation"**

Coloop's graphite, white, and paired closed-arc mark carry into a native Material 3 phone interface. Typography, touch behavior, fields, dialogs, and sheets follow Android expectations. Brand expression comes from the quiet neutral surfaces and existing vector mark; no new shipping raster asset was added.

This system is extracted from `app/src/main/java/ai/coloop/mobile/MainActivity.kt`, `ColoopChat.kt`, `TaskHistorySheet.kt`, `ColoopModels.kt`, `RemoteViewModel.kt`, and `RemoteRepository.kt`. It is scoped to Android; repository-root `DESIGN.md` and `.impeccable/design.json` describe desktop identity. The user-selected composition and Mode: Operate live in `../docs/android-chat-brief.md`.

**Key Characteristics:**
- Native system sans typography, font scaling, Material controls, and system Back.
- Graphite primary actions, tonal neutral surfaces, and restrained semantic status color.
- User messages and Coloop replies with distinct alignment and real task state.
- Connection repair and safe task controls that preserve the user's draft.

## Colors

The frontmatter extracts the actual light and dark roles from `ColoopTheme`; these supersede provisional colors in the surface brief. Components consume `MaterialTheme.colorScheme`, with explicit paired status colors in the connection strip and waiting notice.

### Primary
- **Graphite Action** (`primary`, `on-primary`): filled actions and Send in light theme.
- **Light Graphite Action** (`dark-primary`, `dark-on-primary`): the corresponding readable action pair in dark theme.

### Neutral
- **Paper and Surface** (`canvas`, `surface`): light screen and composer.
- **Reading Ink** (`ink`, `supporting-ink`): primary content and quieter explanatory text.
- **Tonal Layers** (`container`, `message-surface`, `tonal-container`): Material containers and user messages.
- **Boundaries** (`line`, `outline`): dividers and outlined fields.
- **Dark Layers** (the `dark-` neutral tokens): independently defined surfaces, text, borders, and messages; use the native dark scheme rather than a visual inversion.

### Semantic status
- **Connected Green** (`connected`, `dark-connected`): connection readiness with visible state text.
- **Recoverable Amber** (`waiting-surface`, `waiting-ink` and their `dark-` counterparts): an expected RK connection or model-start wait.
- **Material Error**: `error`, `errorContainer`, and `onErrorContainer` remain inherited native Material 3 roles for actual failures; no custom brand-red token is established.

**The Status Has Words Rule.** Color accompanies connection and task-state wording; it never substitutes for that wording. Transport readiness, RK connection, local-model startup, and verified task completion remain distinct states.

## Typography

**Body and controls:** Android system sans through Compose Material 3 typography. Text uses sp and follows system font-size preferences. The incumbent mark is a vector asset; no display typeface is introduced.

### Hierarchy
- **Headline**: `headlineMedium`, used for the empty conversation prompt.
- **Title**: `titleLarge`, used by the native top app bar and section/sheet titles. The implemented token above supersedes the brief's provisional app-title size.
- **Body**: `bodyLarge`, used for user messages and Coloop replies.
- **Supporting body**: `bodyMedium`, used for setup, settings, and options explanations.
- **Labels and small text**: `titleSmall`, `bodySmall`, `labelLarge`, `labelMedium`, and `labelSmall` retain Material defaults. Sender identification uses semibold; state, processing source, and timestamp have separate roles.

**The Native Type Rule.** Extend Material text roles and preserve system scaling; do not copy desktop Windows text metrics into Android controls.

## Layout

This release is phone-first. The main content width remains capped at 840dp; a right-aligned user bubble is capped at the smaller of 88% of the available row and 560dp. These caps do not establish a tablet-specific layout or verified tablet support. Goals and replies are separately keyed items in the weighted `LazyColumn`, so each can enter and leave the viewport independently. The list has 20dp horizontal/vertical content padding and 20dp item spacing; goal rows add 8dp at the top and reply rows add 8dp at the bottom. The empty view retains 28dp horizontal padding.

Portrait keeps the app bar, connection strip, growing composer, optional constraint chips, and explanatory footer. Phone landscape uses the connection strip as its compact header, omits the separate chat app bar and lower-priority footer/chip rows, and retains the options-count badge and sheet. The draft shows up to two lines in landscape or one line while the landscape IME is visible; active Stop sits beside Send. Online paused state exposes Resume in the compact header. Portrait drafts show up to four lines. Relevant error feedback remains visible outside the compact keyboard view; a blocked landscape-keyboard send dismisses the keyboard so the explanation can be read.

Actions use native Material touch behavior and explicit 48dp minimum heights; Send and compact Stop are 48dp square. Adjacent composer actions have 8dp separation. The return-to-latest action has a 48dp minimum height and 8dp bottom clearance; it appears while the last lazy row is outside the visible items, only when the weighted history region has at least 56dp of height. App-bar icon controls retain native touch bounds and content descriptions. Device/session rows retain an 88dp minimum height and wrap before ellipsis.

`enableEdgeToEdge()` and `Scaffold(contentWindowInsets = WindowInsets.safeDrawing)` account for bars and cutouts. Content consumes scaffold insets once; chat and pairing add IME padding. The task-options `ModalBottomSheet` uses `rememberModalBottomSheetState(skipPartiallyExpanded = true)`, vertical scrolling, and IME padding. Bottom padding adds the host view's raw navigation inset from `ViewCompat.getRootWindowInsets(hostView).getInsetsIgnoringVisibility(WindowInsetsCompat.Type.navigationBars())`, converted to dp, to the extracted sheet-bottom spacing. Read this inset from the host view because the parent has already consumed Compose insets. Its final action must remain reachable with the keyboard, gesture bar, and enlarged text. Preserve Android Back dismissal and route return behavior.

Android 0.6.0 (version code 7) extends the existing native system with task-journey controls. Recent tasks are a native sheet, linked from the chat toolbar and compact landscape strip; its rows navigate to the associated reply and the feed is capped by the computer's 20-record public snapshot, not a durable local archive. The sheet constrains height to 85% of the current window, uses 24dp horizontal padding, and gives its list the remaining space. Its All/Unfinished native filter chips retain 48dp targets. Unfinished includes every state except completed and answered, including awaiting-input and active work; offline wording identifies retained records as last-synced data. Current-task context remains above portrait conversation, with a direct Supplement action for the latest awaiting-input task. Supplement names its original goal, focuses the composer, supports cancellation, and validates combined original/additional length before sending. Completed/replied/failed/stopped/interrupted outcomes offer editable reuse; a nonempty draft must be confirmed before replacement. Reuse never calls the message RPC itself and resets task options for explicit review. Connection error recovery is an inline action chosen from current link/admission/paused/activity state. Receipt uncertainty requires a snapshot checked for the current pending UUID, including Coloop inactivity, and a separate confirmation before local acknowledgement. Confirmation invalidates that cached check and fetches another encrypted snapshot before resolving; failed refresh, host/pending change, active or unconfirmed work preserves the pending marker. Finding the original task or resolved receipt reconciles it without replay. Initial unpaired connection goes straight to the native pair guide while retaining the draft. Task navigation waits for the lazy rows to exist before scrolling.

Current native evidence for this expansion is under `../.impeccable/review/android-0.6.0/`. First-round `verification.json` and `first-run-verification.json` pass eight and three checks respectively. Current JVM XML totals 20 tests with zero failures, errors, or skips. The first finish review requested two material corrections: discoverable awaiting-input/active work in Unfinished, and fresh snapshot checking before ending receipt uncertainty. The final `correction-verification.json` passes five automated checks in one final-APK run: cached idle plus failed snapshots cannot enable acknowledgement; newly active work preserves pending; a failed confirmation refresh preserves pending; only fresh idle confirmation clears pending with one original submission and no replay; and Unfinished includes awaiting-input/failed records, excludes answered and locates the reply for supplement. An earlier harness attempt incorrectly awaited an action hidden during activity; it was corrected to assert the pending footer, with no production change for that harness issue. The first-round eight plus three checks and final five correction checks are separate runs, not one uninterrupted sixteen-check final-APK pass. The refreshed capture index contains 21 actual phone PNGs, including the changed filter captures and six new correction captures; all changed captures were opened by the builder and all 15 first-round captures had independent review. The scoped `verdict-pass-1.md` independently reopens all eight correction/changed captures, marks both findings resolved and records `disposition: ship`, with no visible regression attributable to this batch. This verdict covers the two scored fixes, not the whole surface. Models and HID are explicitly synthetic; native Android Keystore, encrypted gateway and task admission are exercised. This expansion does not add process-death draft recovery, background sending, a full archive, new execution capabilities, or a new real RK/HID, QQ Mail, or cloud-planning claim.

Android 0.5.1 (version code 6) hardens composer and option interactions without changing tokens or the visual world. The message draft is retained in full in memory rather than silently truncated at 2000 UTF-16 code units (the wire limit). At 1800 units portrait shows a length counter; beyond 2000 the field and counter use error roles, and sending explains the limit before any connection/admission attempt. Editing back within range clears the send error. Landscape blocked-send dismissal still exposes the explanation. This is input retention during the current session, not process-death draft persistence.

Task options edit local sheet values. Done applies the window and completion condition together; Cancel, system Back, and outside dismissal discard unapplied edits. Reopening starts from applied options, while rotation retains edits in the open sheet. Option fields show at most three lines with internal text scrolling, preventing long values from displacing the final actions. Limits of 250 units for window title and 128 for completion condition are visible on overflow; Done stays disabled until both are valid. Existing chips clear applied values immediately. A cached RK-connecting snapshot only animates when the computer link is online; offline and online-paused states suppress that stale activity indicator. The 0.5.0 independent verdict below applies to its prior fix list, not a new review of 0.5.1. Current scoped emulator evidence is under `../.impeccable/review/android-0.5.1/`: the eight-check composer/options report and two-check dark/font1.3 option-validation report pass, alongside 16 JVM tests. Native renders cover light/dark/font1.3 and landscape IME; this pass drives local composer/options behavior without model or HID calls.

Android 0.5.0 (version code 5) UI evidence is indexed at `../.impeccable/review/android-0.5.0/capture-index.json`: actual Android Emulator phone captures in portrait and landscape, light/dark, font scale 1.3, IME, copy/history, guided/manual pairing, task options, connection settings, and cancellable removal. The four reports at `../.qa/android-0.5.0-r2/{verification,secondary-verification,reading-verification,polish-verification}.json` pass 9, 4, 2, and 4 checks respectively, with explicit synthetic RK/HID data. Their coverage includes encrypted admission/stop flow, first-pair draft retention, different-computer constraint reset, native Copy, Latest navigation, and options completion above the IME/navigation area. The initial finish review requested landscape-history and offline-settings corrections. The final `../.qa/android-0.5.0-r2/verdict-verification.json` passes four automated correction checks as a continuation from an independently confirmed native Stop state: online-paused settings guidance; offline landscape-IME sending with draft retention; readable non-IME landscape history (344px in this emulator capture) with a fully visible 48dp Latest target; and Reconnect in offline cached-stopped light and dark/font1.3 settings. `../.qa/android-0.5.0-r2/restart-stop-verification.json` separately passes two checks: the automated force-stop/relaunch phase retains the selected second computer; landscape Stop was tapped stepwise through native text semantics after layout stabilized, with `stopped=true` confirmed and the next draft retained. Rotation/IME timing failures from the complete serial automation remain in QA history. This is four automated continuation checks plus separate automated-restart/stepwise-Stop evidence, not six uninterrupted automated checks. All 14 JVM tests pass in `app/build/test-results/testDebugUnitTest/`, including two `HostOrderTest` checks for preferred-computer order during connection/receipt updates. The capture index contains 35 phone PNGs and binds these final checks to APK SHA256 `aed6f693e356f0fbdb9660cac03b6204dca9a770265ee609befd20474d929892`.

The scoped correction review at `../.impeccable/review/android-0.5.0/verdict-pass-1.md` records both material fixes resolved and `disposition: ship`, with no visible regression in the supplied correction captures. That verdict covers the scored landscape-history/Latest and offline-settings repairs; it does not certify the whole surface. It records the linked preferred-computer correction and the automated-continuation/stepwise-Stop limits without extending the visual review or hardware claims.

The prior nine-check `../.qa/violoop-rk-live-1793386785409/verification.json` applies to Android 0.4.0 plus packaged companion 0.13.0: real RK/USB-HID greeting with zero input actions, independently observed random-code entry and one Apply click, one plan/two actions/two full observations, phone verified-result return, and Stop before another HID submission. It establishes only that tested single-window ASCII route. The 0.5 UI pass does not claim a new real RK/HID run, cross-application work, Chinese input, cloud desktop planning, the full QQ Mail flow, or tablet verification.

## Elevation & Depth

Persistent chat is flat, separated by whitespace, neutral surface tone, and native dividers. User messages have tonal surfaces without arbitrary shadows. Material modal sheets/dialogs supply native overlay depth. The advanced session composer retains its existing 2dp native tonal elevation; it is not a conversation-wide rule. Native progress indicators, `animateContentSize()`, and list scrolling communicate state; no custom motion duration or easing token is established.

**The Native Surface Rule.** Use Material surfaces and native overlay behavior; preserve the distinction between a persistent message and an interrupting sheet or dialog.

## Shapes

The right-aligned user-message surface has 16dp corners with a 4dp bottom-right corner. The chat field uses the extracted composer radius. Circular icon actions and the readiness dot use native circular geometry. Other buttons, fields, dialogs, and sheets retain Material shapes. The tilted paired-arc vector remains the incumbent asset; functional controls stay horizontal.

## Components

### Buttons

Filled Material buttons carry primary actions; outlined buttons carry Stop and secondary connection actions; text buttons carry repair, explicit Resume, and reconciliation. Preserve native focused, pressed, disabled, and loading states. Stop is visible during active or unconfirmed work and reads “等待停止确认” while confirmation is pending. Resume allows new work; it does not replay an old task.

### Fields and composer

Use native `OutlinedTextField` behavior, visible setup/options labels, and the rounded chat field. In portrait the message field grows from one to four visible lines; landscape follows the compact limits recorded in Layout. A nonempty draft leaves Send actionable unless submission/stop is in flight; attempted sending explains an unpaired, offline, older-companion, stopped, busy-task, or unready-RK blocker in place. Blocked sending does not clear the draft. Successful admission clears submitted text only when it still matches the current draft, preserving new edits.

The plus action opens optional window-title and expected-result fields in the native task-options sheet. Done belongs inside its scroll and inset boundary. Portrait shows each active constraint as a neutral, removable native InputChip with a 48dp target; the window label truncates within its chip and the completion chip states that a condition is set. The plus icon carries a neutral count badge when constraints exist, including landscape where the chip row is hidden. First pairing retains an existing unsent draft and its constraints; selecting or pairing a different computer clears the old draft, window/completion constraints, and reply context. An in-place notice distinguishes recoverable startup waiting from an error.

### Connection strip and navigation

The strip exposes computer/RK condition above the conversation and opens Devices. It uses a small indicator, primary state line, quieter computer name in portrait, and a repair action when needed. `starting_model` produces “正在启动 RK 本地模型”. Paused means a currently online computer has stopped receiving tasks; an offline retained snapshot does not replace the current disconnected state or suppress Reconnect. Landscape places explicit Resume or a labeled native repair icon in the compact header.

Devices identifies the current computer, displays only the endpoint host in its ordinary row, and keeps secondary AI-session/about destinations in the native overflow menu. Selecting a computer makes it the preferred connection for the next launch; ordinary polling, sequence reservation, and pending-receipt updates preserve that stored order rather than choosing another saved computer. Pairing leads with three numbered scanner instructions; manual address input is disclosed through “使用配对地址” or camera denial, while a received invitation uses a compact confirmation view. Invalid input stays editable with its recovery explanation. Native Back returns through Devices to chat.

Ordinary Connection Settings leads with current connection state and repair. Endpoint editing and computer identity are a separate disclosure with identity verification before update. Online paused guidance sends the user back to chat to resume; offline state exposes Reconnect even if a retained snapshot is stopped. Removal is an interrupting, cancellable Material dialog: online unpair revokes phone access, optional local-only removal deletes phone records, and offline removal explicitly leaves revocation to the computer.

### Conversation

The user's goal appears in a right-aligned tonal bubble. Goals and reply body text use native `SelectionContainer`, preserving Android selection and Copy behavior. Coloop replies sit on the main surface beside the incumbent 24dp vector mark. Sender/state and processing-source/time use independent `FlowRow` layouts, with wrapping instead of squeezing the text into a single row. Completed state adds the existing semantic green and a native check-circle icon beside “结果已验证”; that wording remains reserved for completed tasks. Optional running phase remains separate text. Reply updates use a polite accessibility live region.

Each admitted task contributes an independent goal row and reply row. A newly appended task scrolls to its reply; the explicit “最新消息” action returns from earlier history without requiring a new task. Admission, execution, verified result, stopped, and unknown outcome retain different wording. Normal screens show no fabricated devices or sample task data.

### Task journey controls

Recent tasks use a native modal sheet with All/Unfinished filter chips, status/time labels, two-line goal previews and a Back to chat action. Selecting a row closes the sheet and locates that task's reply after lazy items exist. This is the computer's bounded recent snapshot, not persistent local history.

The portrait current-task row exposes Supplement for awaiting-input work and View task for active work. Supplement identifies the original goal beside a native cancel icon, requests composer focus and opens the IME; compact keyboard layout hides this context to retain editing space. Cancel removes the task association while preserving typed text. Sending validates the original goal plus separator and supplement against the existing wire limit. Terminal result replies offer editable reuse for completed, answered, cancelled, failed, interrupted and unconfirmed outcomes. Preparing supplement/reuse clears old task options; a native replacement dialog protects any nonblank draft with Keep draft as the dismiss action. Neither preparation sends a request.

**The Deliberate Next Action Rule.** Locate preserves task identity; supplement names its original goal; reuse prepares editable text. Sending always remains a separate user action.

### Unknown outcomes

Keep the pending command UUID across uncertain transport and reconcile against later snapshots. Recovery does not automatically resubmit tasks. The explicit check-completed action requires a snapshot associated with that pending UUID, online idle control, zero unconfirmed control and inactive Coloop work. Its separate confirmation fetches a fresh encrypted snapshot again before clearing the marker. Refresh failure, changed computer/pending identity, activity or an unresolved receipt keeps reconciliation open. An original task or resolved receipt is reconciled without another send; otherwise only a fresh idle snapshot with no receipt allows local acknowledgement after the user has inspected the computer. This does not rewrite an unknown outcome as success. Pairing links and credentials stay out of logs, normal history, and release captures.

## Do's and Don'ts

### Do:
- **Do** preserve the paired-arc vector mark and graphite/white identity through native light and dark roles.
- **Do** use sp text, native Material focus/pressed states, and at least 48dp action targets.
- **Do** keep connection/startup state readable independently of task execution and completion.
- **Do** preserve drafts when sending is blocked and keep Stop, explicit Resume, and reconciliation reachable.
- **Do** verify phone layouts with system bars, IME, dark theme, and enlarged text using emulator/device captures.

### Don't:
- **Don't** treat a receipt or ready connection as proof that a computer task succeeded.
- **Don't** replay an old task after reconnection, Resume, or an uncertain response.
- **Don't** hide the sheet's final action beneath the keyboard or system navigation area.
- **Don't** promote a phone content-width cap into a tablet-support claim.
- **Don't** overwrite desktop design artifacts or copy their Windows typography into Android.

Not canonized or repaired: the pre-existing root product platform marker still says `web` despite its Android paragraph, and root desktop artifact metadata predates this Android system. Both remain outside the Android-only refinement. Palette, typography, shape, spacing primitives, and existing vector identity are preserved. Synthetic 0.5/0.6 UI evidence stays separate from the earlier 0.4/desktop 0.13 hardware report. The initial 0.6 review findings are corrected in source, pass the five final native correction checks and have a scoped ship verdict for those two fixes; this does not establish whole-surface certification.


