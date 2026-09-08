# Ordoma: Tasks, Cooking Map and product refinement

> **Historical release evidence.** This report records the Tasks/Cooking Map refinement completed at `50866278dbd9e71b53bb98f439b0e41a55965423` and subsequently deployed with schema 10029. Its screenshots, names and test results describe that release. The later approved product name is **Vidamia**; the [current branding correction and validation report](vidamia-rebrand-20260908.md) supersedes this report's product identity. The completed Tasks, Cooking Map and Meal portion behavior remains the baseline.

Branch: `feature/tasks-refinement-20260907`. Baseline: `2cf912812897cb9e478831aa0f8205a99872fabd` (the already deployed Meal portions release). This pass preserves that implementation and migration 10028. No push, merge, or production deployment is included.

## Task and subtask skill model

Subtasks already are ordinary child Task records, so optional requirements use one `task_skill_requirements` relation for both manual Tasks and subtasks. Requirements reference existing Skills and their existing effective proficiency rules. Activity Template checklist requirements use a relation keyed to the existing checklist item; materialization copies those requirements to the child Task.

Following the approved decision, manual assignment and claiming require independent proficiency in every explicitly required skill. Requirements do not inherit from the parent. Completion permissions remain unchanged. Activity-bound roots retain their existing template requirements and supervision behavior. Existing subtask-derived participants are not incorrectly treated as new independent workers on the parent; promoting somebody to primary or adding a new worker still validates eligibility.

Administrators can create a missing Skill directly inside the Task, subtask or Activity Template skill picker. This opens the existing Skill editor as a child; Save returns to the preserved draft and selects the new Skill only in the originating picker. Cancel leaves the draft unchanged. Other pickers receive the new catalogue entry without acquiring its requirement. Members retain existing selection rights but do not see a creation action. Skill names on subtask read rows stay hidden until **Required skills** is expanded.

Creation inserts the parent, inline subtasks and requirements transactionally. Duplication and recurrence retain requirements. Skill rename keeps stable references, and deleting a referenced skill is rejected. Existing round-robin ordering is retained; an ineligible scheduled assignee leaves the occurrence unassigned rather than silently skipping the roster or changing its cursor.

Final review caught recurring child eligibility being evaluated against the parent's next date. It now uses the child's actual shifted due date, with a regression across an age-eligibility boundary. This preserves the assignment rule while applying it to the correct occurrence.

## Task Workflows launcher

The lightning action is now **Task Workflows** and lists workflows. Activity Templates are selected in the canonical +Task form. Workflow creation reuses the existing Household Automation editor; Save as Template reuses the existing Activity Template editor. No second authoring model or editor was introduced.

Child dialogs preserve the launcher's mounted state, focus and history. Cancel, Close and browser Back return to the parent. The preview is invalidated when workflow inputs change. Existing administrator permissions still govern template/workflow authoring.

Workflow execution and Activity/Workflow template saves reject repeated clicks while a submission is pending, disable the relevant action, and permit retry after failure.

## Canonical +Task and template switching

The form supports blank creation, Activity Templates, inline subtasks and skill selection. Dirty comparison uses the baseline established after blank defaults or template population, including custom dates, tags, documents and pending attachments. Untouched drafts switch immediately. Edited drafts offer Cancel or Switch template, with a per-user **Don't show this warning again** option; Personal settings can restore the warning.

Switching to Blank rebuilds the form from blank defaults, clearing template-populated and edited values. Cancelling the warning preserves the form and assignment mode. An uncertain create response retains the existing request identity and freezes the original child list while recovery completes, preventing a template/subject change from replacing children during that retry.

## Save as Template

The reusable draft copies title, description, priority, category, points, tags, supported saved Place, skills and checklist into the existing Activity editor for review. Dates, recurrence, reminders, documents and completion state remain occurrence data. The parent Task draft is retained after the child editor closes or saves.

Existing Activity assignment strategies remain authoritative. One manual assignee can become a fixed template assignee. Several manual assignees do not silently become a rotation; the existing editor presents the open/claimable strategy for review. One-use free-text/map locations are not converted into new Places. Saved Places can become fixed template locations.

## Layout and location

The existing form is organized into **Task**, **When**, **People**, **Subtasks**, and **Where**, with compact grouped fields and persistent Cancel / Save as Template / Create Task actions. The former More Settings catchall is removed from this form. Shared skill and checklist controls are reused by Task creation, Task Detail and Activity Template editing.

Full-page mobile QA exposed a subtask name being squeezed by adjacent skill metadata and read controls remaining visible during rename. Expandable skill metadata now gets its own row; hidden read controls remain hidden, and the mobile editor places its name above Save/Cancel. A full-shell browser regression covers this layout and edit/cancel behavior.

