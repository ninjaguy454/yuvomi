# Kitchen planning Settings theme and access correction

Base: `f9b33cb5b0301527e326a8117a87ef21ea78c106`. This change repairs the planning Settings form and its Kitchen entry points. Operational deployment evidence records the final immutable commit and image outside Git.

The authenticated warm dark setup reproduced the reported failure: fixed meal-chooser ink inherited into a dark Settings card, yielding only **1.03:1** label contrast. Neutral and cool dark measured **1.00:1** and **1.01:1**. The supplied Library screenshots could not be materialized on Windows (`os.setxattr` is unsupported); they were not inspected. The user authorized reproducing the described symptom in the actual application.

Planning setup now uses the existing Settings surfaces, text, help, form controls, focus, disabled and semantic error/status tokens. Its dynamically generated schedule preview also follows the theme. Native date/time controls follow explicit and system light/dark appearance. The approved everyday family meal chooser keeps its existing presentation.

Personal administrators receive a clearly named **Meal planning settings** shortcut beneath the four Kitchen destinations. It opens the existing admin-only `/settings/modules/kitchen` route. Before complete canonical configuration, normal Meals also offers **Set up meal planning** in that row. The row remains reachable when legacy Meals automatically scrolls to today's card. Complete paused configuration keeps access to existing planning periods. Ordinary members and paired devices retain their meal views without configuration controls.

Viewing either entry performs no setup, activation, period creation, Task or Shopping mutation. Setup retains explicit Preview and Save, disabled/manual defaults, existing actor-scoped drafts, dirty-navigation cancellation and exact uncertain-request retry behavior. Backend scheduling, permissions, output/history semantics and dependencies are unchanged. Client cache generation advances from `vidamia.28` to `vidamia.29`.

Maintained verification: `test/test-meal-planning-settings-browser.js` exercises the actual authenticated server with synthetic households at1440/390 in light/dark, warm/neutral/cool computed color checks, weekly/monthly fields, native date/time, validation/error/focus, pending Save, preview/status, back/cancel, administrator/member entry and rejection, paused work and actual paired-device authority. It is registered through `test:document-guards`. Existing UI/Kitchen, Settings-state, family-flow and service-worker checks remain required. Final native exit counts and source hashes are recorded in `theme-evidence/settings-theme-access-report.md` and its supporting logs.

Screenshots represent synthetic desktop browser viewports; physical-phone keyboard, screen-reader and supervised-child usability sessions were not run. Historical migration-count, Settings-copy/OpenAPI/i18n and unrelated test-registry debt remain outside this correction.
