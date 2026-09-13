# Household Task visibility audit and fix — 2026-09-13

## Outcome

The reproduced disappearance occurs in **Kanban**, after the authenticated Tasks API returns the correct Task. The normal List view already shows it.

Two bounded runtime changes fix separate presentation/search exclusions:
- Kanban keeps the API-authorized rows instead of silently restricting non-Wall devices to the current assignee.
- Search uses the canonical Task visibility/capability predicate without an additional creator/primary-assignee restriction.

No schema, lifecycle, assignment, supervision, revision, live-event, Reader or Wall policy changes were made. This work is local and has not been pushed or deployed.

## Production evidence

A matching current production record is Task **114 — Put chairs back at table**:
- Creator/current creator viewer: Duane Severson, user 1.
- Assignee: Eleanor Severson, user 5; task_assignments also contains only user 5.
- Persisted visibility: all.
- Status: open (Not Started); start/due date: 2026-09-13; not archived; nonrecurring.
- Both users have the Tasks module enabled and tasks.view_own / tasks.view_household allowed.
- Canonical taskCapabilities.view is true.
- Actual authenticated HTTPS GETs for the normal active list, Kanban query and detail returned Task 114 for **both users**.

The historical HTTP creation packet for Task 114 was not retained. An equivalent real UI creation was captured on an isolated copy of the deployed image and fresh supported encrypted database snapshot. The copied Task 114 itself also reproduced the creator/assignee board discrepancy.

Production was accessed only for read-only Task/API inspection and a supported database snapshot. No production Task or permission was repaired or modified.

## Complete disappearance trace

| Step | Actual result |
| --- | --- |
| Creation UI | Blank Task, fixed Eleanor assignment, All family members, zero points, no recurrence. |
| Browser POST | assigned_to:[5], visibility:all, assignment_mode:fixed; no start/due boundary on the synthetic example. |
| Creation response | HTTP 201; synthetic baseline Task 117 persisted creator 1, assignee 5, all, open, no parent/archive/recurrence. |
| Database | Correct visibility and assignment junction; no reconciliation changed ownership. |
| Viewer/capabilities | Duane creator and Eleanor assignee are both authorized household viewers. |
| Canonical predicate | visibility='all' passes the row audience; tasks.view_household permits either viewer independent of assignment. |
| List API/query | GET /api/v1/tasks?archived=1 returned Task 117 to both actual browser requests. No assigned_to, owner, creator or status restriction was present. |
| Frontend receipt | Sanitized proxy capture of the actual response delivered to each browser includes Task 117. loadTasks assigns data.data to state.tasks. |
| Frontend search | Empty; therefore filteredTasks returns all received rows. |
| **Discard point** | **boardTasks** on a non-Wall device retains only claimable work or taskParticipants containing the current viewer. Eleanor passes; creator Duane fails. |
| Live synchronization | Both existing streams receive the same change event; both reload and receive the Task. The old board predicate discards it again for Duane. |
| Refresh | The old creator Kanban still hides the Task; switching to List shows it. |
| Fixed result | The same API audience appears in Kanban, after creation/live reload and after a page refresh. |

Responsible old predicate in public/pages/tasks.js:

```js
if (state.boardScope !== 'personal') return tasks;
return tasks.filter(task => canCheckAndClaim(task)
  || taskParticipants(task).some(user => Number(user.id) === Number(state.currentUserId)));
```

deviceTaskBoardScope selects personal whenever the device Wall preference is off. It is a layout choice, but the code incorrectly turned it into an implicit assignment filter.

Lineage: this board restriction and device scope were introduced in ae1acec4c, “Redesign Tasks module and add schedule view” (2026-08-30). Recent permissions/latency hardening did not introduce it. The later claimable exception did not make the general household audience correct.

## Search consistency defect

server/services/search.js added:

```sql
AND (t.created_by = @userId OR t.assigned_to = @userId)
```

before taskVisibilityWhere. It excluded an authorized household viewer and even secondary assignees recorded only in task_assignments. The canonical predicate already expresses both audience and capabilities. Only this redundant Task conjunct was removed; Search's module and other-entity rules are preserved. The obsolete conjunct dates to upstream 02939dbdc (June 3), not recent Wall privacy work.

## Canonical semantics and surface audit

- all: any authenticated household viewer with Task module access and tasks.view_household may view, regardless of assignment.
- assignees: creator plus explicitly assigned members, subject to capabilities/module access.
- private: creator only; assignment and administrator role do not override row privacy.
- view_own without view_household: only the existing creator/assignee/inherited responsibility or valid supervision audience; public household visibility alone does not grant an own-only account every Task.
- Module denial remains a ceiling. Read-only module access can permit viewing while denying mutations.
- Explicit list filters remain choices that narrow an already authorized audience.

