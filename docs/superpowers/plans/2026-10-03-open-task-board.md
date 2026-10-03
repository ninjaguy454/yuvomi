# Open Task Board Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Do not delegate additional agents unless separately authorized.

**Goal:** Let users accept ordinary unassigned tasks, with optional authorized co-assignees and optional subtask allocation, in one atomic operation.

**Architecture:** Add a read-only offer projection and shared acceptance service over existing task models. Human/device adapters retain their own authority, while one modal flow collects a draft and commits once. A bounded opt-in helper capability avoids granting general reassignment rights.

**Tech Stack:** Node >=22, vanilla browser ES modules, Express, existing SQLite implementation, node:test, existing Puppeteer browser harnesses.

**Spec:** [Phase 3 design](../specs/2026-10-03-open-task-board-design.md)

## Global Constraints

- The release order is Phase 1 paired Notes, Phase 2 canvas/privacy, Phase 3 open tasks.
- No further live deployment until the parent explicitly lifts the hold after the user returns.
- Background implementation may use isolated test containers after Phase 1 finishes.
- Never modify live household data, device grants, configuration, services, or the urgent worker's checkout.
- Use Node >=22, vanilla JavaScript ES modules, existing CSS tokens/components, and existing vendored frontend utilities.
- No framework, bundler, runtime CDN, or new frontend package.
- Migrations are append-only; the test schema must match.
- No new grants are activated by default.

## Review Focus

- A null assigned_to on a managed or already participating task must not create an unauthorized offer (Task 1).
- Restricted claimants need the helpers flow without gaining general reassign rights (Task 2/4).
- A changed child or revoked device after the wizard opens must reject the whole acceptance (Task 3).
- Losing a success response and retrying must not duplicate assignments/history/notifications (Task 3).
- Allocating zero subtasks and removing a helper on Back must preserve ordinary unassigned semantics (Task 4).

## Preparation

Use an independent clone and `feat/open-task-board` branch from the parent-accepted Phase 2 candidate. Follow Phase 2 plan's synthetic DB, loopback port, test secrets, no live mounts, suite-registration, evidence and scoped-commit rules. Preserve all Phase 2 privacy changes and its rollback barrier.

Parent approved `tasks.accept_with_helpers` / `device_tasks.accept_with_helpers`, default none, as the implementation design. This does not authorize enabling either capability on any production member/device. Wait for the actual final Phase 1 commit before choosing a baseline, and consolidate any mandatory written-plan review for later without interrupting the urgent rollout. Until then, only lightweight preparation in this separate workspace is permitted; avoid competing Docker/build resources.

### Task 1: Canonical offer projection and assignment helper extraction

**Files:** Create `server/services/task-offers.js`, `server/services/task-assignments.js`; modify `server/routes/tasks.js`, `server/services/device-tasks.js`; tests `test/test-task-offers.js`, `test/test-task-assignment-preservation.js`.

**Interfaces:** `taskOfferState(d,principal,task) -> {visible,claimable,reason}`; `listTaskOffers(d,principal,query={}) -> projectedTasks`; `setTaskAssignments(d,taskId,userIds) -> void` preserves the current setAssignments semantics, including subtask responsibilities and parent participant union.

- [ ] Write failing tests for ordinary unassigned active roots; assigned_to-only, assignment-table-only and responsibility-only ownership; future start; overdue active versus expired; archived/done; private/selected visibility; view_own; managed fixed/rotation context; explicit open-claimable eligibility; exclusion of children and helper projections; read operations produce zero database changes.
- [ ] Write equivalence tests showing helper extraction preserves explicit child assignments, parent source=subtasks participants, unrelated primary/supervisor/beneficiary roles, and revision propagation.
- [ ] Run `node --experimental-sqlite --test test/test-task-offers.js test/test-task-assignment-preservation.js`; inspect expected failures.
- [ ] Implement projection using task-access, task-scope/start projection and current policy services. Extract only the shared assignment helper; do not refactor the rest of the large task route. Add a narrow query option/endpoint in existing Tasks read adapters so authorization still precedes payload projection.
- [ ] Run new tests plus existing task scope, visibility, multi-assignment, subtask skills and device-task suites. Commit `feat: project claimable ordinary tasks from canonical state`.

### Task 2: Explicit bounded accept-with-helpers authority

**Files:** Modify `server/task-capabilities.js`, `server/services/task-access.js`, device capability definitions/configuration UI, normal permissions UI if required; create `server/services/task-acceptance-policy.js`; tests `test/test-task-acceptance-permissions.js`.

**Interfaces:** `assertTaskAcceptance(d,principal,task,{primaryUserId,coassigneeIds,subtaskAssignments}) -> void`; `acceptanceOptions(d,principal,task) -> {primary_candidates,coassignee_candidates,can_add_helpers,reason}`. New capability values default none and supplement existing claim checks. Existing full assignment authority can authorize the same helper operation.

- [x] Parent approved the bounded contract; decision recorded in the spec. No actual profiles changed.
- [ ] Write failing tests: no view/claim cannot accept; human primary cannot impersonate another member; device primary/helper outside scope denied; new grant off/on; grant cannot edit an assigned task, remove an existing assignee, change points/skills/status/visibility, cross task boundaries, mutate recurrence definitions, or allocate protected child actions. Default and existing saved profiles remain ungranted.
- [ ] Run `node --experimental-sqlite --test test/test-task-acceptance-permissions.js`; confirm intended failures.
- [ ] Implement strict current-state checks and option projections with minimal member fields. Do not reuse the picker to set authUserId/session.userId. Reuse canonical skill/presence/supervision eligibility; grant is never an eligibility bypass. Show why helper selection needs authorization when denied.
- [ ] Run new and existing device adversarial/auth/task-permission suites. Commit `feat: scope optional helper authority to initial task acceptance`.