Home is the fallback for the normal manual blank form when an active Home Place exists. Explicit template locations override it. Generated workflows, Trips and context-aware Tasks retain their existing location paths. No new Task time or participant domain model was introduced merely to match suggested section labels.

## Sync Target and Reminder Lists

Both support active CalDAV VTODO synchronization. Their account/list identifiers, outbound queues, mirror identity, inbound mapping and personal default remain intact. The Task selector is an integration disclosure shown when configured or when an existing target/mirror must be represented. A stored unavailable target is preserved rather than cleared. Settings language identifies external Task/Shopping lists and distinguishes them from Ordoma notification reminders.

The detailed evidence and retained compatibility contracts are in [the complexity and integration review](tasks-complexity-review-20260907.md).

## Cooking Map fixes

Ready-state choices derive from the current draft and current producer display order. Adding, renaming, removing or moving an output/operation updates the choices. New selections come from earlier producers or existing initial readiness resources. An already selected prerequisite remains selected if its producer moves later, with an explanatory note. Own outputs are excluded. Reordering never rewrites the resource graph's dependency relationships.

Each operation has compact first-line chevrons and a dotted drag handle using the existing sortable primitive. Stable operation IDs preserve selection; pending field edits are committed to the in-memory draft before switching or reordering. Long operation names wrap around reserved controls. Explicit Save/Cancel, written recipes, graph validation and existing provider/native-copy behavior remain intact. No AI, scheduling, timers, assignments, accounting, or pipeline schema change is added.

## Additional interface refinements approved during this pass

- **Notifications:** one bell lives at the top right of the current module heading, including Kitchen child pages and individual Settings pages. It moves with soft navigation and retains unread state and existing wall/shared-device privacy. The notification center's Refresh action uses an accessible refresh icon with the existing handler. A focused regression also fixes the shared action cleanup incorrectly re-enabling **Mark all as read** after the unread count reached zero.
- **Calendar:** the Month/Week/Day/Agenda and Calendar/Availability/Trips selectors share the same responsive gutter. The month/year heading opens the month picker extracted from Tasks, preserving the current Calendar view and clamping the selected date for short months. Existing previous/next controls and Tasks Schedule navigation remain available.
- **Settings:** the overview and navigation now describe **Your preferences**, **Household modules**, **Connections**, and **Household & system**. Existing destinations and permission boundaries remain unchanged. Search is available on the overview at every screen width and uses the same permission-filtered search and navigation guard as the sidebar. Desktop groups use two balanced columns; small screens retain descriptive category entry points. Shared card, form, heading and action spacing is tighter throughout individual pages. Theme and Typography share a row when space permits and stack on mobile. Settings also uses the shared Kitchen icon.
- **Module symbols:** Kitchen uses the bundled cooking-pot icon. Housekeeping uses a trigger cleaning bottle with a broad body and separate squeeze lever, replacing the unclear brush/aerosol silhouette. Both flow through the existing shared module mapping.
- **Overview customization:** the greeting, scope explanation and edit controls use separate rows. The previous container breakpoint forced the greeting and all administrator controls onto one row, squeezing the greeting to zero width at tablet size. Actions now wrap below the explanation while the bell and close control retain their space. Only layout rules changed; personal Save, Cancel and household-default semantics are preserved.
- **Recipe cards:** at narrower card widths, the title receives the full heading row, with ingredient/provider metadata and actions below it. The previous fixed action row competed with the title and could reduce it to a few characters per line. Existing controls, optional thumbnails, provider badges and the mobile More menu remain available. This is a CSS correction; no Recipe, portion or handoff data changed.
- **Theme-matched controls:** selected options, navigation, primary actions, hover states and focus rings follow the selected color theme instead of a universal purple. Neutral uses graphite, Warm bronze and Cool slate blue, with separate Light/Dark values. Existing success/warning/error and module/data colors retain their meanings. The shared token family supplies these roles across modules; no new preference or page-specific palette was introduced. The installer's standalone fallback matches Neutral.

These changes add no preference storage, notification model or Calendar schema.

## Rebrand: Yuvomi → Ordoma

Ordoma is now the fixed product identity. The App Name control is removed; old stored values remain untouched but no longer override application branding. Household names and explicitly configured email sender names remain independent.

