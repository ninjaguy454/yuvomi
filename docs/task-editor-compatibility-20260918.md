# Task editor compatibility and recurrence advancement

This bounded follow-up to `00f208309c6f1463f47d5d600bb5a70965fbbd6d` fixes two independently reproduced defects. It requires no migration or production data repair.

## Editable source actions

The recurring-series release correctly limited server subtask reconciliation to ordinary, nonarchived source actions. The editor already displayed that source-only list, but its submit handler appended hidden generated helper/support rows back into the replacement payload. The server then rejected an ID outside the editable set. Its shared error for an unknown source ID and a repeated ID misleadingly described this as a duplicate.

The editor now submits only its editable source rows. Generated projections remain under existing supervision reconciliation; omitted archived actions retain their historical rows. Stable IDs, action keys, progress, Optional settings, skills, comments, documents and completion/reopening evidence are preserved. This fixes scheduling-only saves without weakening structural validation or requiring users to recreate actions.

The server distinguishes a genuinely repeated source ID from a noneditable/foreign/archived ID. Both remain rejected. Existing-task errors no longer instruct the user to finish creating the Task to confirm subtask identities. Genuine ambiguous-create and partially saved new forms retain their recovery guidance.

## Calendar advancement after a cadence edit

A selected occurrence can move onto the first date of its revised cadence while retaining its original nominal occurrence key. For example, a Friday nominal slot of September 18 edited to Saturday September 19 could generate another September 19 occurrence when completed that day.

The planner now skips a candidate slot already represented by that selected occurrence, using the existing recurrence rule and phase. The guard applies only to fixed/calendar recurrence and requires durable evidence that the same occurrence authored a cadence change: matching definition/generation/source, no occurrence exception, and an exact collision with the concrete recurrence anchor. Later time-only definition revisions do not erase that evidence. Cadence comparison uses the existing RRULE parser: equivalent interval/weekday formatting and termination-limit-only changes do not count as a cadence change.

Existing nominal and award identities are preserved. No migration or manual correction of previously saved series is needed. Occurrence-only date overrides and title/date edits without a cadence change retain the established nominal-anchor behavior. Repeat from completion and expiration rules remain unchanged. The same planner handles eligible materialized future occurrences and subsequent generation.

Verified calendar sequences:

- Saturday: `2026-09-19 → 2026-09-26 → 2026-10-03`.
- Friday: `2026-09-11 → 2026-09-18 → 2026-09-25`.
- Relative fortnightly Saturday with a two-day Due offset: starts `2026-09-19 → 2026-10-03 → 2026-10-17`; due dates remain two calendar days later.

## Focused regression coverage

- Twelve new API regressions cover legacy bootstrap, unchanged saves, both edit scopes, unstarted/partial/reopened progress, archived evidence, Optional actions, supervised/delegated actions, stable identities and rejection of invalid IDs without partial writes.
- Six new browser regressions cover desktop/mobile source-only save payloads and rejected existing edits. They failed for the expected reasons on the baseline; the complete Task draft browser suite passes 38/38. Genuine lost-create recovery remains covered.
- Fourteen new cadence regressions cover both weekly sequences, the already-saved nominal/concrete mismatch, subsequent time-only edits, equivalent-rule formatting, preserved history, materialized successor reconciliation, offsets/intervals and occurrence-only exclusions. The focused cadence/generation/frontier/expiration/relative-scheduling gate passes 81/81.
- The API edit/binding, scope, optimistic queue and append-only migration checks pass 62/62. The three modified runtime modules pass syntax checks, and migration source is unchanged.

An initial card browser run under Docker `--network none` passed five cases but timed out waiting for a second client. The exact deployed baseline reproduced that timeout. Chromium reported `navigator.onLine=false`; the unchanged live-update client deliberately does not connect its event stream while offline. This is isolated QA network setup evidence, not a candidate regression or a passed live-sync check.

On an isolated internal QA bridge, Chromium reported online and the full card browser suite passed **6/6**, including immediate provisional feedback, duplicate suppression, rejection rollback, optional/final required completion, points/recurrence once, reopening, second-client convergence and touch scrolling. Temporary QA containers/networks were removed; production networking was untouched. No fresh numeric physical-device paint benchmark was performed.

Production diagnosis was read-only. Save and generation tests use synthetic local data. Raw task-scoped evidence is retained outside tracked source under `.qa/laundry-editor-20260918/`; browser editor evidence is under `.qa/task-editor-compatibility-20260918/`.
