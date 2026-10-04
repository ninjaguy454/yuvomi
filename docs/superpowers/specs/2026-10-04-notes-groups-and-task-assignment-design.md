# Notes groups and avatar assignment

Written design for user review, 4 October 2026. The conversational design is approved; this document and its proposed defaults still need written review. The accompanying pictures are static proposals, not implemented screens. No grouping or avatar-interaction code, live deployment, or permission changes are authorized by this document.

## Purpose and release boundary

Make the Notes canvas easier to organize on phones, computers and paired displays, then simplify the optional subtask assignment step when accepting a regular open Task. Keep existing content, privacy, task eligibility, points and approval rules. Release order remains normal paired Notes, the Notes canvas release, then open Tasks. Further live releases remain on hold until the parent confirms scheduling with the user.

The two changes have separate implementation boundaries: persistent Notes groups, and the existing acceptance dialog's avatar interface. After written-design approval, each needs a reviewable implementation plan before execution. The earlier rectangular assignment pools are superseded by the avatar interface described here.

## Notes groups: approved behavior

Drag a movable note onto a position-pinned note to create a group. The pinned target initially becomes page 1 and supplies the group's anchor, position pin and Always on top state. Initial size is proposed below. Two ordinary unpinned notes may overlap without becoming a group. A pinned standalone source must be unpinned before it can be dragged.

The group owns its position, size, pin and layer independently of its pages. Reordering the original target or choosing another page never moves the group. Show `< 1 / 2 >` just above its top-left corner: arrows change the displayed page, and the page count opens the overview. Reserve room for these controls at canvas edges without rewriting saved geometry.

The overview shows authorized notes in row-major order over a blurred board, with clear space above the notes and a reachable exit area. Tap outside to close; tap a note to display that page. Hold and drag to reorder. Icon-only multiselect has accessible names and selected states. A selected block keeps its original relative order: selecting 2, 5, 7 and 9 from 1–10 and inserting at position 3 produces **1, 3, 2, 5, 7, 9, 4, 6, 8, 10**.

Dragging into the exit area for roughly one second closes the overview while keeping the same drag alive on the canvas. Nothing is saved at that point. A single note dropped on the canvas becomes an unpinned, movable note there. Dropping several notes offers **New group / Individual notes / Cancel**. A new extracted group starts unpinned and movable; individual notes do too. Cancel restores the draft with no write. Hovering over an existing group briefly opens its overview so the block can be inserted there, including back into its source group.

A newly created group on a pinned target starts pinned. Unpinning it allows the whole group to move without dissolving it; pinning locks its chosen placement. Old hidden member locks never prevent intentional extraction. These position pins are separate from each note's **Show on Dashboard** setting, which grouping does not change.

When only one actual member remains, dissolve the group and **keep the survivor where the group is**. Never restore its old pre-group position. Removing or reordering the original target does not otherwise destroy the group. An empty group has no remaining container to display or retain.

## Small defaults proposed for written review

These fill gaps in the approved interaction; they are proposals, not previously approved details:

- A group formed on a pinned target starts at that target's size. A lone survivor keeps the group's size, position-pin state and Always on top state, preserving its appearance at the agreed anchor. This is distinct from a note actively extracted, which always becomes unpinned.
- Extracted notes and a new extracted group start at the source group's displayed size and Always on top tier. Their pin is cleared. Individual bulk placement previews a compact arrangement around the drop point in selection order; confirmation saves exactly that preview.
- Groups contain notes, with one group per note and no nested groups in this release. “New group” from an extraction means a new group of the selected notes. Whole-group unpin/move remains available.
- Page arrows stop at the ends. A short, approximately 400 ms intentional hover highlights a grouping target or opens a destination overview; leaving cancels it. The exit dwell remains approximately one second. Tune touch tolerance during testing without changing the commit boundary.

## Persistence, access and recovery

Notes remain their existing records. Content, audiences, creators and dashboard pins are preserved. Add an independent group rectangle and an ordered membership relationship; do not infer membership from overlapping rectangles or make the original target permanently own the group. Membership, order and group layout persist across devices. Active page, overview and selection are local view state, cleared with the authentication context.

Authorize notes before returning titles, previews, counts, numbering or canvas extents. Mixed-audience groups show only the current viewer's authorized notes with dense numbering. Zero visible members means no displayed group; one visible member looks like a single note without revealing a hidden total. This projection must never dissolve a larger stored group. Paired displays retain their existing Everyone-note visibility and device capabilities; selecting a person elsewhere does not unlock private notes.

Structural changes require existing view/edit authority for every canonical member affected. The server returns only whether the action is available, without explaining hidden membership. A partially visible group can be browsed but cannot be structurally changed through a projection that omits affected notes. Individual content and dashboard-pin actions keep their existing per-note checks; changing an audience keeps its existing author-only rule. Grouping grants no new ownership or visibility.

Create, reorder, transfer, extract and dissolve operations validate current authority and revisions, then save membership and affected layouts in one transaction. A note cannot be duplicated between groups or disappear in a half-finished move. Concurrent stale changes fail as a whole; reload the authorized state before another deliberate action. An uncertain network result retries the same frozen operation identity. Cancel before submission writes nothing; an already committed operation is not silently reversed. Undo rechecks present permissions and revisions instead of restoring an old snapshot.

