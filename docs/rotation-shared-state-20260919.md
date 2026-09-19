# Group-managed shared Rotation

This local feature builds on `1e87e9b69c18cf9b235d5dde532cb9d1006a0cdd` on `feature/rotation-groups-20260919`. It extends the existing Group → Track → Occurrence model. It does not convert household routines automatically, publish, or deploy anything.

## Configuration and ownership

Household Automation → Rotation Groups now offers **Independent per activity** (the unchanged default) and **Shared across activities**. Shared mode owns one canonical Track; there is no second cursor on the Group. Activities, Workflow runs, and canonical Group-backed Meal roles deliberately selecting that Group reuse its result. They cannot configure a competing consumer-owned Track for that scheduled binding.

The Group editor exposes the rotation method, initial member, effective date, weekdays, activation time, cutoff time and same-day/next-day cutoff, plus whether an explicitly skipped evening advances. All cutoff choices are visible and editable. Windows may cross midnight but cannot exceed one calendar day. Fixed Order never rotates. Consumer controls show the inherited method/schedule and a Manage rotation action; editing the Group affects all consumers, as explained before saving.

Schedule versions retain their configured household timezone. DST uses the existing gap-forward / overlap-earlier conversion. Changing the household timezone does not silently rewrite an existing version; review and save a new Group schedule boundary to change its timezone.

## Period identity and lifecycle

The durable key is the shared schedule and nominal household-local date, not a child, Task, viewer, creation order, title, or Workflow run. The canonical Occurrence key includes the schedule identity and that date. A Task uses its scheduled Start Date (Due Date only if Start Date is absent). For overnight schedules, a start before the next-day cutoff maps to the preceding evening. The binding also offers an explicit scheduled-date / previous-evening choice.

Three separate recurring series can therefore display `Take shower · 1st`, `2nd`, and `3rd` while retaining separate assignments, checklists, points, deadlines, progress and recurrence. Different school-night/weekend times do not create different periods. Their individual completion, expiration, absence, or materialization never settles the shared Track.

A background reconciler activates due periods and finalizes them at the configured cutoff. Explicit consumer mutations can activate the currently open period, but cannot jump unprocessed earlier periods or finalize anything. Recovery processes dates chronologically, with at most 100 new periods per normal pass and transactional, idempotent per-period work. Recovered periods record scheduling outcomes, not evidence that anybody showered. Reads, previews and expressions perform no mutations.

Future Tasks retain a durable period reference and a clearly provisional preview. No future Occurrence is created just to render them. The preview assumes intervening scheduled advances and changes when an earlier period is skipped, overridden or administratively corrected. Forecast work is bounded to 366 calendar days; more distant bindings explain that their order is not available yet instead of inventing a result. At activation, consumers converge on the same authoritative snapshot. Automatic derived text/link changes preserve the baseline of a previously untouched future recurring occurrence, so later series edits do not misclassify generated refreshes as human activity.

An absent child's missing Task does not remove or renumber that child. Eligibility, if configured, resolves at the Group period once. Tasks and Meals still enforce their own execution requirements; a consumer cannot substitute another member locally. Unscheduled or unavailable results remain explicitly unresolved. Deactivation preserves history and prevents new scheduled resolution.

## Expressions, overrides and conversion

The existing typed Rotation picker exposes **This action’s assignee position**, backed by `{{shower_order.position_label}}`; numeric `.position` and the existing order/member properties remain available. It uses the resolved participant, including inherited/explicit action assignment, never the signed-in viewer. Existing frozen field provenance reconciles generated titles/descriptions/checklist text. Manual text and completed, expired or archived evidence remain intact.

**Change this evening’s order** explicitly affects every current consumer of that shared period. The original order remains in history. Normal advancement derives from the effective planned order, not actual checkbox completion timing. **Set the next order** is a separate audited future correction. An explicit correction is not overwritten when an already-open period later finalizes. Skipping with no advancement retains the Track's next position; it does not turn an occurrence override into a future correction. Finalized shared history cannot be skipped, reopened or overridden to rewind later periods.

