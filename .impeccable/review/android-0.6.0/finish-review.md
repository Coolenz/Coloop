disposition: fix

No approved comp, concept seed, or QUALITY BAR card applies to this user-pinned native extension. No HTML/CSS detector ran. Reviewed the five target source files, supplied contract/product/design/platform/floor files, both acceptance reports, all three JVM result XML summaries, and all 15 required device PNGs. Test implementation was not inspected (the attempted conventional ColoopTest.kt path was absent); no new test run or hardware run was performed.

## persistence

Pass. PRODUCT.md exists and records the 0.6.0 task-journey scope and limits. The existing android/DESIGN.md describes the shipped graphite/white Material world and remains the correct scoped design authority; its verification narrative still describes the earlier releases and needs the normal post-review 0.6 documentation update. Desktop design metadata and the pre-existing product platform marker are outside this review. This is a code-led extension, so comp-round state and approval artifacts do not apply.

Evidence passes check 0: every PNG listed by capture-index.json exists and was opened independently. Fourteen captures are coherent 720×1600 portrait phone viewports and history-landscape.png is a coherent 1600×720 landscape viewport. System bars, sheets, content, and IME match their claimed states; none is blank, corrupted, or a wrong destination. Scrollable conversation content ending at the composer is not a missing viewport. Earlier failure fixture PNGs were excluded as instructed. verification.json reports eight passed native journey checks; first-run-verification.json reports three passed first-run/synthetic execution checks. XML summaries total 19 JVM tests with zero failures, errors, or skips. These reports do not exercise the two negative cases below.

## fidelity

| Element / promise | State | Evidence |
| --- | --- | --- |
| TYPE | match | Native Material system sans, body hierarchy, independent sender/status and metadata wrapping. Native Android guidance and the user-pinned OWN-WORLD authorize system typography. |
| MATERIAL | match | Flat tonal message surfaces, native sheet/dialog depth, native vector double-arc mark; no imitation physical material or new raster obligations. |
| GROUND | match | White/light neutral conversation, graphite actions, independently themed charcoal dark sheet; consistent with OWN-WORLD and the extracted Android theme roles. |
| THESIS: goal submission and direct conversation | match | first-run, reply-next-action, active-task-banner, execution-progress and completed-followup preserve the direct chat task journey. |
| OWN-WORLD: native Android identity | match | Restrained semantic colors, Material buttons/fields/chips/sheets, preserved double-arc geometry; no change of visual world. |
| STORY: pairing → admission → clarification → execution → result | match | Pairing guide, retained first draft report, supplement context/IME, explicit send report, execution/progress/result captures; status distinguishes answered from verified completion. |
| STORY: actionable unfinished task history | contradicted | TaskHistorySheet.kt filters only failed/interrupted/unconfirmed/cancelled. awaiting_input is absent although its task still needs the user's action. history-light.png shows multiple “需要补充” records; history-failed-filter.png removes all of them from the tab named “未完成”. |
| STORY: deliberate reuse and draft protection | match | Terminal reuse prepares editable text, clears old options and never submits; replacement dialog supports Keep. Captures and source agree. |
| STORY: uncertain admission requires current idle verification | contradicted | canResolvePending accepts any cached online idle snapshot. submitColoop retains that snapshot while busy, and uncertain failure leaves link ONLINE and pendingId set. acknowledgeUnknown performs no snapshot request or post-submission freshness check, so a pre-send idle snapshot can authorize clearing an unresolved receipt immediately after the failure. The dialog checks user intent but cannot make the cached snapshot current. |
| FIRST VIEWPORT | match | Compact identity/app bar, connection state above conversation, focused empty prompt and bottom sender; active task row uses a direct next action rather than another explanatory card. Memory test retains Coloop, connection readiness and the goal composer. |
| FORM: native compact adaptation | adaptation | The user-pinned native extension and Android IME/inset requirements justify hiding nonessential app bar/context rows in landscape with the keyboard. Back dismisses the keyboard to recover full context; portrait supplement names its original task and exposes cancellation. No concept roll is owed for this pinned extension. |
| In-place connection recovery and draft retention | match | Offline capture provides retry beside the preserved draft; unpaired first-run report demonstrates the pairing return path; source preserves blocked drafts. |
| Truth | match | Fixture reports explicitly identify synthetic model/HID; captures identify the QA computer and synthetic limitation text. This review grants no new RK/HID, cloud, cross-application, QQ Mail, tablet, durable archive, process-death draft or background submission claim. No shipping raster was introduced. |

## ceiling

Reached for the pinned native visual direction: typography, tonal layers, safe system/IME boundaries, native interaction surfaces and light/dark enlarged-text history are coherent. More ornament, dimensional material or authored display lettering would contradict the requested native world. The remaining ceiling is task-state continuity: unfinished work must remain findable, and ending admission uncertainty must require evidence newer than the uncertain submission. No craft-floor ban is present in the required captures; numbered pairing steps carry real sequence and status labels carry operational state.

## material_fixes

1. [P1; contract 0.6 admission uncertainty] In ColoopModels.kt:65 and RemoteViewModel.kt:232, require a successfully obtained idle snapshot after the pending submission/uncertainty before clearing pendingId; preferably refresh and recheck in acknowledgeUnknown itself, keeping the pending receipt on refresh failure, host change, active control, unconfirmed control or active Coloop work. Verify the cached-online-idle → uncertain send → immediate confirmation negative path, plus failed refresh and newly active snapshot; no duplicate submission or clearing may occur.
2. [P2; contract 0.6 unfinished task discovery] In TaskHistorySheet.kt, make “未完成” include tasks awaiting user supplement (and nonterminal received/understanding/running work), while excluding completed/answered; preserve failed/interrupted/unconfirmed/cancelled discovery. Verify mixed history and select an awaiting-input record from this filter through locating its reply and starting supplement. If the intended tab is exclusively terminal unsuccessful outcomes, change its label and explicitly provide equally direct discovery of pending user-action tasks; do not ship the current misleading filter.

## keep

Keep direct Coloop chat, the top connection strip, graphite/white native Material identity and double-arc mark, explicit Send/Stop, editable reuse with draft protection, visible supplement origin, in-place recovery, and the strict separation between synthetic acceptance and real hardware evidence.
