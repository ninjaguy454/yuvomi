# Kanban expansion scroll correction

Starting commit: `bd1a17eae63a57b109c94d435bb0a8f3683c1c1f`.
Branch: `feature/rotation-groups-20260919`.

## Cause and correction

Recurring and locked Task icons contain absolutely positioned screen-reader
labels. The Kanban column scroll container had no positioned containing block,
so those labels escaped its scroll boundary and enlarged the outer scroll area
when cards or status sections expanded. The visible board did not grow.

Adding `position: relative` to `.task-board__bucket-scroll` contains those labels
inside the existing scrollport. Accessibility text remains intact. Desktop
columns retain internal scrolling; narrow mobile layouts retain page-owned
vertical scrolling. No global overflow restriction or Task behavior changed.
The service-worker cache version advances to deliver the updated stylesheet.

## Direct reproduction

An isolated full application, real backend, synthetic household, and normal
authentication reproduced the problem at 1400 x 900 in Edge:

| State | Outer scroll height before | After |
| --- | ---: | ---: |
| Initial | 900 px | 900 px |
| Done/Archived expanded | 1,306 px | 900 px |
| Cards/subtasks expanded | 6,044 px | 900 px |

The board stayed 668 px tall in both versions. After the correction, the column
still scrolls its 6,926 px of content within a 597 px viewport. Nonrecurring
cards without the affected labels did not reproduce the overflow.

Local evidence: `.qa/kanban-full-app-audit-before.log`,
`.qa/kanban-full-app-audit-after.log`, and
`.qa/kanban-full-app-expanded-audit.png`.

## Validation

- Two new browser regressions, desktop and mobile, failed with the starting
  stylesheet and pass with the correction. They exercise expansion/collapse of
  recurring/locked cards, subtasks, and Done/Expired/Archived sections without
  Task mutations. The fixture now includes the real accessibility stylesheet.
- Focused combined run: **50 passed, 1 existing baseline failure** across Task
  view, Task card drag, service-worker precache, and upgrade tests. This includes
  the two new regressions; repeated runs are not additional coverage.
- Passing checks cover mobile flick/momentum scrolling, horizontal Kanban swipe,
  deliberate held drag, keyboard activation, completion/reopening reconciliation,
  live updates, focus/expansion, and column/page scroll preservation.
- The failing test is `History live refresh keeps previously opened pages and
  cannot overwrite a later List view`: its expected History row is absent and
  the fixture reads `getBoundingClientRect` on null. The same failure reproduces
  with unchanged starting-commit source and stylesheet in the isolated runtime.
  It is unrelated to this correction and remains unresolved. The new regression
  command is registered in the browser gate without newly adding that failing
  baseline History test to the gate.

Commands: `npm run test:task-kanban-scroll`; combined run with
`node --test --test-concurrency=1 test/test-task-view-browser.js test/test-task-card-drag-browser.js test/test-sw-precache.js test/test-sw-upgrade.js`.
Logs: `.qa/kanban-scroll-regression-before.log`,
`.qa/kanban-scroll-regression.log`, `.qa/kanban-scroll-focused.log`, and
`.qa/kanban-history-baseline.log`.

Browser checks use desktop Edge and emulated touch/mobile viewports. Physical
phone and wall-display verification has not been performed. No backend, schema,
migration, production data, or deployment changes were made.
