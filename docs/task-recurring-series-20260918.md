# Recurring Activity series editing — 2026-09-18

Built directly on `41c7191bf93e2cc15c97cef83afe338d1ae2702c`. This pass is local only: no publication, deployment, production database writes, or production restart.

## Behavior

Editing a recurring occurrence works normally until Save. Meaningful reusable changes open **Apply changes**, with **This occurrence only** selected by default and **This and future occurrences** available to authorized users. Cancel returns to the same intact draft and writes nothing. Nonrecurring Tasks, no-op edits, and occurrence-only status/date changes do not show the scope dialog. No-op saves avoid Task revisions and Activity entries.

Occurrence-only edits leave the durable series definition and originating Activity Template unchanged. Future-scoped edits update the selected active occurrence, append a durable series definition, and reconcile eligible materialized future occurrences in one transaction. Generation reads that definition through the existing recurrence engine, frontier, and stable action provenance.

Choosing future scope authors the series from the complete reusable definition visible in the edited draft. In particular, opening an older historical occurrence shows its historical structure; applying that edited draft to the future intentionally adopts that structure. The editor does not silently merge unseen fields from a different future occurrence.

Three series created from one template are independent. Their definitions include reusable Task/action configuration, stable action keys, assignments, skills, relative timing, recurrence, expiration, and a snapshot of template assignment/supervision policy. Template edits do not replace an instantiated series definition. Skill proficiency, member permissions, availability/presence, and supervision eligibility continue to resolve from current authoritative data.

Completed, expired, and archived occurrences retain their stored structure, progress, dates, assignments, receipts, and supervision evidence. Editing their reusable definition is explicitly future-only; the UI explains that the selected historical occurrence is preserved. Status, reminders, and documents are not editable through that historical-definition flow. Authorized lifecycle reopening still uses the existing lifecycle rules.

## Progress and future exceptions

Actions reconcile by stable identity. Rename/reorder/Required↔Optional changes retain existing action IDs and completion state. New actions start incomplete. Removed actions in a recurring occurrence are archived as historical action rows rather than deleting their comments, documents, completion receipts, Activity, or supervision mappings. Removed actions do not count toward actionable required progress or recur.

A definition edit never awards points or fabricates successful completion. Previously earned ledger entries remain unchanged. New required actions can affect remaining required progress; later completion uses the existing once-per-occurrence award and recurrence safeguards. Optional actions retain the existing supervised/delegated behavior.

Untouched future occurrences created with a verified materialization baseline update automatically. Future occurrences with progress, manual edits, comments, documents, assignment responses, rewards, or supervision activity are preserved conservatively. The response and toast give the preserved count and reasons. Legacy occurrences without a provable untouched baseline are also preserved rather than guessed to be safe. Later generation still uses the revised series definition.

If the new schedule ends/disables recurrence, already-created future Tasks remain intact and are reported with `schedule_ended`; no later successor is generated. Scheduling-key conflicts and eligibility/permission restrictions likewise produce explicit preserved exceptions. The feature does not silently archive existing work to make an update look complete.

## Scheduling and safety

Activity Templates retain Start Time → Due offset → Due Time. No absolute template dates were reintroduced. Concrete due dates resolve from the nominal start plus calendar-day offset. Weekdays, interval, times, span, expiration, and recurrence mode are reusable. Moving one occurrence's concrete dates without changing its span remains occurrence-specific and does not shift the calendar series, including when another reusable field is edited at the same time.

Fixed recurrence and Repeat from completion remain distinct. Expiration still pauses completion-relative recurrence until authorized reopening and successful completion. Grouped/manual rotation uses durable series configuration while retaining each occurrence's runtime rotation position. The existing latest-surviving-occurrence frontier and unique occurrence keys prevent duplicate successors.

The API requires both the existing Task revision and a series revision for future scope. Permission checks run on the server against both the concrete occurrence and the proposed change to the durable definition. A previously authorized one-off points or unlock exception cannot bypass current series permissions. The selected Task, new definition, future reconciliation, and series change clock share an immediate transaction. Each preserved future exception uses a savepoint; unexpected failures roll back the entire edit. The existing live stream signals other clients; unsaved editors remain drafts, and stale saves fail without overwriting current state.

