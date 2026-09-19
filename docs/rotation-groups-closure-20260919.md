# Rotation Groups checklist closure

Branch: `feature/rotation-groups-20260919`. Audited base: `65555031e1d686dcc16cc463b5a026d85585b2f8`.

The working tree was clean at that exact commit before this pass. This pass extends the existing Group → Track → Occurrence implementation. It neither replaces the architecture nor changes production records. No publication or deployment was performed. The final local commit SHA is reported in the handoff; this document is included in that commit.

Verdict: **READY WITH KNOWN LIMITATIONS** for local handoff. No reproduced candidate blocker remains in this closure checklist. Physical-device and production validation remain outside this local pass, and the existing unrelated fixture failure described below is still present.

## Closure table

| Finding | Status | Direct evidence |
| --- | --- | --- |
| F1 private consumer context | Fixed and directly tested | Complete Group payload filtering, denied Track/history/Occurrence reads and mutations, private inherited owner, typed inputs/pickers/previews, cached Workflow replay visibility; restricted viewer assertions inspect returned data, not labels alone |
| F2 Workflow override text | Fixed and directly tested | Current generated title, description and checklist title rerender from preserved expression provenance; manual text and completed evidence stay unchanged |
| F3 unchanged purpose reset | Fixed and directly tested | Change, add and remove one purpose; untouched Chores Track, binding, snapshot and position remain identical |
| F4 participant reassignment text | Fixed and directly tested | Reassigned participants recompute bound checklist position text; manual literal remains intact |
| F5 empty historical Group retirement | Fixed and directly tested | Last-member departure, successful deactivation, historical snapshot/membership retention; empty creation/reactivation still rejected; retirement editor browser check |
| Workflow operation authoring | Implemented and directly demonstrated | Real Workflow editor saves resolve/reuse plus enabled Finalize/Skip; run API verifies authorization, frozen configuration, purpose isolation and idempotency |
| Track correction history | Implemented and directly demonstrated | Contextual history shows correction separately, with actor/time, previous/new position and reason; Group browser suite and exact durable-event assertions |
| Recorded completion order | Implemented and directly demonstrated | Task Details disclosure in actual app; individual records separate from planned/effective order; bulk, tied and older unclassified evidence explicitly unordered |
| Shared bedtime setup | Implemented and directly demonstrated | Real app creates Group, recurring parent Activity and three individually assigned descendants; positions, override text, second authenticated client, finalization once, next recurrence |
| Independent consumers | Fixed behavior retained and directly tested | Real Meal service and third consumer retain independent Track state during shower advancement; separate workers resolve/advance independent Tracks concurrently |
| Missing concurrent scenarios | Implemented and directly tested | Four simultaneous same-request Workflow workers; actual authorized Task completion versus canonical Rotation finalization; independent Track workers with shared Group |
| Populated encrypted migration | Implemented and directly tested | Connected 10038 fixture retains Meals/assignments, proficiency, Availability/Presence, supervision evidence, documents/ACLs and Task history; only 10039; integrity/FKs/restart |
| Redundant reads | Fixed and directly measured | Bounded operation-local Group/member reuse, batched history hydration and shared Task ancestry; query budgets below |
| Checkbox feedback | Preserved and directly demonstrated | List/Kanban raster evidence before held HTTP acknowledgement; real-app queue/rejection/touch/live/points/recurrence tests; Task Details disclosure preservation test |

## F1–F5 causes and corrections

**F1:** Rotation capability checks and redacted consumer labels did not authorize the rest of a nested consumer snapshot. Raw context, dates, subject identity, previews and history could still reveal private Tasks. `rotation-access.js` now supplies one canonical consumer projection, using existing Task/Workflow/Meal access rules before returning contextual state. Inaccessible consumers are omitted from Group usage; direct contextual reads/mutations return 404. Current visibility also applies to typed references and cached Workflow responses, including externally referenced Rotation-derived text. An idempotency-cache privacy denial cannot fall through into a second creation.

The conservative boundary is deliberate: Track controls/history are withheld if any linked owning Task is inaccessible, because cursor and preview state can reveal those decisions. Permitted Group information remains readable. Orphaned Task history without a surviving authorizable owner is admin-only.

**F2:** Workflow materialization rendered labels but did not retain enough field authorship for descendant rerendering. The generated Activity snapshot now freezes templates, referenced definitions, input identities, stable action keys and last generated values, including Workflow step title/description overrides. The existing expression engine reconciles active descendants on override; no numeric string replacement is used.

**F3:** An occurrence-scoped configuration edit rebound every purpose when any binding changed. Configuration now compares by stable purpose key and reconciles only changed, added or removed purposes. Unchanged purposes retain their durable identity and exact snapshot.

**F4:** Participant reassignment changed canonical contextual position but did not invoke bound-field rendering. Relevant performer/structure/binding mutations now reconcile current provenance-backed fields. Manually edited fields detach; completed/expired/archived Task evidence is preserved.

**F5:** The nonempty-membership validation also applied when retiring an existing unusable Group. Existing Groups can now deactivate with no remaining valid members. Creating a Group or activating it still requires membership; historical references are preserved.

