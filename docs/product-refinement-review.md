# Yuvomi product and software refinement review

Review date: September 6, 2026.
Repository: `ninjaguy454/yuvomi`.
Published baseline: `de4be2702dee7f1cd9828f01f9ab6c7b4bd0ad04`.
Review branch: `audit/product-refinement-2026-09-06`.
Product changes: `b80ae634a37897920923946b97b4b2c17af04810`.
Browser regression harness: `ce395823bfbdf91faf274a351dddc06f0324e521`.

## 1. Executive summary

Yuvomi has a coherent foundation, not a failed design in need of replacement. Tasks, the four-part Kitchen, Calendar, planning contexts, and Household Automation are recognizably parts of one product. Shared navigation, cards, dialogs, theme tokens, and mobile-specific views already do substantial useful work. The fork's role, eligibility, availability, location, and grocery-lifecycle distinctions represent real functionality. Flattening those distinctions would make the product less capable and can change who receives work.

The larger weakness is that product complexity has outpaced some shared interaction contracts and release checks. Small common-layer defects can affect many modules. Meal planning also asks users to understand several overlapping scopes and asks the frontend to reconcile several read models. Those are better targets than a visual reskin.

This pass fixes demonstrated, narrow defects: first-install service-worker reloads, inappropriate forbidden-write retries, missing form-label associations, a latent Kitchen helper error, and three test-coverage/fixture problems. It does not alter database schemas, assignment rules, meal semantics, permissions, or the navigation architecture.

The fork is not release-clean. After these changes, 277 of 281 test commands passed in an independent full matrix. Four existing failures remain. Two concern meal responsibility expectations; they require an explicit contract decision rather than changing production behavior merely to satisfy a test. Two concern translation and OpenAPI documentation coverage.

### Scope and confidence

The review used the published repository snapshot and a running, disposable demo household. It did not inspect the user's production household or an unpublished local checkout. The disposable app used the actual server, migrations, frontend, service worker, and seeded database, rather than mocked page screenshots. No production deployment or merge to main was performed.

Evidence is distinguished throughout: browser observations are reproduced behavior; source findings identify concrete implementation paths; recommendations about better organization are product judgments. This is not a security certification, exhaustive accessibility audit, production performance benchmark, or proof that every provider integration works.

## 2. Product findings grouped by root cause

### A. Shared interaction contracts are inconsistent

**Evidence:** The baseline Chrome accessibility tree exposed four unnamed controls in the New Skill dialog, nine in New Place, and one in New Task. Many automation editors use the same `inputRow` helper, whose visible label was not programmatically associated with its control. Task location branches also had fields without persistent accessible names.

The first service-worker takeover reloaded a previously uncontrolled page. A real first-login attempt was interrupted. The API client separately retried all state-changing 403 responses as token failures, even though permission denials and invalid-CSRF errors are distinct server responses.

**Impact:** These are common-path defects rather than individual screen blemishes. Labels affect keyboard/assistive-technology use across editor families; a reload can erase entry; an unnecessary retry delays the original error and repeats a denied request.

**Action:** Implemented narrow shared fixes. No controls were added or removed, no permissions were loosened, and later service-worker upgrades retain their existing once-only refresh.

### B. Powerful scopes are visible, but their hierarchy is demanding

Kitchen already groups Meals, Recipes, Shopping, and Pantry sensibly. The Meal Plan manager also separates Meal Plan, Meal Defaults, and Grocery Settings. However, a person must distinguish Home/All planning context, reusable Meal Plan, the people being planned for, chooser obligations, and execution roles. These are not interchangeable concepts. Existing explanatory text helps, so adding more generic hints is not the answer.

Mobile Meals uses a focused daily presentation rather than compressing the desktop week into unreadable columns. That is a sound choice. Its lower action strip includes Timeline, Meal Plans, and Prepare this week. At 390 pixels, the last action is partly offscreen until that strip is scrolled. My Choices and Meal Status are a separate, fully visible mode switch. This is a discoverability tradeoff, not document-level overflow or justification to remove an action.

Household Automation similarly has Skills, Activities, Quick Add Templates, and Variables. Their distinctions are functional, but a less technical household member may not know which object they need. Settings already has a registry, grouping, and search; a wholesale settings replacement would discard useful structure.

**Recommendation requiring a product decision:** Agree on user-facing vocabulary and a single scope summary for meal operations before reorganizing actions. Make the first choice answer the user's intent, while keeping advanced scope and role controls available. For automation, clarify when to create a recurring activity versus a reusable quick-add template. Preserve existing objects and links.

