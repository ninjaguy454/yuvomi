# Kitchen meal cycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the accepted family meal workflow from Kitchen setup and individual choices through manual/automatic confirmation, Shopping, Pantry and protected cooking Tasks.

**Architecture:** A durable Kitchen cycle coordinator composes existing meal decisions, presence/rotation assignment, task lifecycle and grocery/execution services. Existing domain records remain authoritative; cycle membership, source fingerprints, request identities and immutable results prevent parallel pipelines. UI and scheduler invoke the same guarded operations.

**Tech Stack:** Node 24 ESM, Express 5, encrypted SQLite through better-sqlite3-multiple-ciphers, vanilla browser modules, node:test and Puppeteer.

**Spec:** `docs/superpowers/specs/2026-10-01-kitchen-meal-cycle-design.md` (accepted revision `8189f3c370bb6fc1d01bceb5f6ef4c32fc6cb968`).

## Global Constraints

- Initial disabled setting; manual confirmation default; automatic mode selectable this release. No guessed live coordinator, timezone override or times.
- Dropdown exactly 20 numeric values 0.25–5.00 in increments of 0.25; new response 1.00; preserve existing out-of-list values until explicit replacement. Backend 0.01–1000/two-decimal contract unchanged.
- Daily/weekly/fortnightly/monthly consecutive coverage, household IANA timezone, month-end clamp, DST gap forward/fold earlier. Creation, response deadline, review/finalization and shopping times are separate.
- Every mutation uses expected revision and stable request identity. One authoritative finalization service, no partial grocery publication or duplicate Tasks/rewards.
- Existing own/admin permissions; coordinator with required capabilities; blocked device/module access stays blocked. No OAuth changes.
- Finalized changes require reviewed adjustment; purchased/manual Shopping rows and frozen/started/completed Tasks retain history.
- All development tests use synthetic in-memory/disposable data with outbound transport blocked. No live meal GETs for QA.
- Release from exact reviewed commit, current configuration plus consistent encrypted backup, isolated upgrade/restart/rollback rehearsal. Preserve concurrent work and household data.

## Review Focus

- A retained legacy portion or recipe-to-custom edit must not silently substitute a value or stale recipe ID (Task 7).
- Task completion outside Kitchen must not falsely submit missing responses or reward the same obligation twice (Tasks 3/5).
- A disabled or rescheduled automatic trigger racing a manual confirmation must not publish stale input (Tasks 2/4).
- Ingredient removal, a bought row from an older grocery run, and shared row ownership must preserve purchase provenance without phantom food (Task 6).
- A late trip after some cooking work has started must keep effective absence visible without rewriting protected assignments (Tasks 5/6).

## Workspace and sequence

Use existing isolated worktree `vidamia-meal-design`, renamed to implementation branch `feature/kitchen-meal-cycle-20261001`; preserve the documentation commits. Baseline production/main/source freshly verified at `e37f30b39a2e5d1b93516cac99d8834ec71e2412`. Original `vidamia-meal-qa` remains the evidence checkout; import only its four-file authorized assignment diff, leaving QA artifacts behind. Reuse its installed dependencies through a local ignored junction and its test-only network/browser preload. No dependency additions planned.

Tasks are ordered; do not run writers concurrently. Each task records red/green evidence, commits and rulings in `.superpowers/sdd/2026-10-01-kitchen-meal-cycle/progress.md`. Shared interfaces below are the boundary contract; add justified details in that ledger as source examination resolves implementation choices.

### Task 1: Preserve the authorized assignment corrections

**Files:** Modify `server/routes/meals.js`, `server/services/meal-execution.js`, `server/services/meal-plans.js`, `test/test-rotation-meals.js` only.
**Interfaces:** Existing signatures unchanged. Unresolved cook rotation fails with actionable 409 before output creation; late travel preserves otherwise eligible committed cook/supervisor.
- [ ] Run the six already-written regressions against this unpatched worktree; expect the recorded outsider/preservation assertions to fail. Do not rewrite previously approved tests.
- [ ] Apply the exact four-file QA patch, verify source hash/provenance against `artifacts/design-before-fixes.patch`.
- [ ] Run `node --require ../vidamia-meal-qa/qa-isolation.cjs --test test/test-rotation-meals.js test/test-meals-routes.js test/test-meals.js`; expect all passing.
- [ ] Commit `fix: preserve meal assignment eligibility during reconciliation`.

### Task 2: Cycle persistence and calendar scheduling