The same retained regressions fail on immutable audited source and pass on the candidate: four core F1/F5 cases and five Task F2/F3/F4 cases. Two additional cached-response privacy reproductions also fail on the audited source and pass with F1. Evidence is under `.qa/rotation-closure-{core-baseline,tasks-baseline,replay-baseline}.*`. Validation expectations were not relaxed.

## Product surfaces and shared ownership

Groups remain managed under Household Automation. Tracks are configured through consumers; Occurrences remain contextual history. The configuration UI explains that one explicit parent Activity/Workflow owns a shared purpose and its individual descendant Tasks reuse that occurrence. Independent existing series are never joined by matching names, dates or Group IDs.

Workflow authoring enables explicit authorized Finalize/Skip actions on the generated Workflow parent's Task Details, with resolve/reuse at run creation and an explicit reuse action. This default was reported during the work: these are run actions, not automatic stage triggers. The run freezes its authored operations; later Template edits cannot change an existing run's allowed actions. Operations reuse canonical Rotation transactions, capabilities and revisions. Ordinary child completion does not independently advance a shared Track; existing owner-completion policies still apply.

Correction history displays existing durable Track corrections separately from occurrence outcomes. Newly recorded correction details include stable previous/next identities and display names; older events remain readable without rewriting them.

Recorded completion order reads linked Task Activity events. It is explicitly labeled as app-recorded evidence, not proof of physical shower order. New completion events add individual/bulk source and assigned-member metadata to the existing JSON event. Bulk records, equal timestamps and legacy records without source metadata do not receive inferred ordering. Planned snapshots remain unchanged. Evidence is fetched on Task Details reads, not list or checkbox mutation paths. History disclosure refreshes target only the Rotation section and preserve existing Task rows, scroll, focus and disclosure state.

The real full-app acceptance uses a fresh synthetic database and actual auth, HTTP routes, scheduler and SSE. Through the UI it creates Kids Shower Order, an Activity Template, a recurring shared bedtime owner, and descendant Tasks assigned to Gracelynn, Eleanor and Frankie. It verifies positions 1/2/3, overrides to Frankie/Gracelynn/Eleanor, and observes updated bound text and position on a second authenticated client. Completing the children settles once and generates the next nightly recurrence from the same Track. The Meal chooser and third consumer keep independent state. The existing four-night Task API acceptance remains in the backend gate; it was not multiplied across viewports.

## Concurrency and audit

New races use separate worker connections to a file-backed WAL database and a shared start barrier, rather than sequential calls labeled concurrent:

- Four identical Workflow retries return one Workflow instance, one durable request, one Rotation Occurrence and one set of Tasks; no advancement or partial state.
- Four concurrent retries of the newly authored Workflow Finalize operation use identical captured revisions and return the same finalized occurrence. Exactly one event and advancement commit; complete Task/progress/history/reward/binding rows remain unchanged.
- Actual authorized Task completion races canonical completion finalization. Exactly one advancement, Task completion event, Rotation completion event and reward earn survive. A subsequent stale Task revision rejects with 409.
- Independent Tracks simultaneously resolve and advance against one Group. Each keeps its own state and each logical occurrence/advance remains unique.

Existing worker races for duplicate resolution/finalization, override/finalize, correction/finalize and Group membership edits remain in the affected gate. Strengthened skip/override/correction checks verify event counts, actor, timestamp, original/effective order and immutable historical snapshots. The existing failed-successor test proves atomic rollback of Task and Rotation work.

## Migration

Migration 10039 and deployed migrations through 10038 are unchanged. No new migration is required for this closure: operation configuration and rendering provenance use existing JSON snapshots; completion/correction details use existing event JSON.

The encrypted production-shaped synthetic fixture contains populated joins for Meal Plans, plan revisions/rules, chooser/cook/supervisor assignments and legacy cursors; member skill proficiency and Task requirements; dated Availability and recurring Presence at Home; generated helpers, responsibility/action mappings and completed supervision evidence; documents, access grants and Task links; completed/expired Task Activity events. Previously covered Tasks, Optional progress, series provenance, Templates, Workflows, Variables, comments and rewards remain populated too.

All preexisting table values/columns, explicit indexes/triggers, consumed identities and meaningful joined relationships compare unchanged before/after and after a new process restart. Only **10039** applies. Integrity is **OK**, foreign-key violations **0**, prior migration history unchanged, restart migration replay **0**. This is not a live production database copy or a deployment backup.

## Query and performance evidence

Before/after use the immutable audited source and closure candidate on the same local synthetic fixture. No cross-request permission/eligibility cache was added; facts are not reused across intervening mutations.

| Operation | SELECTs before → after |
| --- | ---: |
| Resolve one three-member Track | 12 → 8 |
| Read history of 100 occurrences | 102 → 2 |
| Inspect current/three next previews | 29 → 6 |
| Resolve three independent Tracks in one transaction | 36 → 24 |
| Project shared context for 30 children | 32 → 2 |

One resolution now reads Group/membership once each rather than three times; eligibility resolves once. Independent Tracks each reread current facts, avoiding stale reuse across mutations. Completion evidence batches distinct Task rows before visibility checks.