The selected mark is a circular radial **O**, formed by 24 evenly spaced strokes around an open center. Eighteen-, twenty-four- and twenty-eight-stroke variants were compared; the selected version was corrected from an oval to a true circle following the user's visual review. The mark has no loading animation. The canonical SVG is `public/icons/ordoma-mark.svg`; `scripts/generate-icons.js` generates the application, maskable, Apple, favicon, notification, installer and documentation variants. The social wordmark uses the radial O as its initial letter.

User-facing shell, page titles, authentication/setup, loading/offline, Settings, notification and email defaults, Reader, API descriptions, installer and current product documentation identify Ordoma. All existing locale layers retain their keys and structure. Reader remains script-free and text-branded; Wall Mode retains its private-content restrictions and uncluttered shared display.

The manifest keeps its application ID, start URL and scope. The service-worker version advances through the existing release path, reloading the replacement assets while preserving device-privacy and storage identities. Brand asset and manifest responses revalidate. Existing installed applications retain the same origin and identity; operating systems control when their displayed name/icon refreshes.

The final service-worker suffix is `ordoma.3`, covering the complete icon, control-palette and responsive-layout candidate. No installed identity or browser data is reset to force the update.

Internal browser names, configuration/environment keys, database/provenance fields, token/cookie identities, authenticator enrollment, external synchronization folders/identities, Docker/data paths, repository/remotes and upstream attribution remain intentionally compatible. No infrastructure was renamed. Current documentation identifies Ordoma as an independent platform derived from Yuvomi and preserves the upstream MIT notices. Repository/registry renames, historical screenshot rewriting and physical installed-PWA upgrade verification are deferred.

The detailed asset inventory, retained-identifier rationale and automated branding audit are in [the rebrand compatibility report](ordoma-rebrand-20260908.md).

## Cleanup and codebase health after this pass

Removed proven unused local Task renderers and helpers: `initials`, `renderLegacyTaskCard`, `renderLegacyKanban`, `renderLegacyFilters`, `wireLegacyViewToggle`, `renderDueDate`, `renderKanbanCard`, `renderTagBadges`, and `kanbanNextStatus`, plus unused imports. The duplicate Task status mutation delegates to existing `toggleSubtaskStatus`. Shared skill/checklist controls and a small draft helper replace repeated form logic.

Ordoma's size mostly reflects a substantial supported product surface, with some demonstrable retained frontend implementations and mixed-responsibility modules. Large files alone are not evidence of unnecessary functionality. The audit quantifies major modules, removed code and request patterns. It makes no unmeasured performance claim.

Deferred: broad consolidation of Task writers, a permissions redesign, timezone-contract changes, global catalog caching, speculative API batching and blanket CSS deletion. The next useful cleanup is to define explicit contracts around Task creation paths and measure repeated catalog loading before changing their ownership or caching.

The separately requested Kitchen navigation icon update is included after the user's clarification: the shared module mapping uses the already bundled cooking-pot symbol, preserving the Kitchen label and accessible name across desktop, mobile and settings. Its status is recorded in [the product backlog](product-backlog.md).

## Migration and validation

Migration **10029** appends the two skill-reference tables and Activity Template `priority`, `points`, and `tags_json` defaults. Existing records get empty requirements and safe defaults. Migration 10028 and deployed portion behavior remain unchanged. The Meals and Recipes page diffs contain only visible brand-name substitutions; portion/grocery services and API paths are unchanged. Prior migration tests were adjusted only to allow subsequent append-only migrations while retaining their preservation and no-replay checks. The rebrand and interface fixes add no migration.

The populated **10028 → 10029** upgrade test verifies exactly one new migration, unchanged existing data and prior receipts, safe defaults, and no migration replay on restart. Earlier 10026/10027 upgrade paths also retain their Cooking Map and portion data while advancing through the additive lineage. The local QA server restarted at 10029 without replay. Production remains at 10028 and was not restarted or deployed during this pass.

Final related validation: **2,570 / 2,570 distinct checks passed across 127 test files**, zero unresolved failures or skips. The final expanded matrix and its focused replacements/additions account for 1,358 checks across 70 files; unchanged original-matrix and backend results supply the remainder. Each test file is counted once at its latest verified result. Coverage includes Tasks, skills/proficiency, Activity Templates, workflows, generated Tasks, assignment, recurrence/reminders, idempotency, shared modal/history, preferences, detail/calendar/group views, notifications, CalDAV, migration lineage, service-worker assets, appearance, navigation, branding, installer/localization and frontend guards.

The first matrix found obsolete extracted-function fixtures in idempotency tests and a tag guard aimed at a removed renderer. They were updated to exercise the retained mutation and active responsive renderer. A Settings guard still expected the superseded mixed Quick Add launcher; it now checks the approved workflow-only launcher and canonical +Task path. Visual and focused checks also caught a Cooking Map button-radius mismatch, dark-popover year text, and an admin-only Skill creation button appearing on a member's newly added subtask row. Each implementation issue was fixed and covered by the affected checks.