**Files:** Create `server/services/meal-cycle-schema.js`, `server/services/meal-cycle-schedule.js`, `server/services/meal-cycle-settings.js`, `test/test-meal-cycle-schedule.js`, `test/meal-cycle-fixture.js`; modify `server/db.js` append-only.
**Interfaces:** `addMealCycleSchema(database)` adds settings, cycles, memberships, task links, requests, immutable results and events. `getCycleSettings(database)` returns `{revision,enabled,timezone,cadence,first_period_start,creation,response,confirmation,shopping,coordinator_id,shopping_assignee_id,shopping_list_id,finalization_mode}`. Timing values are `{day_offset,time}` relative to period start; monthly UI resolves numbered day/month offset to an equivalent per-period instant through schedule helper, preserving its rule. `saveCycleSettings(database,input,{actorId,expectedRevision})` validates explicit activation. `periodForStart(start,cadence)` returns `{start,end,next_start}`; `cycleInstants(settings,start)` returns UTC creation/response/confirmation/shopping instants plus period; `dueCyclePeriods(settings,now)` skips ended history.
- [ ] Write failing tests for disabled defaults/no guessed IDs, required activation fields, invalid dates/timezones, 1/7/14/calendar-month coverage, Jan31/Feb and leap year clamp, DST gap/fold, separate due dates, no completion drift, future-only edits, append-only migration replay.
- [ ] Run `node --require ../vidamia-meal-qa/qa-isolation.cjs --test test/test-meal-cycle-schedule.js`; expect missing-module/function failures first.
- [ ] Implement durable schema at next unused migration version; reuse timezone helpers where their tested behavior matches. Use checked JSON for snapshot fields and FK/unique indexes for identities; no real household seeding.
- [ ] Run new tests and `test/test-migrations-append-only.js`; expect all passing. Commit `feat: add durable Kitchen cycle settings and scheduling`.

### Task 3: Open cycles, personal submissions and canonical write guards

**Files:** Create `server/services/meal-cycles.js`, `server/services/meal-cycle-guards.js`, `test/test-meal-cycles.js`; modify `server/services/meal-plans.js`, `server/routes/meals.js`, `server/services/task-lifecycle.js` narrowly.
**Interfaces:** `ensureCycle(database,{start,actorId,requestKey})` creates/links authoritative occurrences, snapshot and uniquely linked personal/review/shopping Tasks. `reviewCycle(database,cycleId,{actorId,beneficiaryId})` is read-only and returns revision, fingerprint, occurrences, personal response needs, role/status/blockers and linked destinations/tasks. `saveCyclePerson(database,cycleId,{actorId,beneficiaryId,expectedRevision,requestKey,changes})` writes canonical menu/decision operations atomically. `submitCyclePerson(database,cycleId,{actorId,beneficiaryId,expectedRevision,requestKey})` validates completeness and calls existing task lifecycle once. `assertCycleMealWrite(database,mealId,{cycleId})` prevents direct edits bypassing finalized state; an internal scoped write capability must not be controllable through request JSON.
- [ ] Write failing service/route tests: ensure retry creates one cycle/membership/task per identity, Home/trip slices, personal own/admin permissions, shared-main responsibility distinct from diner response, dependent pending main blocks submit, away/not-eating contributes zero, main change preserves sides and others' alternatives, menu deadline remains editable until confirmation, duplicate submit produces one lifecycle/reward effect, stale revision and reused-key/different-body conflict.
- [ ] Run `node --require ../vidamia-meal-qa/qa-isolation.cjs --test test/test-meal-cycles.js`; observe intended failures.
- [ ] Implement on existing materialization/week model/decision writers. Record source fingerprints covering canonical menu/decision/attendance/group sources. Link task action URLs to cycle+beneficiary; external task completion must validate the cycle obligation through a small registered lifecycle hook, not bypass Kitchen submission validation. Keep imports acyclic and register at startup/route initialization.
- [ ] Verify read-only review by database total_changes and no output creation. Run new suite plus meal domain/portions routes/task lifecycle affected tests; commit `feat: connect meal cycle choices and submission Tasks`.

### Task 4: Atomic manual and automatic confirmation