Warm in-memory resolution, 10 warmups/100 samples: median **0.575 → 0.480 ms**, p95 **0.687 → 0.557 ms**. Three-child Workflow materialization, 5 warmups/50 samples: median **26.07 → 27.38 ms**, p95 **49.70 → 49.90 ms**. Its SELECT count is **420 → 436**, including new frozen expression provenance. There is no claim that whole Workflow materialization became faster.

The focused full-app middle-step probe attached Rotation context and held HTTP dispatch for 500 ms. List/Kanban correct DOM first-frame observations were **13.7/14.5 ms**; second-frame observations **30.3/30.7 ms**. These are not paint measurements. Independently inspected screencast raster frames show checkbox plus required progress by **23.1 ms List / 28.1 ms Kanban**, with preceding frames at 8.1/12.6 ms unchanged. HTTP acknowledgement arrived at approximately **540/545 ms**. No target row removals or long tasks were observed. The audited candidate's retained raster evidence was 38.8/24.3 ms; both remain under 50 ms, with no statistically significant improvement claim from these small samples.

Artifacts: `.qa/rotation-closure-performance-{before,after}.json`, `.qa/rotation-closure-feedback/closure-raster/results.json`; inspected frames List 008/009, Kanban 009/010. Physical phone/wall timing and production HTTPS were not measured.

## Validation ledger

These are individual gates and overlap. Do not add them into a unique-test total. Full repository QA and repeated four-night browser matrices were intentionally not run.

| Gate | Result | Local evidence |
| --- | --- | --- |
| Combined Rotation service/API/consumer/security/concurrency/migration/query gate | **124/124 passed** | `.qa/rotation-closure-final-backend.log` |
| Final consumer races, including the additional authored-operation retry case | **3/3 passed** | `.qa/rotation-closure-final-consumer-races.log` |
| Affected series, Optional lifecycle, expiration, supervision refresh/scheduling | **81/81 passed** | `.qa/rotation-closure-existing-regression.log` |
| Real-app shared setup plus existing card regression suite | **7/7 passed** (one shared setup, six card checks) | `.qa/rotation-closure-final-full-app.log` |
| Group editor/history desktop/touch browser gate | **18/18 passed** | `.qa/rotation-closure-ui.txt` |
| Task Details feedback/disclosure reconciliation | **13/13 passed** | `.qa/rotation-closure-detail-feedback.log` |
| Final Task binding/operation/completion-evidence gate after batching | **8/8 passed** | `.qa/rotation-closure-final-task-details.log` |
| Final shared setup/history browser after batching | **1/1 passed** | `.qa/rotation-closure-final-history-browser.log` |
| Existing idempotency compatibility | **17/18**, same fixture failure on audited base | `.qa/rotation-closure-idempotency.log`, `.qa/rotation-closure-idempotency-baseline.log` |

The compatibility failure is the unchanged extracted Task-form fixture missing `taskRevision`; actual middleware/privacy retry tests pass. Earlier full-app harness attempts encountered an initial SSE-detached button, a footer-portal selector mismatch and missing explicit due-offset fixture setup. Those attempts are not passes. The known hidden `.codex` ancestor SPA-serving limitation uses an exact disposable non-hidden source copy; no application routing workaround was added.

The final authored-operation race was added after the combined 124-case run and passed in its focused three-case file. Its first fixture draft used a nonexistent `default_points` column; the fixture was corrected to the existing `points` column. This required no application/schema change and is not counted as a passing attempt.

Independent final review caught a candidate defect in the new Rotation-only DOM reconciliation: retained button listeners captured an old occurrence revision or purpose. Actions now read current button identity and canonical Task state when clicked. A browser regression exercises both a live revision change and a changed purpose/action on the same retained button; both pass. The subsequent change is limited to that event handler and its test, so unaffected card timing and the real-app setup evidence are reused.

All 17 changed/new runtime files match the disposable validated source snapshot; all 30 changed/new JavaScript files parse. `git diff --check` passes. The migration source files remain byte-for-byte unchanged in Git relative to the audited commit. Source hashes are retained in `.qa/rotation-closure-source-receipt.json`.

## Compatibility boundaries and remaining limits

- Existing one-household-per-database boundaries remain; this is not a new multitenant model.
- Private contextual Track history is conservatively hidden across mixed-visibility owners; readable Group information is retained.
- Shared bedtime requires an explicit owner. No existing household bedtime series or records were migrated.
- Workflow Finalize/Skip are explicitly authored run actions; no new automatic stage-action engine was introduced.
- Historical completion records without reliable individual provenance remain unordered; no real-world action order is inferred.
- Legacy Meal alias cursors retain the documented compatibility adapter and pending-tail reconciliation; canonical Group-backed consumers use independent Tracks. Meal allocation still finalizes on materialization, including future planning.
- Local Chromium/Edge and touch emulation passed. Physical devices, production HTTPS and deployment readiness safeguards remain untested in this local-only pass.

All requested closure surfaces are present. No unresolved F1–F5 defect or schema conflict was found in the focused validation. The local handoff is ready with the stated evidence limits and unchanged baseline fixture failure.
