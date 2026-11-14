# Auto Agent Work

Auto Agent Work supervises an explicitly bound AI agent conversation. The existing DSH runtime owns model reasoning and tool turns; the supervisor owns durable task versions, event gating, acceptance, and exactly one selected write channel per action.

## Using it

1. Configure the normal model in Settings. An optional decision model has its own encrypted key and rates. Without it, Auto Agent Work uses the normal model. A configured decision model failure is reported rather than silently routed to another provider.
2. Use **Test decision model** to exercise an actual DSH text/tool round trip and a randomly generated image. Image support is stored only for the endpoint, model and key that were tested. Until verified, observation uses controls or OCR.
3. In Auto Agent Work, install project hooks for the local Work/Codex workspace. Review the generated definitions in the desktop application's hook review UI. Coloop never writes hook trust hashes and preserves other tools' definitions.
4. Select a discovered session, enter the goal, authorization and required acceptance items, and start supervision. Already-running agents are observed without prompting. New relevant evidence triggers decisions; ordinary page changes do not automatically call a model.
5. Pause stops Coloop supervision. **Stop Agent** is a separate capability. Unbind releases the task association. On restart or human takeover, explicitly resume after checking the original conversation and uncertain actions.
6. After acceptance, feedback is optional. No feedback is not positive feedback. “This task” stays scoped to the task; future feedback is recorded with its original wording and provenance.

## Boundaries and recovery

- ChatGPT local Work/Codex hooks, native Stop continuation, business replies and desktop writing each have their own capability status. Hook receipt alone never certifies complete desktop support. Normal Chat and Work Cloud are outside the first target.
- Native Stop exposes a short, bounded decision-readiness window. It does not wait for a full cloud reasoning run. A ready matching decision may continue the same round; otherwise the round ends normally and a guarded desktop write can follow.
- Actual CLI testing found Stop continuation does not emit a new UserPromptSubmit. Native resumption is confirmed by subsequent same-round model activity and Stop with `stop_hook_active`, not by pretending an HTTP acknowledgement proves delivery.
- Native and desktop routes share an action identifier. Once claimed/submitted, an uncertain result cannot fall back to another write. Explicitly unclaimed native offers alone may fall back.
- Desktop writing requires the bound agent foreground window, matching long native result text, a stable editor, and an empty draft. The existing RK executor performs input with its durable receipts. Window/process and draft checks run again before sending. Coloop messages include their action identifier and are excluded from direct-user preference evidence.
- FlaUI UIA3 5.0.0 provides bounded read-only controls and events. The helper never types, clicks or runs a second model loop. Truncated control trees do not prove conversation identity; required observations can use existing CUA/OCR or verified cloud vision.
- Approvals remain separate from business choices. A normal reply cannot stand in for a native permission approval. Missing authority requires a specific user decision.
- Acceptance is pass/fail only after execution stops. All required items need observed evidence. Minor harmless imperfections can pass; omissions, key errors and missing receipts require targeted follow-up or verification. An unknown input is inspected rather than replayed.
- Memory lookup distinguishes empty from unavailable. Unavailable memory does not block decisions based on current instructions. Private credential records and unrelated memory are excluded from the cloud projection. Inferred preferences remain advisory.

## Implementation

`auto-agent-work.ts` stores versioned task/event/decision/action/acceptance/feedback state atomically. Only one evaluation per task runs at a time. `chatgpt-desktop-adapter.ts` is authenticated loopback ingress and native readiness/receipt handling; its packaged Node hook reads stdin and forwards bounded events. `auto-agent-opencode.ts` projects the existing v1 source without changing its protocol.

`auto-agent-planner.ts` creates a route-bound DSH session and exposes only bound event reading, necessary observations, read-only workspace file verification and structured decision submission. File verification excludes credential/key paths. `decision-model.ts` adapts OpenAI, Anthropic and Gemini transports while the DSH SDK retains the reasoning loop. The parent task ledger records actual model usage and configured prices; request limits apply only when the user enabled the budget.

Runtime resources include the hook script, bundled standard Node and the fixed FlaUI helper/dependencies. afterPack validates runtime hashes and production/peer dependencies. Configurable caches, probes and build artifacts stay inside `D:\Coloop`; persistent keys, memories, task state and fee ledgers are not disposable caches.

## Open-source reuse

[FlaUI UIA3 5.0.0](https://github.com/FlaUI/FlaUI/releases/tag/v5.0.0) is integrated for Windows UI Automation controls and events. `resources/auto-agent-work-hook.mjs` adapts the bounded stdin drain and single-line JSON stdout handling from oh-my-codex commit `509a299d586b48f145c2c7a7baac8ce08d01a015` ([stdin wrapper](https://github.com/Yeachan-Heo/oh-my-codex/blob/509a299d586b48f145c2c7a7baac8ce08d01a015/plugins/oh-my-codex/hooks/codex-native-hook.mjs), [native JSON output](https://github.com/Yeachan-Heo/oh-my-codex/blob/509a299d586b48f145c2c7a7baac8ce08d01a015/src/scripts/codex-native-hook.ts)); its full MIT notice remains in the packaged resource. Native Stop continuation follows the [official hooks protocol](https://learn.chatgpt.com/docs/hooks): a synchronous `decision: "block"` with `reason` can continue the active turn; an asynchronous hook cannot wake an idle agent.

[Happy at `665b1f14`](https://github.com/slopus/happy/blob/665b1f14f3b35d89dead49b7c5c97b58df42f48d/packages/happy-cli/src/codex/codexAppServerClient.ts) and [HAPI at `2741217b`](https://github.com/tiann/hapi/blob/2741217b8986aef1b26a10962cfcec9a0a375b5c/docs/guide/codex-shared-sessions.md) were evaluated at source level only and are not integrated. Their separately spawned app-server connections and native thread resumption do not establish attachment to an already-running desktop process.

## Verification records

Protocol/unit tests cover duplicate and stale events, round ownership, takeover, native/desktop races, unknown receipts, restart, acceptance, feedback and model configuration. `tests/auto-agent-work-native-cli.mjs` exercises real local CLI hooks; it is explicitly not desktop end-to-end acceptance.

`tests/auto-agent-cloud-smoke.mjs` uses the configured cloud model with synthetic evidence and the real DSH runtime. It preserves production settings and appends real charges to the existing fee ledger. The image capability test never supplies the random image answer in text.

`tests/proactive-package-smoke.mjs` exercises actual packaged hook resources and IPC using an isolated project and profile. Its report labels these checks `protocol_smoke`; this cannot substitute for real desktop conversation acceptance. `tests/runtime-package-smoke.mjs` verifies that runtime dependencies resolve inside the actual package and includes the FlaUI probe.

See the current `.qa/auto-agent-work` delivery report for measured support, costs, Git identity, installed hashes and cleanup. No unmeasured desktop success rate or latency is promised.