Both mode transitions require a preview and explicit confirmation when consumers/state exist. The preview includes existing independent positions, the proposed shared order, the effective boundary and preserved exceptions. Returning to independent mode requires an explicit next member for each consumer. A durable version/Track marker prevents applying a chosen starting position twice. Superseded independent decisions remain unchanged in storage, with separate retirement provenance; they cannot block or later advance the restored Track.

Existing Task progress, responses, edits, documents and other meaningful evidence prevent unsafe binding replacement. Such occurrences are preserved and reported. Dateless Tasks require a scheduled date before joining. Private consumers are never exposed to a manager who cannot see them; a transition requiring inaccessible consumer decisions is rejected rather than silently merging their histories.

Task **This occurrence only** / **This and future occurrences** continues to govern its binding, not shared Group configuration. Template authorship remains independent from instantiated recurring series. Existing owner/descendant sharing and independent Tracks remain supported.

## Consumers and privacy

- Workflows resolve/reuse the shared period. Consumer-owned Finalize/Skip actions do not authorize Group-wide advancement. Group skip, override and correction keep their current capability checks.
- Group-backed Meals consume the shared selected/first member. An incompatible skill/presence requirement produces a needs-assignment explanation, without fallback or renumbering. Future Meals defer chooser obligations until activation. Untouched assignments follow overrides; menus, responses and other meaningful evidence are preserved as exceptions. Legacy Meal allocation remains supported.
- Group membership, schedule and intentionally shared order have Group visibility. Private Task names, dates, descriptions, progress and evidence remain behind canonical consumer visibility, including Used by, nested responses and typed pickers. The new conversion preview is never served from an idempotency cache after permissions or visibility change.
- Live events remain authenticated invalidation/version signals, without household content. Existing Task draft and optimistic checkbox behavior remains in place.

## Migration and validation evidence

A read-only check confirmed production at schema **10038** and image revision `cf4b5e2de9f0f7e8b1fd6523d6ec397c0fa12bd4`. No production startup, migration, record change or restart was performed.

The existing undeployed **10039** migration is unchanged. Additive **10040** creates schedule versions, periods, Task period references, independent-state application markers and immutable supersession provenance. Existing Groups remain independent.

Encrypted populated rehearsals cover **10038 → 10039 → 10040** and **10039 → 10040**, plus the earlier populated household fixture. Only expected migrations apply, all preexisting rows/relationships and consumed IDs are retained, integrity is OK, foreign-key violations are zero and a fresh process restart applies nothing. Fixtures include Tasks, recurring definitions, owner-based shared routines, expressions, permissions, supervision, Skills, Availability/Presence, points, documents/history, Workflows and Meal compatibility records. Evidence: `.qa/shared-migration-final.log`.

## Acceptance results

