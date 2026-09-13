# Tasks view persistence and mobile gestures

This change is limited to frontend view reconciliation and gesture handling. Task lifecycle, assignment, permissions, supervision, revisions, recurrence and database schema are unchanged. Base: `53b16e66a4fbf7569fbc59566e59684997162a06`.

## Causes

Task mutations and live updates converge on `loadTasks` and the list renderer. List rendering removed every row and replayed entrance animations. Kanban removed the board itself, including the horizontal scrollport and independently scrolled desktop buckets. Expansion toggles used these same renderers. The existing JavaScript filter, sort, view and expansion state survived, but DOM identity, focus and browser scroll state did not.

History refresh also replaced already loaded pages with the first 50 records. A delayed History response could repaint the list after the user had switched views.

The touch handler armed a drag from the card body and activated after 8 pixels of movement in any direction, then prevented native scrolling. The entire card was also HTML-draggable and styled as a grab surface.

## View preservation

`task-view-state.js` reconciles keyed groups, buckets, cards and controls in place. Unchanged subtrees and scroll containers retain their DOM identity. Passive updates no longer replay List entrance animations. Event listeners are either delegated, bound once, or explicitly replaced so retained controls do not accumulate handlers.

At render time, the view captures current scroll positions and visible anchors. It restores them synchronously before paint, including horizontal Kanban and vertical bucket positions. Anchors must actually be visible through intervening clipping containers: a mobile test caught a 310-pixel jump caused by selecting a clipped card in the previous column. Unchanged offsets are not assigned, avoiding unnecessary interference with native momentum.

Filters, view, grouping and sort define the restoration scope. An intentional change to that scope does not reinstate an old card anchor or focus. Deleted, archived or filtered-out selected Tasks are pruned, and focus is restored only to a surviving permitted control. Detail operation rendering also preserves its scroll context; existing draft, revision and live-refresh protections remain in use.

Active card drags defer list painting until the gesture finishes. History retains the number of pages the user opened and ignores responses for a departed view or changed person filter.

## Gestures and accessibility

- The card body remains a native scrolling surface, including vertical swipes and rapid flicks.
- Only the explicit 44-by-44-pixel move handle is draggable. On touch, it requires a stationary 180 ms hold followed by at least 8 pixels of movement.
- Movement before the hold cancels drag intent. Scrolling cancels a pending/active gesture, and new gestures are ignored for 200 ms after a scroll event. A gesture already claimed by the browser cannot become a drag.
- Native scrolling is not prevented until drag intent is confirmed. Multi-touch, cancellation, Escape, page visibility changes and blur clean up the gesture.
- The handle has a Task-specific accessible label and visible focus treatment. Tap or keyboard activation opens the existing detail/status control as the movement alternative.
- Existing bucket restrictions, permissions and canonical status mutations remain authoritative. A drop does not reassign the Task.

## Validation

Final focused and adjacent regression run: **226 tests, 222 passed, 4 failed, 0 skipped**. All **51 new tests passed**: 21 gesture unit tests, 12 Chromium touch-browser cases and 18 Tasks view-browser cases.

The four failures in `test-detail-view.js` also fail on an exact archive of unchanged base `53b16e66` (55 tests: 51 passed, 4 failed). They are pre-existing source assertions at lines 402, 434, 571 and 585 concerning checklist controls, component state, the old status cycle and old detail markup. They were not changed in this interaction fix.

New coverage includes:

- Subtask completion/reopen, canceled completion and revision rejection.
- Parent status changes, card/group expansion, List and Kanban DOM identity.
- Top/middle/bottom positions, page scroll, horizontal board scroll and independent bucket scroll.
- Live assignment, recurrence insertion, deletion/archive and selected/focused card removal.
- Intentional filter changes and requests finishing after the user scrolls or switches views.
- Open detail, comment draft/selection/focus and modal/background scroll.
- Retained History pages, late History responses and retained empty-state controls.
- No scroll-offset writes for an unchanged viewport.
- Card-body swipes, rapid flicks, premature handle movement, held-handle drops, horizontal Kanban scrolling, small tap movement and keyboard activation.

The browser harness executes the actual Tasks renderer, API client, handlers and CSS with isolated HTTP fixtures; gesture tests use real Chromium touch input. Sizes include desktop 1100x800, iPhone-size 390x844 and Android-size 412x915.

Additional Chrome QA used an isolated production-image application with the candidate frontend mounted read-only, a copied QA database, synthetic login sessions and outbound integrations blocked:

- At 390x844, a canonical update from another client arrived through the real event stream. Page scroll remained **1516 px**, board scroll **0 px**, and visible Task 158 stayed at **10.0104 px** from the viewport top.
- At 1024x768, Task 213's first subtask completed and reopened through the normal detail UI. The modal remained open, search remained selected, focus returned to the action, and parent auto-start worked.
- Keyboard Tab navigation reached the labelled handle; Enter opened Task detail with its status control.
- Completing disposable recurring Task 220 through a separate canonical client generated Task 227. It appeared live with **0/2** progress, the same learner and tomorrow's due date; the selected search and Kanban mode remained intact.
- Only unmistakable zero-point QA fixtures were mutated. No production records or services were changed.

Evidence is retained locally under `.qa/task-interactions-20260913/`, including final/baseline logs, sanitized request metadata and the isolated database. Physical iPhone/Android hardware and Safari were not tested; Chromium viewport/touch emulation does not establish identical behavior on every device.

## Reproduce regression run

Use Node 24 with `DB_PATH=:memory:` and a synthetic `SESSION_SECRET`:

```text
node --loader ./test/test-browser-loader.mjs --experimental-sqlite --test --test-concurrency=1 test/test-task-card-drag.js test/test-task-card-drag-browser.js test/test-task-view-browser.js test/test-task-refinement-ui.js test/test-task-visibility-ui.js test/test-task-optimistic-browser.js test/test-tasks-calendar.js test/test-detail-view.js test/test-modal-utils.js test/test-modal-children.js test/test-task-release-live.js test/test-mobile-scroll-layout.js test/test-lucide-icons.js
```

No push or deployment is part of this fix.