**Files:** Create `server/services/meal-cycle-finalization.js`, `server/services/meal-cycle-scheduler.js`, `test/test-meal-cycle-finalization.js`, `test/test-meal-cycle-scheduler.js`; modify `server/services/meal-grocery-runs.js`, `server/services/meal-execution.js`, `server/index.js`.
**Interfaces:** `finalizeCycle(database,cycleId,{actorId,expectedRevision,requestKey,trigger,now})` returns immutable result `{cycle_id,revision,grocery_runs,execution_task_ids}`; `trigger` is trusted internal invocation, never copied from public JSON. `runMealCycleScheduler(database,{now})` ensures due cycles and attempts ready automatic cycles. `startMealCycleScheduler()` starts immediate+60s sweep. `rescheduleCycle(database,cycleId,{actorId,expectedRevision,requestKey,schedule,confirmDueNow})` affects open cycle only. Grocery create accepts explicit `mealIds` scope and suppress/defer-notifications option; existing calls unchanged.
- [ ] Write failures for missing choice/role/list/ingredient acknowledgment, permitted claimable role, destination partition source uniqueness, latest committed edit included, stale preflight, concurrent manual+automatic workers, injected mid-publication failure full rollback, response racing finalization, stable retry result, required actor authorization, source reductions, no old Prepare bypass.
- [ ] Write scheduler failures for exact timezone instant, startup/missed-before-meal catchup, missed-after-first-meal blocked, future-only settings, disable and explicit reschedule races, past-due confirmation requirement, blocked follow-up dedup, retry after corrected inputs.
- [ ] Run both new files and observe intended failures; implement immediate serialized SQLite transaction with immutable result uniqueness. Perform no transport/notification side effect before commit. Failed attempt metadata may not overwrite newer successful state. Existing prepare redirects/409 for cycle-owned meals.
- [ ] Run finalization/scheduler + existing groceries/execution regression suites; expect all passing. Commit `feat: confirm Kitchen cycles safely in manual and automatic modes`.

### Task 5: Presence events and protected role reconciliation

**Files:** Create `server/services/meal-cycle-reconciliation.js`, `test/test-meal-cycle-reconciliation.js`; modify cycle schema/scheduler, `server/services/meal-plans.js`, `server/services/meal-execution.js` and relevant canonical source change hooks.
**Interfaces:** `enqueueCycleReconciliation(database,{scope,sourceRevision,reason})` durably deduplicates affected source changes. `reconcileCycle(database,cycleId,{now})` recomputes open effective attendance/roles and targeted obligations, or stages finalized deltas. SQLite change triggers may enqueue broad household dirtiness; worker narrows by fingerprint/date/member before effects. Preserve stored choices independently of effective away status.
- [ ] Write failures for weekday school lunch, weekends/holiday-at-home, no-child household, whole and partial trip, chooser away after valid main, returning saved response versus deliberate opt-out, unavailable chooser before main, empty eligible cook group, actual assignee change versus unrelated traveler, repeated event retry/startup, immutable rotation history, untouched task assignee correction, any frozen snapshot protects all siblings.
- [ ] Observe failures; implement targeted correction using existing eligibility and presence precedence. No outsiders, duplicate rotation turns, deletion of responses or false automatic completion. Invalidated submitted work gets linked non-rewarding follow-up without erasing completed history.
- [ ] Run new suite and original rotation/meal/presence tests; commit `feat: reconcile meal cycles with availability and travel`.

### Task 6: Reviewed adjustments, grocery reductions and purchase continuity

**Files:** Create `server/services/meal-cycle-adjustments.js`, `test/test-meal-cycle-adjustments.js`; modify grocery service, `server/services/shopping-import.js`, relevant Pantry reconciliation lookup and cycle orchestration.
**Interfaces:** `proposeCycleAdjustment(database,cycleId,{actorId,expectedRevision,requestKey,changes})` returns staged impact without changing confirmed outputs. `applyCycleAdjustment(database,cycleId,{actorId,proposalId,expectedRevision,requestKey})` revalidates source+protected downstream fingerprint and atomically applies safe deltas. Result identifies preserved purchased/manual/frozen conflicts explicitly.
- [ ] Write failures for increased/decreased portions, removed/manual-empty ingredients, duplicate publish, mixed row ownership, unchecked untouched reduction/removal, manually edited/purchased/partial rows preserved, new demand adds only unmet quantity, old-run purchase still reaches Pantry once, custom recipe identity change, stale proposal and canceled proposal, started cooking history preserved.
- [ ] Observe failures; extend attributable-source reconciliation only. Never fake negative Pantry receipts or undo real purchases. Preserve confirmed baseline and audit prospective corrections. Resolve existing QA bugs only where these required paths touch them.
- [ ] Run new + grocery/Pantry/meal portions suites; commit `feat: review meal changes without losing shopping or chore history`.

### Task 7: Kitchen API and coherent family screens

