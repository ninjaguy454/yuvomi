# Phase 3: Open tasks alongside Notes

Status: requested scope and bounded helper capability design approved by parent; written-plan review, if required by the execution workflow, is consolidated for later and must not interrupt Phase 1. Depends on accepted Phase 2 and Phase 1's final device contract. No implementation or grant activation performed.

## Intent and constraints

Show ordinary unassigned tasks as offers that household users can accept, optionally with co-assignees and optional subtask allocation. Do not introduce a task type, bounty flag, parallel task model, alternate points, or completion path. Keep task visibility, eligibility, parental/supervisor approval, household isolation, recurrence, points, and existing device authentication semantics.

The release order is Phase 1 paired Notes, Phase 2 canvas/privacy, Phase 3 open tasks. No further live deployment until the parent explicitly lifts the hold after the user returns. Background implementation may use isolated test containers after Phase 1 finishes. Never modify live household data, device grants, configuration, services, or the urgent worker's checkout.

Use Node >=22, vanilla JavaScript ES modules, existing CSS tokens/components, and existing vendored frontend utilities. No framework, bundler, runtime CDN, or new frontend package. Migrations are append-only; the test schema must match. No new grants are activated by default.

## Existing integration points

- `server/services/assignment-responsibilities.js::claimTask` currently requires `task_assignment_context.strategy='open_claimable'`, validates activity/explicit eligibility, applies responsibility, and reconciles supervision.
- `server/services/device-tasks.js::deviceTaskClaim` wraps claiming in an immediate transaction, checks task/parent revisions, scopes recipients, and records device source with no fabricated actor.
- `server/services/task-access.js`: human and device visibility/capabilities, self-claim exception, separate assignment/reassign grants.
- `server/routes/tasks.js::setAssignments`: child assignment changes also maintain `subtask_assignee` responsibilities and parent participants. Extract and reuse this behavior rather than manually writing only assigned_to.
- `server/db.js`: task revisions include assignment/responsibility changes and propagate child revisions to ancestors.
- `server/services/task-scope.js`: structural and household-local start visibility.
- `public/components/device-task-claim.js`: existing picker states that recipient selection never signs them in.
- `public/utils/task-card-drag.js`, existing modal and task state utilities: touch gestures, child modal history, revisions and optimistic UI.

## Presentation and authoring

Keep Notes and Tasks permissions independent. Add an Open tasks section alongside the Notes canvas on wide displays and above it on phones, only when Tasks is readable. Reuse ordinary task cards and task details. Task offers are not note records and do not share note geometry storage. Provide the same Open tasks filter in Tasks. Do not grant Notes permission as a prerequisite to normal Tasks use.

Create an offer using the existing task editor with an empty assignee selection. The author needs tasks.create and existing grants for any points, skills, scheduling, or other protected fields. Device creation remains an administrator opt-in under existing task capabilities; initial device presets gain nothing. Regular task edits immediately affect board membership.

The query uses canonical effective assignment state, including assigned_to, task_assignments, and operational responsibilities, not just a nullable legacy column. Include authorized, active, top-level regular tasks with no assignees. Apply start visibility and exclude archived/done/expired records, standalone children, and generated supervision/helper projections. An overdue task that is still active under its normal expiration policy is not automatically excluded.

Explicit activity/planning/rotation policies remain authoritative. Open-claimable activity/planning tasks retain their existing candidate requirements. An unresolved fixed/round-robin task is not a freely assignable offer. Read projections must not create assignment contexts or obligations. Private/selected tasks are shown only to their existing authorized viewers; restricted users with view_own do not automatically receive view_household.

## Acceptance flow

1. Tap an offer, see normal task details, choose Accept.
2. Human/temporary-human principal: primary recipient is the authenticated user. Device principal: ask Who accepts? using only current allowed household recipients. No selected recipient establishes session identity.
3. Ask whether helpers/co-assignees should be added. The optional selection UI uses household members intersected with device scope and canonical eligibility. Use the label Co-assignees in stored responsibility semantics; these are not automatically supervisors.
4. Only if at least one additional co-assignee is selected AND ordinary subtasks exist, show a second allocation screen: one rectangle per selected member including the primary, plus an Unassigned pool. Without either condition, proceed directly to the final acceptance confirmation.
5. Each subtask can move by drag/drop or an Assign to select/menu. All newly allocatable tasks begin in Unassigned. Any preexisting assignments are displayed and preserved, never silently cleared; assigned/protected work is not offered as free to move. Server eligibility remains authoritative.
6. Confirm once. All subtasks may remain Unassigned. This means no explicit assigned_to/task_assignments records for them; normal inherited parent responsibility continues. Do not add a special unassigned execution mode.