Permission changes or sign-out cancel active gestures, previews and pending dialogs and remove inaccessible content. Live updates remain payload-free invalidations. Do not persist private group snapshots in browser storage. Search/filter projections remain browsable; arranging uses the full authorized board, consistent with current canvas behavior.

All actions have keyboard/menu equivalents: choose a destination group, choose an order position, remove selected notes, and place/move/resize without dragging. Touch scrolling, Escape, pointer cancellation and focus restoration work without accidental writes. Narrow/list layouts retain accessible page and overview controls. Viewport fitting never silently changes saved positions; list access and bounded placement keep every authorized note reachable. No instructional paragraphs are required inside these interfaces.

A recovery build must understand the grouping schema and preserve stored relationships. It may show a flat authorized list and disable grouping edits. Do not use an older writer that can overwrite grouped geometry or flatten membership. Dashboard continues to display individual authorized notes under its existing rules.

## Open Tasks and avatar assignment

**Bounty Tasks** shows ordinary, active, eligible top-level Tasks with no effective assignees. It introduces no task type or alternative points/completion model. Keep the exact subtitle: **Take on these tasks and earn extra points when you finish them!** The board sits alongside Notes on wide displays and above the canvas on phones when Tasks is readable. The same offers remain accessible through Tasks; Notes permission is not required for normal Tasks use.

Authors use the existing task editor and leave assignees empty. Existing `tasks.create` and protected-field permissions govern authoring; paired creation stays an existing administrator opt-in. Effective assignments, visibility, availability, start/expiration rules, managed assignment policies, skills and supervision determine offers. Do not expose private tasks, generated supervision actions, standalone subtasks or fixed/rotation work as freely claimable offers.

Accept opens the normal task details and acceptance flow. A signed-in person accepts as themselves. An unsigned-in paired display first asks **Who accepts?**, using only currently permitted eligible recipients. That selection is identification for this operation, not sign-in or private access. Then offer optional helpers/co-assignees under existing assignment authority or the explicitly opt-in bounded accept-with-helpers capability. Do not enable live grants automatically.

Show the subtask assignment screen only when **at least one helper is selected AND subtasks exist**. Its top strip contains the accepting person and selected helpers. Each subtask stays in a stable row with one round assignment target: a dotted `?` when unassigned, or the selected person's avatar. Drag an avatar onto a target to assign; dropping onto an assigned target replaces its one draft assignee. Existing protected or already assigned steps remain unchanged.

Tap a target to choose a permitted person or **Unassigned**. Choices show an already-authorized photo or initials/color fallback and first name plus surname initial. Duplicate rendered names use authorized age in parentheses, otherwise username; unique names have no suffix. Use the shared household formatter, never a subset-only collision calculation or a richer private-profile fetch. The name format applies to these chooser captions, not every name throughout the app.

Long-press an avatar opens the existing Task person card with only already-authorized supplied fields; provide a keyboard-accessible equivalent. Movement cancels long press, and opening the card never assigns a step. The card owns focus and closes before its parent dialog on Escape. No new photo, contact or date-of-birth permissions are added. Keep behavior-explanation paragraphs out of the allocation interface; retain meaningful labels, permission explanations and actionable errors.

Assigning none or only some steps is valid. Unassigned steps retain normal task semantics. Back keeps the local draft; removing a helper clears that helper's draft allocations. Cancel discards it. Final **Confirm** atomically claims the parent and saves selected child assignments after rechecking identity, scope, eligibility, all relevant revisions and the full child snapshot. Two simultaneous claims cannot both succeed, stale children cannot be partially assigned, and retries cannot duplicate a claim. Points, parental/supervisor approvals and completion behavior remain unchanged.

## Known identity-contract limitation

The integrated member-label endpoint returns only approved household identity fields and server-calculated age, without DOB. However, a paired device's roster is currently restricted to its member scope, so it cannot detect a duplicate name outside that scope. The identity-contract owner must resolve household-wide collision information before this design can claim the full name rule on scoped displays. Task candidate scope must remain unchanged. This is a contract gap, not permission to fetch private profiles or widen assignment rights.

## Implementation boundaries and verification

The existing `note-access` service supplies audience/capability checks; `note-board` supplies layout revisions and all-or-nothing bulk writes. Extend those conventions through a focused group service, rather than mixing group membership into note content. The canvas component owns gestures and projections; Notes owns requests and auth teardown. The existing acceptance service/draft already supplies optional assignment, one assignee per step, atomic claims and frozen retries; the avatar change should reuse that contract and a Task-local person-card presenter.

Use isolated branches and immutable test images, without live household data or production ports. Group verification must cover the exact ordering example, all pin transitions, extraction and survivor placement, partial privacy projections, concurrent transfers, permission loss, zero-write cancellation, retry/undo, touch/keyboard and narrow layouts. Avatar verification must cover all helpers/subtasks combinations, none/partial allocation, overwrite/clear, protected steps, drag/tap/long-press arbitration, focus teardown, paired identity scope and unchanged atomic payloads. Verify migration and grouping-aware recovery before any sequential release. These are acceptance criteria, not an implementation plan or a claim that proposed features have been tested.

Written-spec review is the next decision. Plan review and execution selection follow; deployment scheduling and any live capability activation remain separate.