| Requirement | Direct evidence and result |
| --- | --- |
| Independent bedtime series share one period | Passed real application UI flow: create Group, author a template's binding and position expression with the picker, create three separately recurring Tasks with no common owner/run, inspect all three positions and one Track/Occurrence. Explicit and inherited action assignments both work. |
| Four evenings, absence and individual lifecycle | Passed Task API acceptance: four expected cyclic orders; Eleanor absent for one evening; completion/expiration does not advance the shared Track; points and occurrence recurrence retain their normal semantics. Existing owner-based four-night acceptance also passes. |
| Skip and early generation | Passed: early Tasks have provisional references, skipping once preserves next order and refreshes future generated text, no premature Occurrence or cursor advancement. |
| Different routine times, overnight and DST | Passed: different school/weekend times join the intended evening; after-midnight starts and explicit previous-evening binding use the same identity; spring gaps/fall overlaps use existing timezone handling. A schedule version cannot overlap the previous version's overnight window. |
| Override, reassignment and generated text | Passed titles, descriptions and checklist provenance tests; actual performer controls ordinal; manual and terminal historical fields remain unchanged. Real second authenticated client updates its open Task detail after the Group override. |
| Independent consumers and shared authority | Passed: independent Tracks retain separate cursors; shared Task/Workflow/Meal consumers reuse the same Group result and cannot supply a competing algorithm or independently finalize it. |
| Mode transitions | Passed explicit preview/confirmation and Cancel draft retention on desktop/mobile. Task round-trip conversion preserves old snapshots, applies each chosen independent seed once, and preserves/report occurrences with activity. |
| Meal mode transitions | Passed three failing-then-passing regressions: untouched independent future Meals join the shared period, returning to independent uses the confirmed seed through versioned decision provenance, and an abandoned unresolved decision cannot block the restored Track. Each Meal's pinned rule is authoritative; historical and protected records stay unchanged. |
| Permissions and privacy | Passed complete restricted HTTP payload checks, typed references, private consumer visibility and permission revocation. Existing Wall acting-member/Reader/MCP guards pass. A conversion preview cannot leak a cached response after access changes. |
| Concurrency and recovery | Passed genuinely concurrent SQLite workers: duplicate resolution, multiple scheduler finalizers, skip/override/correction versus cutoff, actual Task completion versus cutoff, and independent Track operations. Unique period/Occurrence and at-most-once advancement hold; restart recovery is chronological and bounded. |
| Future recurring edits | Passed a reproduced regression proving automatic order/text reconciliation updates only a previously pristine recurring baseline and never absorbs existing human activity into that baseline. |
| Migration and compatibility | Passed encrypted populated 10038 and 10039 upgrade paths, retained relationships/history/identities, integrity/FK checks, restart with no replay. No existing Group converts automatically. |
| Checkbox feedback | Passed six unchanged real-app card tests, including rapid/deduplicated taps, rejection, reopen, optional/final completion, once-only rewards/recurrence, second client and touch swipe versus tap. Additional shared-Group List/Kanban probe remained immediate. |

### Focused gates

These are individual gate results, **not an additive total**; several gates overlap.

- Final frozen-source Rotation backend gate: **175/175 passed**, zero skipped (`.qa/shared-final-frozen-backend.log`). Covers existing closure/privacy/expression/consumer/concurrency tests, all new shared tests including the final Meal conversion fixes, and encrypted migration rehearsals. Supersedes the earlier overlapping 172-test run.
- Affected shared/core/recurring-series gate: **75/75 passed** (`.qa/rotation-shared-derived-series-gate.log`), including the new derived-baseline regression. Overlaps the combined gate.
- Group editor desktop/mobile browser gate: **24/24 passed** (`.qa/shared-rotation-groups-ui-final.log`), including real touch handle dragging, rapid row scrolling, conversion confirmation, inherited settings and retained drafts.
- Exact copied-runtime application browser gate: **7/7 passed** (`.qa/shared-final-fullapp-card.log`): one shared bedtime authoring/second-client flow plus six existing card interaction tests. Source hashes were compared against the workspace, not just a branch label.
- After the final Meal fixes, the shared bedtime full-application test passed again on the completed and verified runtime copy (**1/1**, `.qa/shared-final-verified-runtime-fullapp.log`). The unaffected card tests and captured feedback evidence are reused. A preliminary repeat overlapped the end of source copying; its pass is excluded from final evidence.
- Migration/schema gate: **8/8 passed** (`.qa/shared-migration-final.log`); overlapping migration tests are included in the backend gate.
- Final affected Meal/consumer gate: **39/39 passed** (`.qa/shared-meal-conversion-final-gate.log`). The final review reproduced a forward-conversion gap and two round-trip variants, all fixed and directly retested. Evidence before correction: `.qa/shared-meal-forward-conversion-red.log`, `.qa/shared-meal-roundtrip-red.log`; same three regressions afterward: `.qa/shared-meal-conversion-green.log`. No schema changes were needed.
- Expression/security/idempotency review: **66 passed, one preexisting fixture failure** (`.qa/shared-consumers-review-final.log`). The failure is `test-idempotency.js` dynamically extracting a function without its `taskRevision` dependency. The same failure is reproduced from unchanged `1e87e9b` (`.qa/idempotency-baseline-review.log`).
- Test-script chain audit: **2 passed, three preexisting failures**, reproduced unchanged on `1e87e9b`. The missing registrations/browser-chain issues are identical (`.qa/shared-suite-chain-final.log`, `.qa/shared-suite-chain-baseline.log`); new shared test files are registered.

