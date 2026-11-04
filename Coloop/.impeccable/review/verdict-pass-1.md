## verdict

1. **Task sheet — partial.** The code now adds scrolling and navigation/IME padding, but phone-task-options-light.png still shows the lower Done target beneath the system-navigation scrim. phone-task-options-keyboard-font-1.3.png shows the focused first field above the keyboard, with the second field and Done offscreen; it does not demonstrate successful scrolling to and activating Done. The parent's reported Home interception agrees with the remaining visible overlap. The requested usable 48dp completion target is unresolved.
2. **Startup feedback — resolved.** phone-rk-connecting-light.png and phone-send-blocked-light.png now both identify local-model startup; the latter uses readable amber feedback and explicitly says the draft remains in the input. The draft visibly remains, and the offline capture retains red failure feedback.
3. **Persistence — partial.** PRODUCT.md now identifies Coloop as the Android chat name, documents the native client, and explicitly separates simulated UI acceptance from blocked current production-RK verification. The remaining documentation part of this original fix is unfinished: android/DESIGN.md still describes pairing → computer → session → instruction rather than direct chat, and android/.impeccable/design.json is absent. Preserve the root desktop document while completing the planned Android documentation pass.

All 15 original capture paths plus the added keyboard/1.3 task-sheet capture were reopened; they exist, are 720×1600 and show their claimed states. The retained r3 settings/devices captures are disclosed rather than represented as fresh r4 evidence. The r4 verification.json records seven passing primary behavior checks; these do not establish task-sheet completion. No additional regressions identified in this scoring pass.

## remaining

- Fix the actual task-sheet usable bounds, then show the complete Done target above system navigation and prove both optional fields and Done remain reachable with keyboard and font scale 1.3. Recapture the same task-options paths after successful native completion.
- Finish Android-specific DESIGN.md and the promised android/.impeccable/design.json so the persisted sequence matches direct-chat entry and the reviewed native implementation.

disposition: fix