**Files:** Create `server/routes/meal-cycles.js`, `public/pages/meal-cycle.js`, `public/settings/pages/kitchen-cycle.js`, `public/utils/meal-cycle-portions.js`, `public/styles/meal-cycle.css`, `test/test-meal-cycle-routes.js`, `test/test-meal-cycle-ui.js`; modify `server/routes/kitchen.js`, `public/api.js`, `public/pages/meals.js`, `public/settings/pages/modules-kitchen.js` and required task deep-link handling/styles entrypoint.
**Interfaces:** API under `/kitchen/cycles`: settings GET/PUT and preview POST; cycle list/read GET (no writes), ensure POST, personal save/submit POST, confirm POST, reschedule POST, adjustment preview/apply POST. Server derives actor from auth; request key/revision mandatory for mutations. Client `mealCycles` methods wrap existing apiFetch and send only validated operation input.
- [ ] Write route failures for authenticated own/admin/coordinator, missing meals/tasks/shopping capabilities, denied modules/device context, malformed IDs, IDOR via beneficiary, CSRF app integration, stale/reused request, no public scheduler bypass, read-only GET. Write UI failures for exact20 options/default1/legacy value preserved; recipe-to-custom clears ID; cancel/back keeps draft; stale load ignored; double-submit one operation.
- [ ] Run both new files; observe failures. Build settings with explicit enable and preview, cadence/timezone/times/coordinator/list/mode, usual routine links and advanced disclosure. Build phase navigation: My choices → Household review → Shopping & today's Tasks, all7days/3slots + Home/trips, everyday labels, actionable blockers, submitted editable status, confirmation impact, adjustment delta. Reuse original meal editors where safe; preserve main/sides roles and offer personal alternatives directly. Display serving basis and requested/cooking portions distinctly.
- [ ] Use semantic controls, focus/error states, touch targets and responsive single-column cards. Each browser operation retains local draft until successful response, handles stale409 refresh explicitly, and stays on the same cycle after return from Shopping/Tasks. Disabled feature leaves existing flows accessible.
- [ ] Run routes/UI + settings/kitchen tabs/mobile/meal-week model checks; commit `feat: guide families through Kitchen planning and shopping`.

### Task 8: Integrated household verification and independent review

**Files:** Create `test/test-meal-cycle-full-app-browser.js`, `test/test-meal-cycle-integration.js`, release evidence under `docs/`; no real household fixtures.
- [ ] Add failing authenticated browser coverage for setup→Task link→shared choice/personal backup+portions→submit/edit→household review→manual confirmation→Shopping purchase→Pantry→cooking Task, plus automatic blocked/recovered flow, stale/cancel/back/retry, two tabs. Use installed Windows Chrome with existing synthetic test preloads at desktop1440 and responsive390. Do not call emulation physical-phone testing.
- [ ] Complete implementation until new tests pass, then run all named scenario and scheduler suites and appropriate aggregate meal/grocery/task/rotation/security/migration suites. Capture commands/counts/screenshots, failures and limitations exactly. Do not claim supervised child/physical-device sessions that did not occur.
- [ ] Freeze commit and obtain fresh independent whole-branch review of spec coverage, correctness, authorization and production risks. Fix important findings with red→green tests and rerun affected aggregate checks; record remaining minor rulings. Commit exact tested result.

### Task 9: Back up, rehearse, deploy and verify exact artifact

**Files:** Release record `docs/meal-cycle-release-20261001.md`; opaque backup/config/images outside repo only through reviewed authorized commands. Consult `artifacts/meal-release-readiness.md` and `docs/reliability-repair-20260928.md`.
- [ ] Recheck current remote/main/source/container SHA and concurrent changes. Integrate normally only if unchanged or after reviewed conflict resolution; never include OAuth. Build Git archive of frozen commit into unique `yuvomi:release-<fullSHA>` image, verify packaged runtime hashes.
- [ ] Create fresh supported encrypted SQLite backup and copy CURRENT deployment configuration opaquely; hash and validate without printing secrets. Save prior image and redacted manifest. Verify upgrade/startup twice against isolated backup copy with network disabled, preserving household invariants. Rehearse supported restore/rollback on disposable data; avoid old image against unknown schema and preserve post-deploy data if rollback needed.
- [ ] Only after gates pass, update the image reference in existing installed Compose and recreate. Keep new cycle feature disabled/manual defaults until explicit household setup. Verify health, schema, exact image/SHA, public localhost/HTTPS and controlled restart; authenticated read-only smoke must avoid materializing legacy meal GET routes.
- [ ] Record actual deployed SHA/image, tests/pass/fail/unrun, backup/rollback verification and required setup. Update user artifact if implementation evidence warrants, preserving Library identity. Stop only for a concrete permission/security/data-loss blocker; do not seek approval again for the already-authorized deployment.

## Self-review

Spec sections 1–2 map to Tasks 3/7/8; scheduling to2/4; ownership and API to3/4/7; presence to5; groceries/protected changes to6; rollout to8/9. Portion legacy and interrupted UX tests are in7/8. Review Focus is assigned to exact owning tasks. Interface sharing:2→3/4 settings+schedule/schema;3→4/5/7 cycle review/revision/write guards;4→6 immutable results/exact source partitions;5→6 staged reconciliation;3–6→7 routes/client;all→8/9. No contradictory duplicate ownership intended. Acceptance for a supervised child and physical phone remains an explicitly unrun human evaluation unless supplied; responsive authenticated automation supplies engineering evidence, not a false substitute.
