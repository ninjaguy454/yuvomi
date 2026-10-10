# Approved occurrence skipping implementation

Goal: excuse one materialized local calendar recurrence for all assignees, preserving history and earnings, with no Undo and no live data changes.

Spec: `docs/superpowers/specs/2026-10-07-task-skip-occurrence-design.md`, approved by Duane on October 10. Baseline: `62329fa9d40819a80fab65ec1fe5087179e209be`; document commit: `93442ee63021d06e29e596c2d740e29a4ae463d6`. Remote main and running container revision verified October 10. Execution is authorized now; no additional design or execution approval is required.

Architecture: append-only SQLite status migration, dedicated immediate transactional command with principal-scoped receipt, existing recurrence adapter using a calendar anchor, shared closure guards, explicit history and client action. Tech: Node 24, Express, encrypted SQLite, vanilla browser modules. No new Task type, health/reason data, grants, integration support, per-person excusal, or deployment. Preserve pending card/theme work.

Review focus: (1) permission and unsupported scope escape, (2) reward/progress resurrection, (3) nominal recurrence/frontier duplication, (4) atomicity/idempotency/recovery, (5) stale consumers and migration preservation. Owned by new API/lifecycle, consumer, recovery/race, migration and browser tests respectively.

## Task 1 — durable command and calendar continuation

Write API tests first in `test/test-task-skip.js`: real routed operation, partial earnings, all-assignee closure, future anchors, replay, stale revision, authorization and excluded modes. Watch intended failures. Add `task-skip-schema.js`, `task-skip.js`, migration 10054 and mirror, dedicated route, default-none capability. Extend shared window/reward/terminal/frontier/series preservation contracts, using a no-completion anchor. Verify new tests and adjacent lifecycle/series suites. Commit.

## Task 2 — history and all consumers

Write consumer tests first for history, expired correction, helper refresh, obligations, active/default reads, reminders and queued delivery. Add skipped ancestry to shared guards, projections and active queries; preserve historical records. Extend occurrence feed without changing completion IDs/cursors. Verify consumer and existing expiration/permissions/helper suites. Commit.

## Task 3 — reviewable client action

Write behavior tests first for confirmation/cancel, request identity, terminal controls, status/history and permissions. Add Task Details action using existing confirmation and participant display; no new selector or Undo. Update client status contract, terminal controls and OpenAPI. Verify browser and adjacent UI behavior. Commit.

## Task 4 — recovery, races, migration and independent review

Exercise synthetic encrypted upgrade, foreign keys/triggers/indexes/high-water mark/restart, injected materialization failure then worker retry, aligned-clock separate-connection races and timezone boundaries. Run canonical `npm test` and report every observed inherited failure. Obtain a fresh independent reviewer of spec and diff, fix actionable findings with failing tests and rerun affected checks. Produce commit/tree/archive hashes and handoff with commands, results, rollback caveat and blockers. Do not publish or deploy.

Use only synthetic temporary databases. Keep test evidence in workspace. Existing race fixture has a known parent/worker clock mismatch; distinguish it from candidate regressions. Inline implementation follows the executing-plans skill; final independent review is explicitly requested.
