disposition: fix

## persistence

Pass for the scoped review inputs. PRODUCT.md, the pinned direction contract, Android DESIGN.md, native source, four verification reports, and all 33 required emulator captures exist. All captures have the claimed content and valid dimensions: 30 at 720×1600 and three at 1600×720; no malformed or missing capture requires recapture. Diagnostic contact sheets were used for coverage, with critical text, control, keyboard, and layout judgments made from the PNGs. Android DESIGN.md is the documented 0.4 baseline; its scheduled 0.5 reconciliation follows this correction round and is not a missing-input failure. Root desktop DESIGN.md remains outside scope. No comp round, seed roll, measured comp spec, Quality Bar card, or HTML/CSS detector verdict applies to this user-pinned native refinement. No implementation was edited during review.

## fidelity

| Element or promise | State | Evidence |
| --- | --- | --- |
| THESIS: goal submission is primary | match | Ready/unpaired chat opens directly; connection repair and draft retention remain adjacent to the conversation. |
| OWN-WORLD / TYPE | match | Native Material system sans roles, readable Chinese body copy, separate status/source/time hierarchy, and font1.3 reflow preserve the incumbent Android system. The Android platform reference expressly governs system typography here. |
| OWN-WORLD / MATERIAL | match | Flat Material surfaces, native fields, sheets, dialogs and icons, with the incumbent paired-arc vector; no invented physical material or decorative raster substitute. |
| OWN-WORLD / GROUND | match | Paper white and graphite are retained in light mode; the independently defined dark neutral scheme and restrained green/amber/error roles remain within the pinned world and incumbent Android DESIGN tokens. |
| STORY: chat, readiness, reply, execution and Stop | match | Greeting, running, verified result, stopped, connecting, blocked-send and offline captures keep distinct wording; Stop remains visible in portrait and as an inline native control above landscape IME. |
| FIRST VIEWPORT: conversation receives the available space | contradicted | In phone-landscape.png, the non-IME app bar, connection strip, error and disabled Resume row leave roughly 30px of actual message content visible. Latest message is cut off by the footer. |
| FORM: admission/reply and in-place recovery without draft loss | match | User bubble/reply topology is retained; long-draft, first-pair and new-computer evidence is consistent with the reported retention/reset behavior. No new visual world was requested. |
| Reading and return to latest | adaptation | Native SelectionContainer and Android Copy toolbar implement the scoped selectable-reply requirement. Portrait Latest message is visible and exercised; its landscape presentation fails as recorded above. |
| Optional task constraints | adaptation | Native sheet, removable chips and neutral count implement the explicit 0.5 scope. Keyboard/font1.3 completion remains reachable; landscape uses the count and sheet to conserve width/height. |
| Devices and guided pairing | match | One device list, native overflow for secondary destinations, three informative pairing steps, scanner primary action and disclosed manual field. Invalid input retains its field and recovery instruction. |
| Ordinary settings repair; paused versus disconnected | contradicted | phone-settings-dark-font-1.3.png and phone-connection-settings-light.png show an offline computer but omit Reconnect because a retained stopped snapshot selects the paused branch. MainActivity.kt:417 tests snapshot.stopped without requiring the online link. |
| Address/identity and removal | match | Address and host identity are disclosed separately; online unpair and offline local removal have explicit consequences and a Cancel action. |
| Truth and scope | match | The capture packet and reports explicitly identify synthetic RK/HID data. The current pass does not claim new hardware execution, broader task capability, tablet support, or a desktop/backend release. No new shipping raster needs provenance. |

## ceiling

Native Material commitment is maintained; no ornament, display font, or extra depth is warranted for this Operate surface. Finish is below the native ceiling in two functional layout/state details: landscape needs a usable message viewport and fully visible navigation action; offline settings need an immediately available connection-repair action. Relevant connection error text in settings is not independently a material defect, although its draft-retention clause is chat-specific. No craft-floor ban was observed.

## material_fixes

1. FIRST VIEWPORT / native layout: Reallocate non-IME landscape height so history remains readable and the full 48dp Latest message action stays within visible bounds; condense the app bar/status/footer and avoid spending a full disabled Resume row on an offline computer. Verify the existing phone-landscape.png scenario with the retained draft, constraints, stopped snapshot and connection error, plus the existing landscape IME/Stop paths for regressions.
2. STORY / connection repair: In ordinary ConnectionSettings, let current link state govern repair availability; an offline computer with a retained stopped snapshot must still expose Reconnect, while paused guidance can remain secondary or explicitly last-known. Verify and recapture both existing light and dark/font1.3 settings paths, including Cancel on removal, and keep the online paused state distinct.

## keep

Keep direct Coloop chat, the graphite/white double-arc identity, native Material controls, selectable readable replies, truthful verified/stopped wording, visible task constraints, draft preservation and explicit Stop/Resume semantics.
