# Mobile Kitchen layout follow-up

Baseline: `23a326ecfa8afc0fac5655d4280f319f80edfd35` on
`feature/tasks-refinement-20260907`. This follow-up is not deployed.

## Behavior

Below 1024px, outside Wall Mode, Kitchen uses the existing main page scrollport.
Only the Kitchen module rail stays pinned. Meal view tabs, person/context filters,
week actions, notification button and day headings scroll away with the content.
Recipes, Shopping and Pantry share this scroll behavior. Existing router scroll
restoration and bottom-navigation clearance remain authoritative.

Meals uses two paired action rows on phones and one four-button row at tablet
widths (768–1023px). Today remains available with the other week actions. Pending
requests get a full row when present. Buttons retain touch sizing and grow with
wrapped labels. Cards align with the filters; empty days have less blank space.

Shopping's existing content-wrapper layout moved from inline markup into its
stylesheet so the shared mobile rule can override it without `!important`.
Desktop boards and Wall Mode retain their existing bounded scroll layout.
No database, portion, grocery, permission or Meal workflow semantics changed.
The service-worker cache generation advances from `vidamia.2` to `vidamia.3`;
application identity and private/offline cache rules are unchanged.

## Visual QA record

Before, the 390×844 local preview left only a 313px inner Meal list beneath the
banner, filters and toolbar. Today occupied an isolated row, day cards had an
extra horizontal inset, and empty days consumed unnecessary height.

After, the entire page scrolls beneath the banner. Mobile actions align in two
rows, tablet actions fit one row, and cards use the same horizontal grid as the
filters. Visual review also caught and corrected overlapping day-header stacking
and unequal action heights when a long label wrapped at 320px.

The actual local app was inspected at 390×844 and 768×1024 using synthetic data.
Browser fixtures render the real module code at 320, 390, 768, 1024 and 1366px,
including populated weeks, Timeline, long recipe lists, Shopping and Pantry.
Warm/Neutral/Cool in Light/Dark with Serif were checked. Desktop board scrolling,
wall exclusion, viewport changes, tab hit-testing during scroll and Back
restoration passed. Fifteen local captures are in
`artifacts/mobile-kitchen-layout/`; recreate them with
`MEALS_LAYOUT_SCREENSHOTS=1` when running `test:meals-mobile-layout`.
These are browser viewport checks, not physical-phone testing.

## Validation

- Mobile Kitchen browser regressions: 13/13.
- Frontend, mobile scroll and service-worker/privacy guards: 373/373.
- Notification-header and recipe-row browser regressions: 14/14.
- Kitchen navigation utility checks: 8/8.
- Changed JavaScript syntax, package JSON and whitespace checks passed.

Total: 408 passing checks. One old source guard assumed Today lived inside the
date container; it now verifies the action remains unique and wired. Browser
tests verify its responsive placement. No migration or production tests were
needed, and production was not modified.
