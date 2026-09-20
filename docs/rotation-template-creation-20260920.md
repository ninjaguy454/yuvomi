# Rotation in initial template-based Task creation

Local candidate built on `ee26d1ce8dbca93b68f21a3d7df40d5658e33e54`, branch `feature/rotation-groups-20260919`. Starting tree was clean. The deployed image revision matched that base. No production records, configuration, images, or migrations were changed during this pass.

## Reproduced cause

The full application reproduced the reported HTTP 500 on the exact base source: select a real multi-action bedtime template with `{{assignee.display_name}}` in its generated title, select Eleanor, add a shared Rotation purpose, and Create. The submitted title was already correctly resolved to Eleanor. A later Rotation-rendering pass tried to evaluate the original template again without the contextual Assignee value, raising `missing_input` inside `initializeTaskRotationRendering`.

Unsaved child IDs were not the cause of that exception. The existing POST transaction already inserts the parent and materializes its actions before binding Rotation. Template-derived draft rows already carry checklist-item provenance.

A second defect was independently reproduced: adding a new Rotation expression to a plain template-derived action saved the literal token. Rendering initialization inspected only the source template's authored expressions, ignoring the expression authored in the concrete Task draft.

## Changes

- Reuse the existing contextual Assignee rules in the Rotation renderer, including the resolved action performer. Configured defaults, expressions, and explicit input fields keep their existing meanings.
- Capture authored parent title/description and child title expressions against their actual newly inserted Task IDs inside the existing creation transaction. Freeze generated-field provenance using the canonical stable recurrence action keys. No title matching, sibling indexes, or client-supplied durable action IDs select the target.
- Preserve the independent source Activity Template. The series snapshot carries the generated-text plan; subsequent occurrences use that definition. Manual text edits retain the existing detachment rules.
- Pass the creating actor through typed-variable resolution so a draft expression cannot expose an inaccessible private Rotation Occurrence.
- Invalid authored expressions return a specific 400 validation error. Induced persistence errors roll back the entire creation, including children, Rotation state, events, and provenance.
- Reuse the existing `@` picker for Rotation-purpose values in initial template-derived Task title, description, and subtask fields. Picker styles load on a fresh Tasks screen; menu IDs are unique across nested editors. This pass does not introduce a general expression editor for existing concrete Tasks or blank Tasks.
- Replace the contradictory save/reopen instruction. A confirmed validation rejection leaves the draft editable. A genuinely unknown response retains the existing idempotent retry identity and explains how to retry the same request safely.

## Focused UX refinements

Shared bindings show one concise Group summary and a Manage action. The Group's inherited method/advancement controls are hidden rather than displayed as disabled duplicates. Timing/text and availability options are in expandable sections; toggles have visible tracks. Group copy uses understandable turns/evenings terminology.

Member rows have a direct Remove button instead of an Actions submenu. Handle-only dragging, touch scrolling, and Alt+Up/Down keyboard reordering remain available.

Round Robin still selects **one member**. Rotating Order provides **everyone's position** and rotates the first person. The editor explains that distinction; no saved configuration or rotation algorithm was changed. Use Rotating Order for the requested three-child 1st/2nd/3rd shower sequence.

## Validation and evidence

Counts below are separate runs, not an additive total.

| Check | Result |
| --- | --- |
| Exact-base backend reproductions | Both defects fail as expected: contextual Assignee produces 500; draft expression stays literal |
| Exact-base full-app browser | Reported 500 and contradictory fallback reproduced after normal authentication, template selection, and draft submission |
| New backend regressions | 8/8 passed |
| New + affected backend gate | 40/42 passed; the same two preexisting assignment-edit failures reproduced against unchanged base |
| Rotation UI browser suite | 30/30 passed: desktop/mobile, light/dark, member removal, handle/keyboard/touch interactions, permissions, history, and live draft preservation |
| Actual-backend browser acceptance | 2/2 passed: new creation flow plus existing shared-owner/Workflow operations flow |
| Draft/scope/service-worker contracts | 21/21 passed |
| Focused existing draft editor browser checks | Initial run 11/13 passed. Nested Skill creation selector failure and first-test mounting failure reproduced on base; a later narrower run passed 8/9 with the first-test mount failure before interaction |
| Read-only patch review | Passed: atomicity, stable targeting, actor-aware resource access, template independence, and manual provenance reviewed |
| Migration/schema | No migration required; schema and migration source unchanged |

The new backend cases verify reordered template siblings, the exact persisted action, Optional state, recurrence with fresh progress, once-only points, source-template independence, title/description refresh after override, explicit child assignee, manual-text preservation, unchanged Round Robin semantics, invalid-expression rollback, induced post-materialization failure rollback, and inaccessible typed-resource denial with rollback.

The new full-app browser flow first submits an invalid expression, verifies 400 and zero Tasks, preserves the editable draft, then inserts the correct value through the actual `@` menu using the automatically generated purpose key. Create returns 201; only Take shower renders Eleanor's position. The template, sibling titles, Optional state, assignment, and recurring schedule remain intact. The picker and controls fit a 390px viewport. The existing shared-owner test also verifies second-client convergence, override, next recurrence, consumer independence, and Workflow operation authoring through the revised disclosure.

Evidence retained locally:

- `.qa/rotation-create-backend-before.log`
- `.qa/rotation-create-backend-final.log`
- `.qa/rotation-create-assignee-baseline.log`
- `.qa/rotation-ux-20260920.log`
- `.qa/rotation-task-create-20260920/` (baseline/candidate API payloads, browser logs, screenshots, contract and baseline-comparison logs)

The two baseline backend failures are the existing `test-task-assignee-context.js` PUT cases for allowed assignment override and changed subject. They are not initial creation failures and were left outside this fix. An attempted checkout-based full-app launch failed before UI because Express would not serve through the hidden `.codex` path; the successful actual-backend runs used the isolated non-dot QA runtime. No failed launch was counted as a pass. Physical phone/Fully Kiosk testing and a new checkbox timing benchmark were not performed. The optimistic checkbox implementation was unchanged.

Verdict: **READY WITH KNOWN LIMITATIONS** for this focused local fix. Commit locally; do not publish or deploy without new release authorization.
