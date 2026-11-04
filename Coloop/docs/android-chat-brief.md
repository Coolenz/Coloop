# Coloop Android chat redesign

Mode: Operate. User-selected structure: open directly into Coloop chat, with connection state above the conversation. Product name is Coloop throughout. Retain the existing double-arc mark and graphite/white brand.

## Direction contract

THESIS: Sending a goal is the main action. The previous nested computer/session/task pages and unexplained disabled sender are replaced by a direct conversation and actionable connection states.

OWN-WORLD: Paper white #FFFFFF, canvas #F6F7F8, graphite #202124, supporting ink #60646C. Green is connection success, amber a recoverable wait, red a failure. Native Material controls and system sans typography, 16sp message body, 24sp app title; 48dp minimum touch targets.

STORY: Open chat, see whether the computer and RK are ready, write a goal, follow an actual reply or execution result, stop when needed. Pairing and advanced session controls remain accessible through Devices.

FIRST VIEWPORT: Compact Coloop app bar; one connection strip; spacious conversation area with a restrained empty prompt; bottom composer with a single 48dp Send icon and an optional Stop row. No large repeated product explanation above every task.

FORM: Chat-first structure explicitly selected by the user; original black/white identity pinned. Code-led native implementation. seed: none (user-pinned structure). Signature interaction: task admission becomes a user bubble plus Coloop reply; connection repair remains in place without clearing the draft. Use native short content-size/state transitions and respect system animation preferences.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Verification

Actual Android Emulator: paired ready, RK reconnecting, old companion, offline, empty, long draft with keyboard, receiving/executing, stopped, light/dark and font scale 1.3. Real production companion startup/reconnection and a real RK task are verified separately from simulated UI state coverage. No shipping raster is added; existing vector mark is preserved.

## 0.5.0 refinement scope

Preserve the selected direct chat and graphite/white native system. Refine readable wrapping of message status/metadata, selectable replies, return-to-latest navigation, visible optional task constraints, and truthful paused versus disconnected state. Simplify device navigation, provide scannable pairing steps with manual address disclosure, and make ordinary connection repair primary while keeping address/identity and destructive removal behind explicit choices. Keep existing RPC/stop semantics and pair identity; discard window/completion constraints when switching computers. Verify portrait and landscape with IME, dark/font1.3, pairing/manual error, settings/cancel removal, optional-field completion, and existing encrypted message/stop flow. This is a polish pass, not a new visual world.

## 0.6.0 task journey completion

User feedback: the 0.5.1 UX remained incomplete. Preserve the pinned chat-first native visual world; complete task transitions instead of adding decoration. Recent tasks (up to 20 supplied by the computer) must filter unfinished outcomes and locate the original conversation. A current-task row must expose the immediate action, especially supplement. Supplement mode names the original task, opens the composer and can be cancelled; combined original/additional length must be validated. Terminal outcomes offer editable reuse, never automatic replay; replacing a nonempty draft requires a reversible confirmation. Admission uncertainty can only be cleared after explicit checking and a current idle snapshot, including Coloop activity. Connection blockers expose an appropriate in-place action and preserve the draft. Native test paths include new message, supplement, failure, reuse/draft protection, history/selection, offline recovery, dark/font1.3 and landscape. Model/HID fixtures are explicitly synthetic. This version does not promise durable local history, background submission or process-death draft recovery. Finish with fresh native review and scoped Android documentation.