Activity distinguishes `occurrence_edited` from `series_edited`. Series history records the series revision and updated/preserved counts, rather than logging every internal field reconciliation as a separate edit.

## Migration

Additive migration **10038** introduces versioned definitions and a series revision, adds definition/planned-date/materialization-baseline metadata to existing occurrence provenance, and adds nullable frozen binding snapshots. Existing series IDs and action keys are reused. Initial legacy definitions are captured once from their proven latest surviving frontier; subsequent generation never chooses an arbitrary prior occurrence as its definition.

Migration 10037 and all earlier migration bodies remain unchanged. Encrypted production-shaped rehearsal covers 10036 → 10037 → 10038 and 10037 → 10038, verifies unchanged historical Tasks/templates/comments/receipts/ledger, foreign keys, integrity, and an actual second startup with no replay. No production migration was applied.

## Validation

Evidence directories below are local ignored QA artifacts, not household data. Suites overlap; these counts are not additive unique-test totals.

| Gate | Result | Evidence |
| --- | --- | --- |
| Final complete focused series suite | **60/60 passed** | `.qa/series-edit-20260918/series-final.log`; `npm run test:task-series` |
| HTTP series edits, frozen bindings, anchor/equality checks | 31/31 passed | `.qa/series-edit-20260918/backend-focused-final.log` |
| Generation, both materialization/edit orderings, frontier, relative schedules, rotation, encrypted migration/restart | 55/55 passed | `.qa/series-final-generation-migration.log` |
| Final occurrence-only rotation pointer fix, anchors, generation, races, relative schedules and rotation | 46/46 passed | `.qa/series-rotation-pointer-final.log` |
| Simultaneous completion/edit and future-progress/edit, series CAS, rollback, permissions, rotation, schedule/points/expiry changes, Optional-only PUT | 10/10 passed | `.qa/series-edit-20260918/races-final.log` |
| Final editor and scope helper | 36/36 passed | `.qa/series-edit-20260918/editor-final-browser.log` |
| Preserved Task Details and expanded-card browsers | 29/29 Details + 6/6 cards passed | `.qa/series-edit-20260918/preserved-browser-gate.log` |
| Real full-app desktop/mobile shared-template structural flow and second-client SSE | Passed | `.qa/series-edit-20260918/full-app-browser.log`, `full-app-results.json`; final timezone-safe harness rerun: `browser-final.log` |
| Queue/controller, UI guard, optional inspection cost, append-only migration | 86/86 passed | `.qa/series-edit-20260918/preserved-static.log` |
| Lifecycle/security/live/recurrence/SW regression | 364 passed; 1 existing failure out of 365 | `.qa/series-edit-20260918/backend-regression.log` |

The strengthened real browser scenario uses one shared nine-required-step morning template and three independent child series. Through actual editor controls it adds Gracelynn's required deodorant and Optional earrings, then adds Eleanor's Optional earrings on mobile. Cancel writes nothing and retains the draft; Apply preserves partial progress and another client's live view. Both additions survive two later generations with fresh progress; Frankie and the source template remain independent. It also tests a mobile occurrence-only edit and reports a manually edited future occurrence as a preserved exception. Its synthetic server clock advances through the normal 07:00–08:00 windows rather than rewriting Task dates to bypass start restrictions. Additional API tests cover rename/reorder/removal, retained completed-action evidence, points exactly once, frozen primary assignment, and optional supervised actions with live proficiency.

The exact morning API case uses nine required baseline actions, no initial optional actions, weekday recurrence, 07:00–08:00 and 2 points. Gracelynn retains completed action IDs/receipts while adding required deodorant and Optional earrings; Eleanor adds only Optional earrings. Tuesday and Wednesday materialize independently with fresh progress. Successful completion earns 2 points exactly once per occurrence; Eleanor's missed Tuesday expires once with zero points and no completion receipt, then generates Wednesday. Historical Gracelynn data, Frankie and the template/checklist remain unchanged. Evidence: `.qa/series-edit-20260918/morning-exact.log`, included in the final 60-test gate.

