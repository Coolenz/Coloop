disposition: fix

Scope: code-led, user-pinned Android phone surface; no approved/decision comp or QUALITY BAR card supplied by design; no detector ran. Hardware motion/performance and current production RK execution are outside this emulator UI verdict.

## persistence

Fail. PRODUCT.md exists but line 15 still explicitly declares Violoop the user-facing entry name, contradicting the user's correction to Coloop; its platform section describes only the desktop. Preserve the root desktop DESIGN.md. The Android documenter must finish android/DESIGN.md and android/.impeccable/design.json after the fixes and verdict; their planned post-review creation is not a missing-input defect. Comp-round state and approval files are inapplicable to this code-led build. FORM's seed:none is an authorized pinned-structure exception: the parent supplied reference/new-work.md section 3's instruction, “Never run the script for a local extension or a precisely specified narrow request; shape those directly.”

## fidelity

All 15 required PNGs exist, are 720×1600, and visibly show their named emulator states. System bars and the keyboard account for the legitimate non-content regions. No malformed evidence or missing phone capture forces recapture. No tablet coverage or support verdict is claimed.

| Element / promise | State | Evidence |
| --- | --- | --- |
| THESIS: direct goal conversation and actionable sender | match | Ready, chat, blocked-send, running and completed captures show one conversation and a persistent composer. A nonempty blocked draft retains an actionable sender; the test packet records that it submits nothing. |
| OWN-WORLD / TYPE | match | Native Material/system sans roles, readable Chinese text and distinct label/body/title hierarchy; 1.3 font captures reflow. Platform typography is appropriate to the pinned native world. |
| OWN-WORLD / MATERIAL | match | Flat Material surfaces, native icons and preserved geometric double-arc mark. No faux physical material or raster obligations. |
| OWN-WORLD / GROUND | adaptation | Paper-white light conversation and graphite dark conversation preserve the pinned brand. Material surface roles and a separate dark scheme are justified by the supplied Android reference and required system dark-theme support. |
| OWN-WORLD: recoverable wait versus failure | contradicted | phone-send-blocked-light.png combines “正在自动连接 RK” with a red error stating “RK 已连接，正在启动本地模型.” The promised amber recoverable wait is absent; the two visible descriptions also disagree about the connection phase. |
| STORY: progress, result, stop and explicit resume | match | Running shows an accessible Stop row; completed shows the observed-result response; stopped at 1.3 font shows explicit Resume. Synthetic QA and seven passing behavior checks are documented separately from real RK execution. |
| STORY: task-options completion and Android safe area | contradicted | phone-task-options-light.png shows the lower part of the filled Done button beneath the bottom system-navigation scrim. ColoopChat.kt:124 uses a non-scrolling sheet Column, leaving no visible recovery when its contents exceed available height. |
| FIRST VIEWPORT | match | Compact Coloop header, single connection strip, spacious conversation, one Send icon and restrained empty prompt. The memory test returns “Coloop chat, connection above, goal below.” |
| FORM: repair in place without losing draft | match | Blocked, old-companion, keyboard and offline captures retain the draft. RemoteViewModel validates before admission and preserves drafts when blocked; the supplied test packet records repair without submitting the retained draft. Native content-size transitions use Compose. Static captures do not prove hardware motion performance. |
| Product name / persisted truth | contradicted | Visible Android naming is Coloop, but PRODUCT.md still defines Violoop as the user-facing name. Legacy protocol identifiers need not be renamed to correct the product document. |

## ceiling

Native Material framing, tonal surfaces, focused composer, system type and restrained identity are committed at the appropriate phone scale. Decorative lettering, extra ornament and invented depth are not unused obligations in this pinned Operate world. The task sheet's unsafe lower edge and startup state's conflicting semantics remain the finish ceiling. No independent QUALITY BAR card was supplied, so no card-specific ceiling claim is made. The native floor shows no banned eyebrow, glyph-icon substitution, decorative gradient, hard shadow or imitation material.

## material_fixes

1. STORY / Android insets — In ColoopChat.kt:124, make the task-options sheet content scroll within the available height and respect bottom navigation/IME insets; the whole 48dp Done target and both fields must remain reachable. Recapture phone-task-options-light.png and verify the sheet with keyboard and 1.3 font.
2. OWN-WORLD / truthful state — Distinguish RK transport connection from local-model startup in ConnectionStrip/connectionTitle, and render expected startup/wait feedback with the contract's readable amber semantic role rather than errorContainer. The strip and blocked-send message must describe the same phase, state that the draft is retained, and reserve red for an actual failure. Recapture phone-rk-connecting-light.png and phone-send-blocked-light.png; retain the existing offline error behavior.
3. Persistence / product truth — Reconcile PRODUCT.md with the latest explicit user correction: Coloop is the user-facing Android chat name; document Android alongside desktop and keep current production-RK verification separate from synthetic UI-state coverage. Complete the Android-specific design documentation after the verdict without replacing root desktop DESIGN.md.

## keep

Keep direct chat entry, the single top connection strip, graphite/white double-arc identity, native controls, actionable nonempty sender, draft preservation, and reachable Stop with explicit Resume.
