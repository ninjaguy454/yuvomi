# Generated helper scheduling verification — 2026-09-18

This bounded follow-up starts at local commit `6f51f93f015e5570ce47001f63d16addfd52d628`. Production was inspected read-only; no production Task, configuration, image, or schema was changed. Nothing was pushed or deployed.

## Production structure

At the read-only inspection, learner Task 72, generated supervisor Task 102, and counterparts 103–107 all had Start/Due Date `2026-09-12` (Saturday), with no explicit times. Task 72 and support 102 were In Progress. Counterparts 103–105 were In Progress; 106–107 were Open.

The source-to-counterpart mappings were 75→103, 76→104, 77→105, 78→106, and 80→107. Ordinary source actions 73–80 shared the learner window. The learner used `FREQ=WEEKLY;BYDAY=SA` and an `available_before_due` planning policy evaluated over the completion window.

There was no existing source/helper date mismatch in these records. This investigation did not move the real household occurrence to Friday. Mutation tests used isolated synthetic fixtures reproducing the legacy copied-date structure and both supervised and delegated actions.

Production remained at source `00f208309c6f1463f47d5d600bb5a70965fbbd6d`, schema 10038. The preceding local editor compatibility fix is also still undeployed.

## Findings and smallest fix

The normal active path already worked: occurrence edits propagated inherited source-action dates, then reconciled supervision against the revised window. Series propagation and subsequent generation used the same reconciler. Availability/Presence changes selected one eligible replacement, or left supervision unresolved with no active helper assignment when no replacement was available.

Two scheduling defects were confirmed:

1. Generic child-date propagation included generated support Tasks. The reconciler also copied dates before considering the helper's final lifecycle state. Consequently, schedule edits could overwrite completed support-container windows or expired/archived counterpart windows.
2. Eligibility used each source action's effective window, but counterpart display dates always copied the root Task window. An action with independent times could therefore display a different helper window from the one used for eligibility.

Generated projections are now excluded from generic child-date propagation. The existing supervision reconciler synchronizes their windows after its existing status/archive reconciliation, updating only active, unarchived projections. Support containers follow the learner window; counterparts follow their own source action's effective window. Completed, expired and archived projections retain their historical windows. Authorized reopening makes eligible projections current again in the same pass.

The effective action windows are reused privately from the current eligibility inspection. This adds no eligibility lookups, cross-request authorization cache, editable fields, schema changes, or second supervision engine. Existing assignment, recurrence, points, progress and projection-ownership rules remain in place.

## Verified scope behavior

| Save scope | Current eligible helper work | Subsequent generation |
| --- | --- | --- |
| This occurrence only | Follows the selected learner/action window; current eligibility is rechecked | Uses the unchanged durable series definition |
| This and future occurrences | Follows the selected learner/action window; current eligibility is rechecked | Uses the revised durable series definition and generates matching fresh helper work |

The tests moved a partially progressed Saturday occurrence to Friday. They preserved an In Progress supervised action and counterpart, completed independent progress, comments, documents, mappings, completion receipts, and reward ledger entries. The source Activity Template remained unchanged. Completing the remaining work generated a fresh Saturday successor for occurrence-only scope, and a fresh Friday successor for future scope, with matching helper dates.

Further tests verified Availability replacement, Presence replacement, unresolved supervision when no eligible replacement exists, retained completed/expired/archived helper evidence, completed support containers, reopening, and independent action times. Helpers remain generated projections and do not enter editable source-subtask payloads or recurrence-action definitions.

## Validation

The final 18 new regressions were run against an isolated archive of exact starting commit `6f51f93f`: 10 passed and 8 failed. The failures were the expired counterpart, archived counterpart, completed support-container window, and independent action-window defects, each under both scopes. All 18 pass on the candidate.

| Gate | Result |
| --- | --- |
| Complete series-edit suite, including the 18 new regressions | 47/47 passed |
| Affected supervision, delegation, refresh, query-cost, request-cache, Optional lifecycle, generation and race suites | 136/136 passed |
| Existing desktop/mobile editor browser suite, real headless Edge launch | 38/38 passed |
| Focused draft/template relative-scheduling unit tests | 16/16 passed |
| Source syntax and whitespace checks | Passed |

The 237 aggregate checks above have no failures or skips; the separate 18-test red/green run is not counted twice. Browser coverage includes both scope choices, Cancel preserving the draft, stale revisions, permissions, and generated-helper exclusion from the editable checklist. No failed browser launch was counted as a pass.

Local detailed evidence is under `.qa/helper-schedule-20260918/`: `production-structure.json`, `regressions-final-fixtures-baseline.log`, `regressions-candidate.log`, `series-edits-candidate.log`, `supervision-gate.log`, `editor-browser.log`, `editor-unit.log`, and `editor-screenshots/`. An earlier baseline log predates fixture corrections; the final-fixtures baseline log is the definitive comparison.

## Boundaries

No migration is required. Migrations 10037/10038 and frontend code are unchanged from the starting commit. This pass did not repeat the full performance benchmark or mutate production for acceptance. The browser editor tests use synthetic API fixtures; actual supervision/series mutations and generation were exercised by isolated backend integration tests. Physical-device behavior and production mutation acceptance were not newly measured.
