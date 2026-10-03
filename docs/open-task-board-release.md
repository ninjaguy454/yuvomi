# Open task board: isolated release record

This candidate follows the Notes privacy/canvas release. Base dc9adab80f2b35a577a36c051a1ebb63e520fc23 includes the complete Phase 2 source, including its final device-audience explanation correction. Schema 10050 adds acceptance receipts. No production deployment, data changes, permission grants or service restarts are authorized by this artifact.

## Behavior and authority

Open tasks are regular unassigned eligible root tasks. Existing creators can author them by leaving assignees empty; no new task type or authoring permission is introduced. They appear beside Notes with independent Tasks authorization and in the Tasks open filter. Normal task details open before acceptance.

Signed-in people accept as themselves. A paired display selects only eligible members within its existing scope. This picker never authenticates a person or creates personal rights. Optional helpers require existing full assignment authority or the new bounded tasks.accept_with_helpers / device_tasks.accept_with_helpers capability. Both new grants default to none; no production profile has been enabled.

Allocation appears only when helpers are selected and subtasks exist. Every selected assignee and Unassigned has a pool; drag and equivalent selectors are supported. Confirming no allocations leaves subtasks in their normal unassigned state. Existing protected or assigned child work is preserved.

Confirmation rechecks current authorization, skills, availability, task and child revisions and complete authorized child membership in one immediate transaction. Parent assignment, selected child assignments, event/outbound records and a context-bound receipt commit together. Retry reauthorizes before receipt lookup and returns a fresh canonical projection. Two competing claims produce one winner; identical concurrent operations produce one commit and one replay. Generic HTTP idempotency caching is bypassed for acceptance, including encoded route identifiers.

## Verification and boundaries

Tests use synthetic encrypted databases or memory databases and isolated Docker containers with no network and no live mounts. New suites are registered as test:task-acceptance and test:task-acceptance-browser. The real-app browser fixture uses actual routes, authentication, pairing and database writes; it disables service-worker installation and emulates online status for loopback operation. Separate suites verify service-worker caching and updates.

Real-app evidence covers solo acceptance without helper authority, a narrow helper grant with partial child allocation, and a real paired display confirming zero allocations while remaining a device. Assertions cover assignment rows, three unique receipts, no reward ledger entries and database integrity. Screenshots cover phone and paired display pools.

Independent review found missing start-time refresh metadata and offer filters bypassing existing Tasks chips. Both were corrected and rechecked, including a real browser regression proving an upcoming offer appears without an event or navigation. The board reads the canonical visibility envelope. The integration walkthrough also found missing offer metadata in ordinary task detail; that defect was fixed with a route regression. Independent re-review reports no remaining blockers.

Broad regression result: 251/258 checks pass. Seven failing test-runner entries were reproduced on the unchanged Phase 2 baseline: three existing suite-chain registration guards, three recurring-subtask skill fixtures, and the legacy Tasks static runner (19 internal passes, two old markup assertions). The API/idempotency run passes 25/26, with the existing taskRevision ReferenceError also reproduced on unchanged Phase 2. Earlier Phase 1/2 full-suite, locale and schema limitations remain documented in notes-canvas-release.md and local evidence. These failures are not represented as passing.

Additional preservation checks pass 107/110 (rewards, recurrence frontier, start visibility, household scope, delegated lifecycle, schema, API and precache). All three failures are legacy task-reliability VM/static extraction fixtures, reproduced unchanged on Phase 2. Registered acceptance browser tests pass 16/16, including the actual encrypted app. Phase 2 Notes backend tests still pass 38/38. Frontend worker checks pass 41/41 with six scoped guards, covering touch/mouse allocation and existing Notes/device behavior.

Registered acceptance backend and draft suite passes 33/33, including all 24 backend acceptance checks, capabilities, encrypted migration and draft rules. Final exact source/image identifiers and remaining scoped suite counts are recorded in the parent workspace release JSON after freeze. Counts overlap and must not be summed.

## Release and recovery

The parent controls deployment approval, order, target and household capability activation. Deploy Phase 2 and verify stability before considering Phase 3. There is no authorized automatic deployment in this work.

Retain a fresh encrypted backup before any eventual schema change, and preserve the Phase 2 privacy rollback barrier: never run Phase 1 or older code against private/selected Notes data. No stale database restore should overwrite later household writes. Phase 3 does not alter task semantics; receipts add durable retry history. A Phase 3 presentation fallback must retain its server authorization and receipts as well as Phase 2 Notes privacy. No backward migration or live rollback has been attempted or certified here.

