# Task creation and morning routines

Activity Templates can preserve optional start and due times, a recurrence rule,
the repeat-from-completion choice, expiration policy, assignment, and checklist
requirements. Dates belong to each Task occurrence. Times use the existing
household-local scheduling and DST handling. A due datetime before the start
datetime is rejected without discarding the draft.

For a weekday morning routine, use 07:00 start, 08:00 due, weekly Monday through
Friday, **Expire incomplete**, and leave **Repeat from completion** off. A missed
occurrence expires for zero points and the next scheduled occurrence keeps its
calendar anchor. This refinement does not change expiration semantics.

## Required and optional actions

Existing subtasks remain required. Optional is persisted on both Task subtasks
and Activity Template checklist items. Progress counts required actions separately
from optional actions. Completing every required action can complete the parent
even when optional actions are still open. An all-optional checklist requires an
explicit parent completion; it does not complete itself on creation.

An optional action retains its skills and follows the normal supervision rules
when performed. Its unresolved supervision does not block the parent, and its
requirements do not prevent allocation of help for required actions. Once the
parent is complete, optional actions are closed to further completion or reopening
until an authorized user explicitly reopens the parent. Existing completion and
points idempotency rules still apply. Expiration terminates pending work, including
optional supervision, without completion points.

Duplication, template creation, and recurrence preserve each requirement flag and
skill mapping. New occurrences receive fresh completion state. Dragging by a
subtask's dotted handle moves the existing row and its metadata. Touch requires a
brief hold on the handle; scrolling over the rest of a row does not initiate drag.
The actions menu provides keyboard reordering and announces the new position.

## Assignment and template values

Fixed templates display their assignee. An override is accepted only when the
template and the editor's existing permissions permit it, and is retained on the
Task's Activity binding. Assignment is validated by the existing eligibility path.
If a template later disallows overrides, future recurring occurrences resume its
current assignment policy; the prior occurrence retains its assignment history.

For the contextual `assignee` household-member variable only, an unconfigured
reusable value (no default and no expression) is supplied from the Activity's
resolved assignment. This fixes templates whose hidden Assignee value otherwise
blocked creation even after a member was selected. Authored defaults, expressions,
other variables, and explicit inputs retain their existing meaning. Preview does
not advance assignment or change Task lifecycle state.

The existing random-assignment preview can select a different eligible member
from final materialization. That broader preview behavior is unchanged; fixed and
subject-based assignment are covered by the morning-routine acceptance checks.

Saving a template refreshes the current picker while retaining the Task draft.
Selecting the new template subsequently uses the normal template-switch rules.
Creation errors appear in an announced summary and toast, with focus and scroll
directed to the first relevant field. Validation alone does not dirty the form.

## Migration and focused checks

Additive migration 10036 stores subtask requirements, reusable template timing and
recurrence, and authorized assignment overrides. Migration 10035 is unchanged.

Run `npm run test:task-morning-routines` for targeted backend and pure UI coverage.
Run `npm run test:task-draft-ui` and `npm run test:task-requirements` with a supported
Chromium browser for desktop/mobile creation, error focus, template refresh, mouse
drag, touch drag, and scroll checks. `npm run test:task-expiration` covers the
existing expiration, recurrence, race, permission, and historical-display paths.

The morning acceptance fixture uses Eleanor, two points, nine required actions,
and optional **Put in earrings**. It verifies required completion awards two points
once, expiration awards zero, and the next weekday starts with fresh actions and
the same 07:00–08:00 window.