### C. Task consistency is stronger than a superficial redesign would suggest

Task creation, details, and editing already share important field/role conventions. Assignee, participant, supervisor, and subject are not synonyms. Meal chooser and execution responsibility are also distinct. Existing advanced fields should not be flattened into a generic assignee control.

The concrete change here is accessible naming of location controls in the existing creation/editing paths. No new task form, alternate mutation path, or replacement detail view was introduced. The existing modal/history system was retained.

### D. Display modes are intentional products, not theme exceptions

Desktop/mobile and light/dark baseline screens have a consistent visual foundation. Calendar uses a mobile agenda-oriented view and desktop month view. The late-night wall presentation is deliberately sparse. Reader is a separate, monochrome, low-JavaScript reading experience intended for a different display context. Neither should be treated as broken simply because it does not mirror the normal dashboard.

Wall mode is a presentation mode, not automatically a restricted kiosk security boundary. Whether a shared display should have a separate restricted session is a product/security decision, not a CSS change. This pass does not claim that hiding a control establishes permission enforcement.

## 3. Backend and architecture issues affecting the product

### A. Meal read composition has overlapping ownership

`public/pages/meals.js` initializes several overlapping sources: meals, shopping, categories, selection requests, preferences, planning data, recipes, a week model, and status. One baseline cold desktop navigation recorded 17 API responses including shell requests, with repeated preferences/version retrieval. This is an observed request count, not a measured user-visible latency improvement or a load benchmark.

Some optional requests catch failures and use empty arrays. That can make unavailable supporting data look like genuinely empty data. Other planning/week paths already have explicit failure handling, so this should not be generalized to the whole application.

`server/routes/meals.js` also reconciles chooser obligations, including stale/timeout handling, during selection-request retrieval. That can be intentional, but a GET can therefore do more than retrieve a stable snapshot.

**Needs architectural decision:** Define the canonical meal-page read/composition boundary and explicitly document when reconciliation is allowed to mutate obligations. Only then consolidate requests or move reconciliation. Do not delete compatibility paths solely because they look duplicated; some support historical or migration contracts.

### B. Eligibility and assignment contracts need explicit reconciliation with tests

Two unchanged behavioral expectations fail:

- `test:phase6-grocery-lifecycle`: five execution Tasks are created, but three `meal_execution` responsibility rows exist where the fixture expects five. The failure is not proof that two Tasks were never created.
- `test:meals-routes`: a materialized recurring meal has a participant responsibility but no chooser responsibility where the fixture expects both. The test stops at that assertion, so this is not evidence of duplicate occurrences or broken deletion exceptions.

Fixture eligibility and the implemented age/skill rules are relevant. The safe conclusion is that the expected contract and the current fixture/implementation disagree. It would be unsafe to bypass eligibility or assign an otherwise ineligible child simply to turn those tests green.

**Needs product decision:** Confirm which roles require which eligibility, how an ineligible configured person is presented, and whether the expected outcome is an unassigned obligation, fallback assignment, or another existing behavior. Then repair the fixture or implementation against that agreed contract with focused tests.

### C. Release checks drifted from the application

An existing meal-change-notification migration test was not registered in the npm test chain. The push test's minimal database lacked the `meals` table now referenced by the shared notification query. A Swiss formatting assertion pinned one apostrophe glyph even though ICU versions can use another.

Those three problems were repaired without modifying production notification or formatting behavior. The remaining localization and API documentation gaps are recorded below. A green partial run should not be represented as a green complete repository.

### D. Permission, migration, and offline boundaries were preserved

The API retry correction uses the existing explicit CSRF rejection message. It does not reinterpret every 403 or bypass authorization. Migration files, schemas, and database version were not changed. The service-worker correction does not change the read-only API caching allowlist or cached-user-data policy.

Source and existing tests provide useful coverage of migration reconciliation, role boundaries, history, and offline behavior. They do not replace real account-switch, installed-PWA resume, upgrade, and backup/restore checks on household data.

## 4. Prioritized refinement plan

Cost is relative, not a time estimate. Ordering considers user impact, correctness/risk, frequency, then cost.

