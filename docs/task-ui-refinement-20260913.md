# Tasks UI refinement

This pass builds on `41669db094cda7b61228f98f8d82e1acaceabfc9` and follows the user's Task card drawings and subsequent header, selection and detail feedback. It remains local until approved for release.

## Cards

The headline previously reserved four columns for expansion, title/date, large points and completion. In a 302px-wide mobile card, the title/date had only 98px. Metadata inherited large body text and competed for space; progress appeared twice. Legacy Kanban padding also doubled the shared card's padding. Responsive tags marked hidden still rendered because their display rule overrode the hidden attribute.

The card now gives title/date 196px in the same test fixture. Points are secondary upper-right metadata. Names and dates wrap without ellipses, tags stay in one row with working overflow, and a single Subtasks footer carries count and percentage. Description and participant profiles retain their existing expansion, and subtasks still expand independently. The measured collapsed fixture became 242.5px tall versus 290px before.

Ordinary status prose is replaced by the existing right-side action control: empty circle for Not Started, half-filled circle for In Progress, green check for Completed. Its accessible label and tooltip include the current status. Waiting-for-helper and unresolved explanations remain explicit. Completion actions and confirmation semantics are unchanged.

## Header

The Tasks search field starts behind a labelled search icon. Opening it focuses the existing search field. Collapsing with the icon or Escape retains the query and filtering, with an active indicator on the icon. Clearing search uses the existing behavior. Search state survives live reload and view changes; History hides it without dropping the query.

Tasks-specific header layout assigns the notification button its own column, including its unread badge. Compact screens place the action controls on a horizontal rail and expanded search on its own row. The global header and notification infrastructure are unchanged.

## Selection and gestures

The dedicated checklist toolbar button is removed. A stationary one-second hold on a List card or its primary title enters selection and selects that Task. Shift+Space on the title is the keyboard equivalent. Selection boxes are visually 18px with 44px labelled touch targets. Done selecting or Escape exits selection and restores focus to the Task.

Movement of 8px, scrolling, multi-touch, cancellation and page changes cancel pending holds. Ordinary taps still open detail. Subtasks, completion buttons, tags, participant controls and Kanban are excluded from this selection gesture. Once a hold selects a Task, the same contact cannot also trigger the existing swipe-to-complete/view behavior, even after viewport restoration. Selection itself makes no API mutation.

The previous keyed view reconciliation, revision checks, live refresh and handle-only Kanban dragging remain in use. Entering and leaving selection capture/restore the current viewport rather than resetting it.

## Task detail

Points sit with progress at the top right, tags immediately follow instructions, and one supervisor summary and assignment control precede the subtasks. Each subtask keeps its skill/proficiency label; clicking or tapping that label opens the server-provided explanation. The repeated list of those same actionable subtasks is removed. Parent requirements, nested requirements, transferred helper responsibilities and historical mappings remain available in a separate disclosure so deduplication does not hide work or history.

Assignee names wrap within their own full-width metadata row. Start and Due share a paired row. Activity Template information moves into More details. Activity and recurring history start collapsed. Disclosure state survives optimistic updates and accepted live snapshots, alongside the existing comment draft, focus and scroll protections.

Supervisor assignment still uses the canonical full-scope candidate set, permission flag and source revision. Completion remains gated by the existing action permission and supervision result. Helper links still require explicit visibility permission. This pass does not recompute eligibility or change responsibility-based progress, points, history, recurrence or Task lifecycle rules.

## Evidence

Evidence and screenshots are retained locally in `.qa/task-card-layout-20260913/`. Tests execute actual frontend modules and application CSS with loopback-only fixtures. Touch tests use real Chromium touch events at 390x844 and 412x915. Header checks cover 390, 412, 768, 1024 and 1440px, including the actual collapsing-header utility and notification markup. Card checks include Warm/Neutral/Cool, Light/Dark and Serif.

Detail evidence is in `.qa/task-detail-layout-20260913/`, including 390px, 412px and 1280px captures. Browser QA found and fixed clipping of mobile status text and the supervisor selector, plus a cramped two-column subtask layout. Regressions check the controls against actual modal and row bounds, rather than relying only on document overflow. Identical skill/action explanations display once when expanded.

The combined regression run completed **301 tests: 297 passed and four failed**, with no skips. All four failures are unchanged source-text assertions in `test/test-detail-view.js`, independently reproduced on the deployed `53b16e66` baseline before this pass: checklist/model separation, module independence, status switching and card information in detail. Those tests were not edited. Evidence: `.qa/task-card-layout-20260913/combined-final-regression.tap` and `.qa/task-interactions-20260913/baseline-detail-view.tap`.

New coverage comprises 16 card layout/browser cases, eight header/browser cases, 31 hold-selection unit cases, ten hold-selection browser cases and ten detail/browser cases. After the final explanation deduplication, the affected detail suite was rerun: **63/63 passed** (ten new detail/browser cases, 45 existing refinement cases and eight existing optimistic/browser cases), in `.qa/task-detail-layout-20260913/final-detail-regression.tap`. Existing revision/rejection, live refresh, modal, visibility, Kanban drag and view-state regressions are included in the combined run. Syntax and Git whitespace checks pass.

Physical iOS/Android devices and Safari were not tested. No production records, images or services were modified during this pass.
