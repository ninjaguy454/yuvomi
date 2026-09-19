# Rotation Groups UI refinement

Local follow-up to `d6bbb07100bbc01d192b170a10ccc2aa68edd408` on
`feature/rotation-groups-20260919`. The starting worktree was clean. Completed
Rotation and paired-device work is preserved.

## Scope and findings

- Rotation checkboxes used `.toggle` but omitted `.toggle__track`. The global
  component deliberately hides the native input, so Active, weekday choices,
  skip policy, and conversion confirmation had no visible state indicator.
- The list used an undefined toolbar class; inline dividers used an undefined
  border token. Raw fieldsets and tightly packed labels obscured the hierarchy.
- Group management also opens from consumer editors outside Settings. Its
  styling must be available there, independently of the Settings stylesheet.

## Changes

- Group cards with mode/status, description, ordered members, and schedule.
- Editor sections for group details, members, usage, and shared scheduling.
  Canonical visible switches, keyboard-accessible weekday pills, numbered
  drag rows and existing Actions alternatives, empty states, and starting preview.
- Shorter schedule guidance, household-local formatted date/time summaries,
  explicit next-day cutoff, and expandable scheduling explanation. Fixed Order
  hides irrelevant starting/skip controls while preserving stored values.
- Details separate baseline membership, schedule, current/next order, consumers,
  and contextual history. Existing permissions and all mutation handlers remain.
- Responsive, theme-aware component CSS loads globally and is included in the
  service-worker shell cache; cache version advanced for the asset update.

No server code, schema, recurrence/rotation algorithm, permission policy, or
production record changes. No push or deployment.

## Validation

- **28/28 browser fixture tests passed** (`test/test-rotation-groups-ui.js`).
  Four added cases exercise desktop/mobile and light/dark controls, labels,
  keyboard weekday selection, selected text contrast >= 4.5:1, horizontal fit,
  reachable footer, and Fixed Order presentation. Existing mouse/touch reorder,
  validation, conversion confirmation, stale drafts, permissions, overrides,
  correction history, and second-client SSE checks continue to pass.
- The history-focus test now waits for the existing modal's initial focus before
  establishing the summary focus under test. Its focus/expansion/panel-preservation
  assertions remain. That final test-only setup refinement passed separately;
  overlapping reruns are not counted as additional tests.
- **6/6 service-worker precache checks passed** (`test/test-sw-precache.js`).
  **8/8 service-worker upgrade checks passed** (`test/test-sw-upgrade.js`),
  including shared-device cache privacy and failed-install isolation.
  All 33 referenced component design tokens resolve. JavaScript syntax and
  `git diff --check` pass.
- Inspected screenshots from the real component, including warm-dark weekday
  controls and desktop/mobile light/dark editor and detail layouts. Evidence:
  `.qa/rotation-groups-20260919/refined-*`,
  `.qa/rotation-ui-final-gate-20260919.log` (28 browser + 6 precache checks),
  and `.qa/rotation-ui-sw-upgrade.log`.
- **Actual full-application Settings smoke passed** with normal authentication
  and an isolated synthetic database. Created a shared group through the UI;
  verified persisted description, member references, and schedule; reopened
  details/editor; cancelled a dirty editor's discard confirmation and preserved
  the complete draft without persistence. Desktop and mobile Settings layouts
  fit without horizontal overflow. Warm-dark/serif appearance, visible weekdays,
  switches, and the Provisional label were visually inspected. No browser page
  or console errors; zero foreign-key violations. All runtime public/server files
  matched the candidate. Browser and isolated server were closed afterward.
  Evidence: `.qa/rotation-settings-artifacts/result.json` and adjacent screenshots.
- Early full-app smoke attempts corrected harness assumptions about the moved
  modal footer, canonical usage-mode API projection, initial service-worker
  reload, dirty-state initialization, metadata versus textarea selectors, and
  detached elements during initial SSE refresh. They were not counted as passes
  and required no application workaround.

Browser emulation is not physical touchscreen validation. Rotation/backend
implementation suites were not repeated for this presentation-only change.