Focused counts include 13 Task/subtask skill checks plus the 10029 migration check, 11 mounted Task draft checks, 8 shared requirement-editor checks, 126 Cooking Map checks, 10 notification/Overview header checks, 4 rendered Recipe layout checks, 6 rendered theme-control checks, and 23 appearance checks. The last affected batch passed 465/465, including the full 347-check frontend audit, theme/Recipe browser cases, installer parity, suite/layer boundaries and current documentation guards. These are subsets of the distinct total, not extra totals to add again.

The expanded matrix also exposed installer fallback warning/danger colors that lagged the current accessibility tokens, an obsolete generated-file branding expectation, and a server import allowlist that needed the intentionally shared pure branding helper. Those bounded issues are fixed and their focused replacements pass. The shell-helper test now executes its existing assertions through installed Git Bash on Windows using a temporary script, preserving quoting; it is no longer skipped on this host.

Final syntax checks passed for **108** changed/new JavaScript files; all **50** changed JSON files parse; the diff check passes. Protected portion services and routes are unchanged, and the Meals/Recipes JavaScript changes are verified as brand wording only. The static branding audit classifies every remaining historical-name occurrence and reports **zero unexplained user-facing remnants**.

Retained local evidence (ignored by Git): `artifacts/tasks-integrated-matrix/final-summary.json` maps files to final logs; `final-summary.md` explains deduplication and reruns; `artifacts/tasks-final-static-checks.json` records syntax/JSON/diff and protected-path checks.

## Browser QA record

Manual interaction used the isolated application at `http://127.0.0.1:3098` and a separate synthetic branding copy at `http://127.0.0.1:3100`; automated mounted-browser fixtures used their own ephemeral local servers and synthetic data. The later branding checks used a separate browser tab/context, preserving the user's open test page and drafts. No production household responses, Tasks, recipes, groceries or preferences were changed.

| Surface | Checks and observed result |
| --- | --- |
| Desktop 1366 × 900 | Blank Home default, template location override, immediate untouched switching, edited-draft warning/Cancel, Template → Blank clearing, inline skilled subtasks, Save as Template parent restoration, and actual Task creation passed. |
| Tablet 768px | Form alignment and persistent actions, List/Schedule rendering and view switching inspected. No new horizontal overflow in edited form surfaces. |
| Mobile 390 × 844 | Inline subtask rows, two-row creation footer, full Task Detail skill metadata, rename/Cancel, and preference disable/reload/restore passed. |
| Theme/typography | Manual checks span Warm, Neutral and Cool in Light and Dark, including Serif headings. Shared-control browser coverage additionally exercises all 18 combinations of three viewport widths, three themes and two appearances with Serif. |
| Workflow dialogs | Launcher lists workflows; child creator and existing workflow preview open through the shared editor. Cancel and browser Back restore the parent. Repeated pending submissions are blocked by focused tests. |
| Kitchen symbol | Mobile navigation now displays the cooking-pot symbol from the shared icon mapping, retaining the Kitchen name; module/navigation guards pass. |
| Notification header and center | Live QA passed on desktop Tasks/Overview/Calendar, tablet Recipes/Meals, and mobile Tasks/Recipes/Meals/Shopping/Pantry/Settings/Calendar in Warm/Dark/Serif. The bell aligns with the module heading; Meals' Today action wraps below date controls on mobile, and Pantry search leaves room for the bell. The Refresh icon works. Controlled browser tests cover singleton adoption, unread state, guest/sign-out/account changes, wall privacy, and pending actions without changing shared live state. |
| Skill creation | Mounted browser tests cover desktop/mobile Task creation, tablet Activity Template nesting, and Task Detail Add/Edit. New Skill Save selects only the originating requirement; Cancel and subsequent catalogue reuse retain the draft. Member-only creation controls remain absent. |
| Cooking Map | Desktop arbitrary pointer drag, compact keyboard chevrons, mobile pointer drag, add/rename/remove ready-state refresh, retained later prerequisites, Cancel/Discard, Save and reload/reopen passed. Desktop 1366, tablet 768 and mobile 390 layouts were visually inspected, including long operation names. Physical touch hardware was not tested. |
| Settings | Before/after screenshots cover overview, Appearance, Notifications and Email at 1366, 768 and 390 px. Search, no-results, permission filtering, unchanged navigation and unsaved-form Cancel passed. Automated layout coverage exercises all 18 theme/appearance/typography combinations at each of 3 widths. |
| Calendar month/year picker | Both selector strips share the left edge at 1366, 768 and 390 px. Month and Day jumps, year changes, Enter, Escape and outside dismissal passed. Tasks year changes remain open and recover keyboard focus; short-month and Week/Agenda cursor handling have focused code coverage. |
| Overview Customize | Before/after captures at 1366, 768 and 390 px confirm the greeting and controls no longer overlap. A long greeting and administrator/reset actions are covered by three full-style browser regressions. Live Cancel made no save request; Save made one personal-layout request without household-default keys, and the bell still opened. |
| Recipe card widths | Before/after captures at 1366, 768 and 390 px show complete readable titles and separately arranged actions. Rendered native/provider regressions additionally cover a 550 px card, optional thumbnails/badges, and Light/Dark Warm/Serif. The 720 px card's title grows from 285 to 674 px; mobile grows from 242 to 302 px. |
| Theme-matched controls | Six real-browser cases verify primary actions, selected controls, navigation, disabled states and focus/selection contrast in Neutral/Warm/Cool Light/Dark, including System appearance behavior. Module and semantic colors remain unchanged. |
| Final Ordoma identity | Seventeen final captures cover all six Recipe palettes, desktop/tablet/mobile, Tasks/Workflows, Calendar, Meals, Cooking Map, notifications, Settings and Housekeeping. All page titles identify Ordoma; no page errors or document overflow were observed. The sidebar O measures 28 × 28 px, and the trigger bottle reads clearly in both sidebar and mobile headings. |
| Reader and Wall Mode | Script-disabled Reader login/navigation works, displays Ordoma Reader and returns private, no-store. Reader retains its intentional light e-paper presentation under a dark OS preference. Wall Mode passed all three widths and all three themes in Light/Dark with Serif; entering closes the inbox and hides the personal bell, and button/Escape exit restores normal navigation. Thirty screenshots record 33 states/interactions without page errors or horizontal overflow. |

