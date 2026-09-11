# Availability consolidation QA

Implementation base: Vidamia `3c89120cb64cb9ddd915a3bd96237347ad41eda6`. Resolver semantics and compatibility limits are defined in [the consolidation contract](availability-consolidation.md).

## Isolation and evidence

Browser acceptance used the real application through CUA against the synthetic household started by `scripts/qa-availability-server.mjs`, bound to `127.0.0.1:3197`. Its database is `.qa/availability-browser-v2.db`, its document/backup paths stay under `.qa`, and backups are disabled. The fixture does not import a deployment environment or accept a caller-supplied database path. No production household records were used for browser acceptance.

| Verification | Result |
|---|---|
| HTTP acceptance checks against the isolated application | 15/15 passed |
| Required browser acceptance cases, exercised through actual CUA | 9/9 passed; details below |
| Final broad regression run | 1,025/1,025 passed across 46 named test files; zero failures or skips (`availability-final-regression.log`) |
| Separate navigation, authorization and API regression run | 52/52 passed; overlapping coverage is not added to the broad-run total |
| Five scripted Puppeteer component tests in `test/test-availability-routines-ui.js` | Unexecuted: browser launch failed before their assertions ran |

Actual CUA browser acceptance substituted for the blocked Puppeteer launch for this acceptance gate. The five scripted tests are retained for a working browser-test environment and are not counted as passing tests. HTTP assertions and browser observations are separate evidence; neither substitutes for production verification.

## Browser acceptance

| Required case | Verified result |
|---|---|
| Weekly schedule | Weekly routines remain accessible through Availability with their time ranges and availability state. |
| Week A / Week B | The alternating-week routine and its separate week assignments are surfaced through Availability. |
| Four on / four off | The existing eight-day rotation and explicit days off remain visible through Availability. |
| Overnight shift | A 22:00-06:00 routine continues across midnight, with the following-day portion represented. |
| Day-off override | The dated exception removes that routine restriction; it does not assert that the person is available all day. |
| Trip exception | Date-specific Trip availability takes precedence over the rotating routine and appears in the explanation. |
| Task eligibility during and outside a shift | The configured availability policy rejects a busy shift window and permits a window without that restriction. |
| Calendar overlay | Routine occurrences remain visible as a read-only Calendar projection, including overnight continuation. |
| Presence explanation | Availability reasons and the source of the inferred location are exposed separately. |

Additional CUA checks passed: the member Alex Overnight could edit their own night routine, while Taylor Rotation's cycle-day selectors were disabled and offered no Save/Delete controls. Light and dark desktop views and the 390-pixel mobile layout were inspected. The light-theme full-page capture was readable; the inspected browser console contained no errors. Direct `/schedule` navigation was verified to redirect to Availability after retirement.

Final advisory-only Calendar check: Jordan Calendar's assigned event supplied an inferred Workplace location, while both the current card and expected availability timeline correctly remained unknown/no planned restriction. The legacy API `effective` field remains compatible; the new card uses the capacity timeline. A regression also renders the actual card from this resolver result.

## Consolidation gate and retained behavior

Existing rotating-roster data, shift types, dated overrides and planned statistics were surfaced through Availability before standalone Schedule navigation was retired. Legacy `/schedule` navigation redirects to `/calendar?section=availability`. The existing Schedule API, tables and permission/token-scope keys remain; the additive migration does not discard roster data or grant permissions.

The Calendar overlay projects resolved roster occurrences, not the merged Availability winner after Trip/dated exceptions are applied. A roster shift can therefore remain visible while the Availability explanation identifies a higher-priority Trip. Calendar does not become the source of truth, and these projections do not create Calendar event records.

## Limits

- No production migration or production browser test was performed. The changes have not been pushed or deployed.
- Existing task assignments are not automatically recalculated when a routine changes. Existing due-date edits alone also do not automatically reassign a bound task.
- Current Presence remains an inferred location snapshot with provenance; it is not a physical-location observation.
- Tasks and Activities have no persisted duration field. The resolver/preview can accept optional duration, but ordinary existing task assignment must not be described as proving duration fit.
- Existing saved null cycle-day rows remain explicit days off. The previous UI did not record whether each default was deliberately chosen, so historical user intent cannot be reconstructed.
- Statistics describe planned occurrences and nominal shift hours, not attendance or elapsed working hours across daylight-saving changes.