| Priority | Root cause / recommendation | Classification | Relative cost | Outcome |
|---|---|---|---|---|
| P1 | Preserve entry on initial service-worker takeover | Safe to implement now | Small | Implemented, focused regression added |
| P1 | Separate permission denial from confirmed CSRF recovery | Safe to implement now | Small | Implemented, error/retry cases tested |
| P1 | Associate shared editor labels/help and name Task location controls | Safe to implement now | Small | Implemented in existing shared paths |
| P1 | Restore missing test registration and valid fixtures | Safe to implement now | Small | Implemented, no production policy changes |
| P1 | Resolve meal role eligibility versus failing expectations | Needs product decision | Medium | No assignment semantics changed |
| P2 | Establish canonical Meal read state and reconciliation boundary | Needs architectural decision | Medium/large | Recommendation only |
| P2 | Clarify Meal scope and automation-object vocabulary | Needs product decision | Medium | Recommendation only |
| P2 | Correct Kitchen membership helper's imported binding | Safe to implement now | Very small | Implemented; latent bug, not a claimed visible speedup |
| P2 | Complete missing translation and API documentation coverage | Defer | Small/medium | Required before claiming full release readiness |
| P3 | Decide whether wall display needs a restricted kiosk session | Needs product decision | Medium | Presentation and authorization left distinct |
| P3 | Hidden-field focus-trap stress cases and broader assistive-device matrix | Defer | Medium | No modal/history rewrite on an unconfirmed defect |
| P3 | Large-file decomposition, broad schema cleanup, redesign, framework replacement | Defer | Large | No demonstrated benefit warrants this scope/risk |

## 5. Changes implemented

### Product code

`public/api.js`: parse the response once and retry a forbidden write only when the server explicitly reports `Invalid CSRF token.`. Preserve the original permission error, response metadata, token-refresh fallback, and the existing single-retry limit.

`public/sw-register.js`: distinguish first controller adoption from replacement of an existing controller. Initial adoption does not reload the current page; subsequent upgrades still reload once.

`public/components/activity-automation.js`: connect existing visible labels to their fields, preserve existing IDs, generate IDs only where absent, and associate help text with `aria-describedby`. The helper preserves existing field names, values, and event-hook IDs.

`public/pages/tasks.js`: give 11 existing location/search controls persistent accessible names, including dynamically shown location branches. No task role, scheduling, or assignment logic changed.

`public/utils/kitchen-tabs.js`: use the canonical imported module list in `isKitchenModule`. The old function referenced a name that was re-exported but not available as that local binding. No current caller was found, so this is a latent correctness fix rather than a claimed active Kitchen failure.

### Tests and review tooling

`package.json`: register and include the existing meal-change-notification migration test.

`test/test-api.js`, `test/test-sw-upgrade.js`, and `test/test-kitchen-tabs.js`: add focused coverage for the changed contracts.

`test/test-push.js`: add the required minimal meals fixture table. `test/test-region-presets.js`: accept the two known Swiss grouping apostrophe variants while retaining the locale, number, and decimal expectations.

`test/product-refinement-regressions.browser.mjs`: add real-browser inspection/regression coverage against a fresh demo database. The retained workflow has read-only repository permissions, no deployment step, and no persistent checkout credentials. Temporary source-transfer and apply scripts were removed from the branch tip.

The product-only commit changes five existing frontend files, five test files, and package test registration. The review branch additionally retains the browser harness, read-only workflow, and this report. No application file was replaced wholesale. No feature, migration, role, or working integration was deleted.

## 6. Decisions needed

The highest-priority decision is the intended meal-role eligibility contract. Settle that before changing responsibilities or calling the branch release-ready. The default recommendation is to preserve current age/skill protections and correct fixtures only where they fail to describe eligible participants.

Next, choose consistent language for a planning context, a reusable Meal Plan, the people being planned for, a chooser obligation, and execution work. For automation, distinguish a recurring activity from a reusable quick-add template in user-facing language. Presentation should become simpler without merging the underlying concepts.

Finally, decide whether wall mode needs a dedicated restricted-session product. If it does, its authorization model should be explicit and tested rather than inferred from hidden navigation.

## 7. Deferred work

Two translation keys are absent from the base locale: `meals.planDefaultsSaveFailed` and `meals.grocerySettingsSaveFailed`. Existing English fallback messages mean this is not evidence that users always see raw translation keys. Complete the supported-locale pass rather than weakening the coverage test.

OpenAPI lacks GET and PUT `/api/v1/meals/grocery-settings/contexts/{contextId}` and PUT `/api/v1/meals/plans/{id}/home`. The handlers exist. The gap is the documented integration contract, not proof that those routes are unavailable.

Broader device, assistive-technology, offline/account-switch, slow-network, external-provider, multi-day automation, and production-scale performance testing remains separate. A possible hidden-control focus-trap issue from static inspection was not promoted to a confirmed defect or used to justify a modal rewrite.