Back preserves the local draft. Removing a selected helper returns locally allocated steps to Unassigned before confirmation. Cancel, Escape, modal Back, or identity expiry discard the draft and write nothing. A lost network response retains the same operation ID for Retry. A stale/conflict response reloads current authorized state and requires another deliberate confirmation; it does not silently move to a different recipient or task.

## Approved design: bounded helper authority

Current tasks.claim allows self-claim; adding other members normally requires tasks.change_assignment and tasks.reassign. Requiring those broad rights would prevent the requested helper flow for ordinary restricted users and many paired devices. Do not silently omit that flow or broaden general reassignment rights.

Use two explicitly opt-in capabilities: `tasks.accept_with_helpers` for humans and `device_tasks.accept_with_helpers` for devices, both default none. Parent approved this implementation design. These supplement existing claim authority, never replace view or claim checks. Existing full assignment authority can also authorize the helper portion. Do not change live or default profiles. Activating either capability for any live user/device requires separate explicit permission approval; exact production targets are not known here.

The narrow capability permits only adding validated co-assignees and allocating currently unassigned, ordinary editable subtasks as part of this single initial acceptance of a still-unassigned task. It cannot reassign/remove existing people, change definitions, grant task visibility, alter skills or points, change a recurrence series, clear progress, assign protected supervision counterparts, or modify any task outside this acceptance snapshot. Human primary remains self. Device primary/helpers must all be in current device scope. Existing strict assignment policies must independently permit the action.

Without authority, still show the helpers choice with a clear permission explanation and the existing path to real authorized sign-in; solo acceptance remains available where claim is allowed. Do not preselect new grants. The UI must distinguish a temporarily authenticated account from a device's recipient picker. Current temporary sign-in supports administrators; this work does not expand it to arbitrary household member sessions.

## Canonical acceptance service

Introduce `server/services/task-acceptance.js`, shared by both adapters. Suggested mutation payload:

`{operation_id, expected_revision, expected_parent_revision?, primary_user_id?, coassignee_ids:[], subtask_snapshot:[{id,revision}], subtask_assignments:[{id,user_id:null|number}]}`

Device may supply primary_user_id; human requests must omit it or match authenticated self. Reject unknown keys, duplicate IDs, duplicate member roles, malformed revisions, subtask IDs outside the current parent, members outside the selected set, and assignment of protected/already assigned/completed work. Limit payload size using current task editing limits. Empty subtask_assignments is valid and never creates assignments. Include the complete allocatable child snapshot so additions/deletions cannot be silently missed.

`acceptTask(d, principal, taskId, body) -> {task, receipt}` uses one immediate transaction. Re-resolve current authority/device lease, task visibility, policy, revision, complete child snapshot, current unassigned state, household membership, skills, presence/availability, and supervision before writing. Use the existing activity claim path for policy-backed tasks and a deliberate ordinary-task branch for tasks without managed policies. Do not fabricate task_assignment_context or planning obligations simply to make existing claim code accept a regular task.

Apply parent primary/participants and explicit child allocation using shared assignment helpers; preserve source=subtasks participants and established beneficiary/supervisor responsibilities. Validate all submitted snapshots before mutation-generated revision bumps. Reconcile canonical supervision after the complete proposed assignment, then validate the resulting qualifications. Any failure rolls back all changes, events, and transactional notification/outbound records. External deliveries occur only after commit.

Acceptance keeps the normal open status; it does not start or complete work, award points, duplicate history, advance rotations, or alter future recurrence definitions. Protected execution retains the current real authentication/approval path.

Concurrent claimants serialize at the transaction boundary and recheck the unassigned predicate; exactly one succeeds. Preserve a principal-scoped operation receipt containing request hash and canonical result reference, not cached private payload. Same ID/different payload conflicts. On retry, reauthorize and project current permitted data. Scope device receipts to device plus auth context; returning from temporary identity cannot replay that user's receipt as a device. Revoked principals cannot replay. Emit task invalidation only for committed change.

## Tests and release boundary

Test all four helpers/subtasks combinations, zero allocation, selective allocation, one pool per member plus Unassigned, accessible non-drag operation, and Back/Cancel/Retry without premature writes. Test normal human, temporary human, device picker and restricted profiles with the new grant off/on. Test stale parent, changed/added/deleted child, expired task, concurrent member deletion, reduced scope, malicious unrelated child IDs, policy-managed tasks, double claim, duplicate retry, and transaction rollback.

Regress regular task permissions, skill/presence qualification, one-helper/delegated supervision, points and parental approval, completion/reopen, recurrence/rotation, notifications and source attribution. Notes privacy and the Phase 2 rollback barrier remain in force.

No live grant changes or release occur from this plan. The bounded capability contract and requested scope are approved for implementation. Any mandatory written-plan review is consolidated for later; do not interrupt urgent Phase 1. Wait for the actual final Phase 1 commit before selecting the implementation baseline. Live capability activation remains separately unapproved.