| Surface | Result |
| --- | --- |
| Tasks List / compatibility list | Canonical backend predicate; assignment only filtered when explicitly requested. |
| Kanban | Fixed: same API-authorized audience; preserves grouping, sorting and explicit filters. |
| Task details / deep links | Canonical predicate; unauthorized private/assignee-only requests remain denied. |
| Dashboard | Canonical predicate plus active/date/category/aggregate presentation scope. |
| Search | Fixed redundant ownership conjunct; canonical audience and module gating remain. |
| Calendar Task projections | Uses authenticated /tasks?include_future=1, then dated/unfinished/nonarchived projection rules. |
| Notifications/deep links | Canonical Task authorization; linked parent is separately authorized. |
| Reader | Canonical Task predicate and existing module/own-only checks. |
| MCP / alternate automation APIs | Existing canonical Task authorization remains unchanged. |
| Wall | Existing authenticated Dashboard audience and read-only presentation unchanged; see important limitation below. |

### Wall audit limitation

Wall device preference contributed to the **ordinary board layout/audience coupling**. No Wall-specific SQL privacy predicate was accidentally reused in normal Tasks authorization.

The current Wall dashboard renders the signed-in account's authorized Dashboard Tasks read-only. Source inspection did **not** find an independent all-only/shared-public Task-row policy. An account's own private Task can therefore be part of that account's Dashboard/Wall input. Existing stricter shared-device privacy covers notification/push suppression and cleanup, not a distinct public-only Task audience.

This fix neither weakens nor invents a Wall Task privacy policy. Wall/notification/privacy files are unchanged; existing read-only Wall and notification privacy regressions pass. A requirement that Wall exclude even the signed-in owner's private Tasks would need a separately defined Wall presentation policy; it is not claimed as existing protection.

## Filters confirmed

- Normal active List defaults include open and in_progress.
- Kanban uses status columns, including its archive column, rather than reusing the List status filter.
- Future start_date is intentionally hidden in default List/board scope. Show scheduled sends include_future=1; Calendar asks for future Tasks explicitly.
- Due dates alone do not make a Task private or hide it until due.
- Explicit Assigned to me / person filters still narrow the server query; clearing them restores other members' authorized Tasks.
- Creator, Activity Template, recurrence and supervision state add no implicit normal-list ownership restriction. Structural subtasks and helper projections retain their existing scope rules.
- Archived/deleted state and text/tag/priority/category filters retain their existing behavior.

## Validation

**238 automated runner checks passed, 0 failed, 0 skipped**, across 17 targeted files. This includes **27 added regressions**: 10 frontend audience/filter cases, 11 real HTTP creation/visibility/capability cases, and 6 Search HTTP cases. Existing script-style suites also report their own embedded checks; they are not double-counted here.

Regression sensitivity:
- Six new frontend cases fail against the old board predicate, then all ten pass with the fix.
- Four new Search cases fail before removing the redundant conjunct, then pass afterward.

Actual Chrome QA used two simultaneously authenticated isolated household users, Duane and Eleanor, on independent loopback cookie origins. Four baseline scenarios established the defect and eight fixed-build scenarios passed:
- Existing copied Task 114 and UI-created Task 117: old creator board hides them; Eleanor sees them.
- Old creator refresh still hides; old List shows them.
- Fixed board shows previously missing work.
- New UI-created Task 118 appears on both already-open boards without manual refresh.
- Both reloads retain the same audience.
- Active private Task 121 remains creator-only despite Eleanor assignment.
- Assignee-only Task 122 appears for creator and Eleanor.
- Future Task 123 follows Show scheduled; In Progress Task 120 appears in its expanded status section.
- Explicit Assigned to me hides Eleanor's Task; clearing it restores it.

For Task 118, the actual containing list responses arrived approximately **598 ms for the creator and 1169 ms for Eleanor after the creation response**, with matching live change version 10018. These are response timings, not pixel-paint percentiles.

Existing permissions, Reader, Dashboard, Task revisions/security, response-cache isolation, Task detail/optimistic UI, calendar/scope, notification center, push-client privacy and service-worker privacy suites are included. No full repository-wide test claim is made.

Evidence: ignored .qa/task-visibility-20260913/ contains sanitized real request/SSE logs, baseline/final database projection snapshots, trace-summary.json and regression.log. Production read-only API evidence is .qa/visibility-production-api.json. The fresh supported source snapshot is C:\Yuvomi\backups\tasks-visibility-preview-20260913.db. QA-only fixtures, test credentials and instrumentation are not part of the application or commit.