### Task 3: Atomic acceptance, revision checks and retry receipts

**Files:** Create `server/services/task-acceptance.js`, `server/services/task-acceptance-schema.js`; modify `server/routes/automation.js`, `server/services/device-tasks.js`, `server/services/assignment-responsibilities.js`, `server/db.js`, `server/db-schema-test.js`, API descriptions; tests `test/test-task-acceptance.js`, `test/test-task-acceptance-races.js`, `test/test-task-acceptance-migration.js`.

**Interfaces:** `acceptTask(d,principal,taskId,body) -> {task,receipt}` accepts the spec payload. Adapters preserve existing `/automation/tasks/:id/claim` compatibility where possible, routing the new complete acceptance payload to the shared service. Receipt unique key includes principal type/ID, auth context and operation ID; request hash prevents key reuse with altered payload.

- [ ] Write failing transaction tests for primary-only, helper with no subtasks, helper with partial/zero allocation, canonical child/parent responsibility updates, protected ownership preservation, skill/availability rejection, and unchanged status/points/series definitions.
- [ ] Write real multi-connection SQLite races: two simultaneous claimants yield one winner; same receipt retries yield one logical acceptance; changed payload conflicts; stale parent/child/addition/deletion returns 409; failed final child validation leaves every row/event unchanged; permission reduction or member deletion is rechecked inside the transaction. Simulate a dropped success response then retry.
- [ ] Write receipt privacy tests for device revocation, temporary user returning to device, and changed visibility before replay. Replays reauthorize and project current data; no cached private response crosses identity. Test duplicate notification/outbound records and canonical source attribution.
- [ ] Run `node --experimental-sqlite --test --test-concurrency=1 test/test-task-acceptance.js test/test-task-acceptance-races.js test/test-task-acceptance-migration.js`; confirm failures.
- [ ] Implement one immediate transaction, validating all revisions/snapshot membership before writes. Use Tasks 1/2 helpers and existing managed claim checks; use an ordinary-task branch without synthetic managed contexts. Reconcile supervision and write receipt/event/transactional notification records before commit, dispatch external work afterward. Extract side effects only where required to guarantee rollback.
- [ ] Run new tests and registered task revision/release concurrency/security, supervision, rewards, recurrence, device write-context and migration/schema checks. Commit `feat: atomically accept tasks with optional subtask allocation`.

### Task 4: Shared acceptance wizard and open-task section

**Files:** Create `public/components/task-acceptance.js`, `public/utils/task-acceptance-draft.js`, `public/components/open-task-board.js`; modify `public/components/device-task-claim.js`, `public/pages/tasks.js`, Phase 2 `public/pages/notes.js`, relevant CSS/locale catalogs. Tests `test/test-task-acceptance-draft.js`, `test/test-task-acceptance-browser.js`.

**Interfaces:** `createAcceptanceDraft(task,principalContext) -> draft`; `setCoassignees(draft,ids) -> draft`; `assignDraftSubtask(draft,id,userIdOrNull) -> draft`; `needsAllocation(draft) -> boolean`; `openTaskAcceptance(task) -> committedResult|null`. The draft emits no request before Confirm. `needsAllocation` is true exactly when extra co-assignees exist and ordinary subtasks exist.

- [ ] Write failing draft tests for all four helpers/subtasks combinations, one pool per selected assignee plus Unassigned, assigning none, clearing a removed helper's draft allocations, preserving existing ownership, no duplicate member/child selection, and Cancel producing no mutation payload.
- [ ] Write browser tests for human self, device recipient picker, real temporary sign-in, grant denied explanation, opt-in helper permission, member selection, drag/drop and equivalent select controls, Back/Cancel/Escape, duplicate Confirm prevention, focus restoration, held-response Retry, conflict recovery, and expiry while the wizard is open.
- [ ] Run `node --loader ./test/test-browser-loader.mjs --test test/test-task-acceptance-draft.js` and `node --test test/test-task-acceptance-browser.js` using isolated fixtures; confirm failures.
- [ ] Implement the wizard with existing child-modal/history conventions. Preserve one operation ID across network retry; regenerate it only after a deliberate new confirmation with changed payload. Fetch current authorized state on conflicts. Integrate ordinary task cards in an independent Notes-adjacent section and Tasks filter; do not serialize task IDs/content into note persistence.
- [ ] Run new browser tests at phone/desktop/touch viewport sizes, keyboard-only and both themes; capture evidence. Run existing task card/modal/device editor/Notes privacy browser regressions. Commit `feat: add open task board and optional helper allocation flow`.

### Task 5: Isolated release gate and handoff

**Files:** Add Phase 3 release report/runbook and any missing suite registration.

- [ ] Run new acceptance suites and existing tasks, scope/visibility, skills/availability, assignments, supervision, revisions, rewards, expiration, recurrence/rotation, device/privacy, Notes and schema/isolation suites in isolated containers. Record exact commands, counts, baseline failures and candidate results.
- [ ] Run populated synthetic encrypted migration/restart and two-device plus signed-in-client convergence scenarios. Inspect actual database/event/point outcomes after races and failures, not only HTTP responses.
- [ ] Review final code against both specs, including no default grants, no private Notes regression, and no loss of Phase 1 independent Notes permissions. Fix defects and rerun affected gates.
- [ ] Commit release evidence and return candidate commit/image digest, test evidence, capability activation status (off unless separately authorized), and unresolved limitations. No production deployment or grants are changed; parent retains release hold and exact target selection.