Earlier failed harness attempts are retained separately and are not counted as passing validation. The full app is served from a source-hashed non-hidden temporary directory because the existing SPA static-file rules reject serving from the `.codex` ancestor. This is a local browser-harness constraint; no application deployment configuration was changed.

### Performance evidence

Same local synthetic three-member SQLite probe before/after; 10 warmups and 100 resolutions, five warmups and 50 owner/Workflow materializations. These are local service measurements, not household-device/network timings.

| Measurement | Base 1e87e9b | Candidate |
| --- | ---: | ---: |
| Independent resolution SELECTs | 8 | 8 |
| 100-occurrence history SELECTs | 2 | 2 |
| Context projection for 3 / 30 children | 2 / 2 | 3 / 3 |
| Resolution median / p95 | 0.490 / 0.697 ms | 0.573 / 0.671 ms |
| Owner/Workflow materialization median / p95 | 29.555 / 35.200 ms | 30.800 / 35.951 ms |
| Materialization SELECTs | 436 | 453 |

The bounded context query adds shared-period references without a per-child query. Independent resolution/history budgets remain unchanged. Source logs: `.qa/shared-query-baseline.log`, `.qa/shared-query-final.log`. The measured materialization overhead is disclosed rather than described as a query reduction.

A separate Meal probe (five warmups, 40 measured synthetic materializations) measured independent allocation at **85 → 89 SELECTs**, median **2.769 → 2.881 ms**, p95 **3.713 → 3.218 ms**. Candidate shared allocation used **74 SELECTs**, median **2.419 ms**, p95 **3.340 ms**. This excludes scheduled background activation work and is not a claim that the complete shared lifecycle is faster. Evidence: `.qa/shared-meal-perf-baseline.log`, `.qa/shared-meal-perf-final-independent.log`, `.qa/shared-meal-perf-final-shared.log`.

The shared-Group middle-required-checkbox probe independently captured pixels with the checkmark and progress changing from 4/9 to 5/9 by **33.25 ms List** and **30.58 ms Kanban**. Correct DOM state at the second animation frame was **31.4 / 29.3 ms**. HTTP transport was deliberately held and acknowledged at **547.3 / 546.2 ms**; the target row was never removed and no long task was recorded. Separate unheld local HTTP samples acknowledged at **34.1 / 31.6 ms**, both HTTP 200. These are two controlled interactions per mode, not statistical percentiles. Captured browser frames are not measurements of physical display presentation. Evidence: `.qa/shared-feedback-final/{candidate-shared,candidate-native}/results.json`; inspected changed raster frames are `card-required-middle-0-frame-010.jpg` and `kanban-required-middle-0-frame-009.jpg`.

### Compatibility boundaries and limitations

- Physical phone/app/wall-device timing and production HTTPS timing were not measured. Desktop Chromium and emulated touch/mobile were exercised locally.
- A schedule version retains its approved timezone; changing it requires a reviewed new effective boundary. Forecasts beyond 366 days are explicitly unknown. Recovery is bounded per pass and does not infer real-world participation.
- Occurrences/Meals with meaningful activity are intentionally preserved and reported when safe reconciliation is unavailable. Dateless Tasks cannot join a nominal evening without a date. Historical snapshots and manually authored text remain unchanged.
- Consumer eligibility cannot silently alter the shared planned order. An incompatible Meal role remains needs-assignment until its configuration/eligibility is resolved.
- The two unrelated baseline test-harness issues above remain; no unrelated repository cleanup was attempted.

Verdict: **READY WITH KNOWN LIMITATIONS** for the requested local implementation. No unresolved candidate blocker was found by the final focused review. The limitations above are explicit compatibility/testing boundaries, not claims of exhaustive or physical-device validation.

All records used for mutation validation are isolated synthetic fixtures. Production household routines, source, schema and configuration were not changed. The final commit SHA and clean-worktree result are provided in the handoff.