The final editor suite covers keyboard/mobile scope choice, intact Cancel drafts, no-op saves, obvious validation, frozen assignment controls, disabled historical auxiliary controls/file drops, and live invalidation followed by stale-save rejection without replacing the unsaved form. Desktop/mobile scope screenshots were inspected.

The sole broad backend failure is the pre-existing `test-task-subtask-latency-integrity.js:164` assertion expecting an empty ledger after reopening; the durable reward ledger correctly retains the prior earn. It was reproduced against unchanged production source in the base work and remains unchanged here. The separate test-suite registry guard has three existing failures (unrelated missing script registrations), reproduced against an archive of exact base `41c7191` with the same lists. New series scripts/files are registered. Layer-boundary and scope-helper checks passed.

Initial full-app test attempts exposed a test SQL column mistake, modal-animation timing, and the shared loopback-IP rate limiter. The harness was corrected; no production limiter or modal semantics were changed. Those attempts are not counted as passes. No failed browser launch is counted as successful QA.

## Checkbox performance

The existing card optimistic controller, subtask queue and corrected probe are unchanged from the base; UI edits are confined to the editor, permission controls, and history presentation. A SHA-256 manifest verifies that runtime source remained unchanged between the final measurement freeze and commit preparation.

The complete corrected full-app benchmark passed **21/21** native interactions: first/middle/final required, optional, supervised/helper, delegated/helper, and reopening, each in Task Details, expanded List and Kanban. It uses actual routing, CSS, authenticated HTTP, synthetic SQLite, background reconciliation and SSE. Final-parent completion still produces one award and successor. No other test suite ran during these measurements.

| Middle required action | Base second-frame proxy | Candidate second-frame proxy | Candidate native local HTTP acknowledgement |
| --- | ---: | ---: | ---: |
| Task Details | 29.7 ms | 29.8 ms | 102.6 ms |
| Expanded List | 30.6 ms | 29.8 ms | 103.8 ms |
| Kanban | 30.3 ms | 30.4 ms | 108.6 ms |

Animation callbacks are not proof of painted pixels. A separate timestamped JPEG screencast was inspected independently, with status transport deliberately held for 500 ms:

| Surface | Base first inspected checked/progress frame | Candidate last unchecked frame | Candidate first checked/progress frame | Held acknowledgement |
| --- | ---: | ---: | ---: | ---: |
| Expanded List | 26.84 ms | 8.35 ms | **26.71 ms** | 611.2 ms |
| Kanban | 40.04 ms | 23.41 ms | **39.73 ms** | 607.6 ms |

Both captured visible-feedback observations meet the <50 ms target and precede HTTP acknowledgement. Across all native List cases, second-frame observations ranged 29.8–30.7 ms; Kanban ranged 30.4–30.9 ms. Native acknowledgements ranged 100.6–200.8 ms for List and 105.4–208.3 ms for Kanban; the slowest helper cases slightly exceeded 200 ms while local feedback remained immediate. These are controlled samples, not percentiles or physical-display measurements. Household phones, app wrappers, wall hardware and production HTTPS were not benchmarked.

Evidence: `.qa/series-edit-20260918/series-final-native/results.json`, `series-final-visible/results.json`, and the adjacent raster frames. The earlier partial `series-native` run was intentionally stopped to fix occurrence-only manual rotation isolation and is excluded from final results. The complete final runs exited successfully. Existing browser regressions also verify rapid siblings, duplicate suppression, stale rejection, pending feedback through refresh, retained DOM/focus/scroll/expansion, and native touch scrolling versus explicit taps.

The feature is committed locally only. Conservative future exceptions and schedule-ended preservation are intentional rules described above; the known baseline test failures and physical-device timing limits are not reported as passes.
