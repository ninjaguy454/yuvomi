# Configurable Rotating Order direction

Implemented locally from `ad7585fd0d22378074f94d080716242abcd27542`. No production configuration or household records changed.

## User-facing behavior

For **Rotating Order**, the shared Rotation Group editor now offers **Rotation direction**:

- **First moves to last** preserves existing behavior. With three members, an individual's positions are 1 → 3 → 2 → 1.
- **Last moves to first** gives the requested progression: 1 → 2 → 3 → 1.

Both use the same configured member order. Direction changes how the next first member is chosen; it does not reverse the baseline membership list. A short position example appears below the selector, and the chosen direction appears in Group summaries and change confirmation.

Independent Activity/Workflow purposes offer the same control. Shared consumers inherit the Group's direction and cannot maintain their own conflicting rule. Round Robin and Fixed Order retain their current behavior; the direction control is hidden for those methods.

Changing an existing shared Group uses its existing effective-date preview and confirmation. Already active/historical periods retain their saved configuration and order. The confirmed starting member/order and future effective boundary remain explicit. This change does not switch the household's existing Shower Group automatically.

## Canonical behavior and compatibility

The existing Rotation service handles selection, previews, scheduled finalization, overrides, and membership reconciliation. Reverse advancement moves the last eligible member to first. Skipping retains or advances the cursor according to the existing skip policy. Overrides that affect future turns use the effective order's last member in reverse mode, including a single eligible member. Task completion still cannot advance a shared scheduled Group.

Direction persists in Track configuration, occurrence snapshots, shared schedule versions, and reusable Activity/Workflow bindings. Recurring generation and expression-backed position text consume that canonical result. An omitted direction in legacy data is equivalent to the existing default; an unchanged save must not create an occurrence-specific Track, reset another purpose, or trigger a scope dialog solely because the new field is present.

Additive migration **10043** adds `rotation_tracks.direction`, defaulting to `first_to_last`, with a value constraint. Migrations 10042 and earlier are unchanged. Existing occurrence and schedule-version JSON is not rewritten. The service-worker cache version is advanced for the updated controls. Task card summaries remain hidden and Task Details remain intact.

## Focused validation

These are separate gates, not a sum of overlapping runs:

| Gate | Result |
| --- | --- |
| Existing core and shared scheduler suites | 42 passed |
| New direction suite | 9 passed: four turns, pure previews, idempotency, skip/override policies, single eligible override, eligibility/removal, legacy no-op, effective boundaries, encrypted migration/restart |
| Task API, shared Task API, and edit-scope gate | 41 passed, including reverse four-night independent bedtime series, absence, expression positions, template inheritance, and recurrence |
| Additional legacy HTTP edit | 1 passed: explicit default retains existing purpose, Track, and snapshot |
| Workflow/expression, Meal/shared consumer, privacy, and purpose-isolation compatibility | 49 passed |
| Additional reverse shared Workflow/Meal scenario | 1 passed: both consumers use the second evening's reverse order; retry does not advance again |
| Group/Meal UI browser gate | 37 passed; final direction-confirmation addition passed its focused rerun |
| Existing populated encrypted migration rehearsals | 5 passed through 10043, retaining Tasks, devices/sessions, rewards, supervision, Meals, and both Rotation ownership models |
| Migration ordering and schema sanity | 5 passed |

The new reverse Task scenario initially failed with the old forward sequence and passed after the fix. The direct encrypted **10042 → 10043** rehearsal applied only 10043, retained historical rows and migration records, passed integrity and foreign-key checks, and replayed no migrations on a fresh process restart. Reverse direction also survived that restart.

Browser checks used local isolated HTTP fixtures and actual Chromium at desktop/mobile sizes. Inspected 1440px and 390px screenshots show the labeled selector and position example without horizontal overflow. The new browser test needed a wait for the post-save refreshed editor control; its corrected run passed. No failed browser launch was counted as a pass.

The reverse bedtime, Workflow, and Meal checks exercised the actual backend with synthetic households. No new physical-device or production browser test was performed. Checkbox handlers and rendering were untouched; the existing optimistic-interaction evidence is reused, not newly benchmarked. No full repository matrix was run.

Local verdict: **READY**. Commit locally; publication, migration of production, and deployment remain separate steps.