Representative retained screenshots: `artifacts/tasks-refinement-qa/new-task-skilled-subtask-1366.png` and `new-task-skilled-subtask-390.png`. Screenshots show the mounted form with the complete shell styles. The live mobile detail before/after inspection specifically confirmed that names no longer wrap one letter per line.

Settings before/after and theme screenshots are retained in `artifacts/settings-visual-qa/`. Those captures use the running isolated application; visual theme variants change only the isolated browser's rendered appearance, without writing household preferences. The mounted-browser layout tests separately verify the complete responsive CSS with actual controls.

The detailed interaction record for Calendar and Cooking Map is `artifacts/tasks-refinement-qa/calendar-cooking-map-qa.md`. It distinguishes actual browser Month/Day jumps from Week/Agenda code coverage and mobile-width pointer dragging from physical touch. Notification header geometry and live Refresh checks are recorded in `artifacts/notification-header-qa/visual-record.md`. Overview Customize before/after screenshots and Save/Cancel observations are in `artifacts/ordoma-brand/dashboard-customize-qa.md`; Recipe title comparisons are in `artifacts/ordoma-brand/recipe-card-qa.md`; Reader and Wall Mode observations are in `artifacts/ordoma-brand/reader-wall-qa.md`. Final logo/control-palette captures and their source-preview limits are documented in `artifacts/ordoma-brand/final-palette-qa/visual-record.md`.

The isolated 3100 server was not restarted solely for the App Name backend change. System-page screenshots verify the removed client control; fixed version/manifest branding and ignored legacy name writes are verified by current-source backend/route tests. Final palette captures bypassed the worker to inspect current CSS and previewed theme attributes locally. Existing preference persistence, service-worker upgrade/privacy tests and the earlier live refreshed-worker logo check provide separate evidence; these screenshot previews are not presented as an installed-device upgrade test.

## Remaining limits

- Existing assignment/completion and administrator-authoring boundaries remain intentional; ordinary subtask skills do not add a new supervision workflow.
- The existing template model does not represent several fixed manual assignees or one-use map locations. Conversion opens the existing editor for review instead of inventing new persisted semantics.
- External CalDAV accounts were covered by regression tests, not a live provider synchronization attempt.
- Cooking Map drag was exercised with browser pointer input on mobile-sized and desktop viewports; physical touch-device testing remains outstanding.
- Physical e-paper rendering and operating-system installed-PWA icon/name refresh were not tested. Reader script-free behavior, manifest identity and browser update/privacy behavior were checked separately.
- Broader architecture and measured performance work listed above remains deferred. No claim is made that every repository test or every historical data combination has been exercised.