Large architectural cleanup and visual reskinning are deliberately deferred. The next improvement should address a demonstrated user cost, not the aesthetic preference of the reviewer.

## 8. Tests and browser QA

### Automated tests

The original `npm test` stopped on the grocery-lifecycle responsibility assertion. Its remaining leaf commands were run independently so later failures were not hidden by fail-fast execution.

After refinement, all 281 registered leaf test commands were run independently: **277 passed, four failed**. The remaining failing commands are `test:phase6-grocery-lifecycle`, `test:meals-routes`, `test:i18n`, and `test:openapi-coverage`. They also failed against the unchanged baseline. There is no claim that `npm test` is now green.

The focused CI run passed all eight selected suites: API 18/18, service-worker upgrade 4/4, Kitchen tabs 9/9, migration 3/3, suite-chain 5/5, push 22/22, region presets 14/14, frontend audit 346/346. The full matrix used identical application source; the two local/remote test-file differences were comments/blank lines only.

### Browser baseline

Real Chromium inspection used desktop 1440x1000 and mobile 390x844, light and dark themes, a fresh synthetic household, and the application's actual server/service worker. It covered Dashboard, Tasks, all four Kitchen routes, Calendar, Settings, Household Automation, Places, Reader, wall mode, and several editor dialogs.

The baseline produced 67 observations with no page JavaScript exceptions and no document-level width overflow. A late mobile-dark Places request hit the real API rate limiter during rapid automated navigation. That screen was not treated as a valid successful check. The refined harness spaces viewport/theme groups rather than weakening production rate limits.

### Refined browser verification

The final read-only CI job passed on `ce395823bfbdf91faf274a351dddc06f0324e521` using Node v22.23.2 and Chrome 152.0.7977.42 (Actions run `34012860955`). It recorded **74 captured states**, **17 successful interaction checks**, and **18 successful regression checkpoints** across desktop 1440x1000 and mobile 390x844, in light and dark mode.

The captured states contained no recorded page exceptions, failed API responses, document-level horizontal overflow, or unnamed controls in the inspected Chrome accessibility trees. These are scoped observations, not an exhaustive accessibility or error-handling certification.

The New Task, New Skill, and New Place checks improved from one, four, and nine unnamed controls respectively to zero. The browser checked native label focus, unique IDs, help-text associations, and dynamically revealed Task location fields. It also verified that the Activity editor's existing assignment/location IDs and change listeners still work.

Place creation and editing completed a real API round trip with a name containing `<`, `>`, `&`, and quotation marks. Task creation/details/editing screens were inspected; this is not a claim that every Task submission combination was exercised. Escape closed the Task, Meal Plans, Skill, and Place dialogs in all four viewport/theme combinations. The existing Tasks to Household Automation shell Back/Forward sequence passed without a navigation rewrite.

First service-worker adoption preserved the login draft in all four combinations. The subsequent-upgrade refresh behavior is covered by the focused service-worker test; installed iOS PWA upgrade/resume behavior was not tested on physical hardware.

Early browser harness attempts exposed test setup problems: first-run worker timing, probe-field clearing, a submit button intentionally moved to the modal footer, and waiting for a refreshed Place list. Those harness issues were corrected rather than changing working application behavior to satisfy a bad selector. The final run completed successfully. Selected screenshots were visually inspected in addition to the automated checks.

## 9. Remaining risks and handoff

Do not merge this branch on the assumption that the complete repository is green. Resolve the two meal expectation failures, translation coverage, and OpenAPI coverage first, then rerun the complete suite.

This review is anchored to the published baseline. Any newer unpublished integration branch must be compared before applying these commits. The product-only commit and patch, which passed a clean-baseline applicability check, make that review easier; do not replace an unpublished workspace with this snapshot.

Browser viewport emulation is not physical-device testing. Chromium accessibility-tree checks are not an NVDA, VoiceOver, or WCAG conformance certification. Synthetic data cannot prove production migrations, provider credentials, shared-display privacy, or long-running automations. Travel/availability and grocery lifecycle were inspected in source and automated tests, not by executing a real household's complete travel or meal-planning week.

Later service-worker upgrades retain the existing refresh policy. Deciding to protect drafts during every upgrade would be a separate lifecycle/product change, not something silently included in the first-install fix.

The intended next step is a contract-focused meal eligibility decision, followed by a small presentation pass for meal/automation terminology. A broad revamp is not the best use of effort here.
