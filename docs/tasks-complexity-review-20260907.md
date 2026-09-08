# Tasks refinement: targeted complexity and integration audit

Baseline: `2cf912812897cb9e478831aa0f8205a99872fabd`, inspected before this pass's edits on `feature/tasks-refinement-20260907`. Line references and counts below describe that baseline. Counts include comments and blank lines; bytes are source-file sizes, not compressed download sizes. This is a targeted audit, not proof that every unused file or CSS selector has been found.

## A. Legitimate complexity

The largest modules combine substantial working product behavior. Size alone does not justify deleting it.

| Frontend JavaScript | Lines | Bytes | Main responsibility |
| --- | ---: | ---: | --- |
| `public/pages/tasks.js` | 5,554 | 269,055 | List, Kanban, Schedule, history, filtering, form/edit integration, assignment, attachments |
| `public/pages/calendar.js` | 5,015 | 231,097 | Multiple calendar views, event forms and provider integration |
| `public/pages/health.js` | 4,948 | 224,233 | Multiple health records and workflows |
| `public/pages/meals.js` | 4,872 | 293,798 | Participation, menus, planning contexts, Meal Plans, portion display |
| `public/router.js` | 4,720 | 214,536 | Shell, navigation, user/device modes, global interactions |
| `public/pages/dashboard.js` | 4,435 | 215,656 | Household overview and module widgets |

| Backend JavaScript | Lines | Bytes | Main responsibility |
| --- | ---: | ---: | --- |
| `server/db.js` | 9,087 | 478,286 | Schema, retained migration history and database initialization |
| `server/services/meal-plans.js` | 5,042 | 237,204 | Context-aware Meal Plan generation, choices, responsibilities and history |
| `server/auth.js` | 2,726 | 119,550 | Authentication, sessions, access and account flows |
| `server/routes/tasks.js` | 2,658 | 129,580 | Task mutations, filtering, tags, ownership, recurrence, attachments and integration |
| `server/routes/meals.js` | 2,494 | 114,810 | Meal API and compatibility workflows |
| `server/services/cardav-sync.js` | 1,495 | 53,283 | Contact synchronization and reconciliation |

Large stylesheets include `public/styles/layout.css` (7,056 lines), `dashboard.css` (4,912), `settings.css` (3,740), `meals.css` (3,253) and `tasks.css` (3,250). Responsive layouts, themes and display modes account for legitimate variants. No stylesheet is declared dead merely because a removed renderer once used its selectors.

Already-shared components should remain the foundation: `components/task-detail.js` supplies the common detail view; `utils/task-fields.js` centralizes task labels, people, progress and display semantics; `components/user-multi-select.js` supplies the Task form's people picker; `components/modal.js` owns modal/history behavior. Activity Templates already have one editor, `openActivityForm`, and workflows already have one editor, `openWorkflowForm`, both in `components/activity-automation.js`. New entry points should invoke those editors rather than copy their forms.

## B. Safe duplication and dead code

Repository-wide reference searches confirmed the following **non-exported local functions have no callers** in baseline `public/pages/tasks.js`:

| Function | Baseline location | Disposition |
| --- | --- | --- |
| `initials` | line 122 | Removed unused helper |
| `renderLegacyTaskCard` | lines 531–646 | Removed superseded card implementation |
| `renderLegacyKanban` | lines 2458–2533 | Removed superseded board implementation |
| `renderLegacyFilters` | lines 3554–3779 | Removed superseded filter implementation |
| `wireLegacyViewToggle` | lines 4270–4316 | Removed superseded view wiring |

These five bodies accounted for approximately 470 lines. Their active replacements are `renderTaskCard`, `renderKanban`, `renderFilters` and `wireViewToggle`; they did not preserve a storage format, public export or live compatibility route. The follow-up reference check also identified the now-orphaned `renderDueDate`, `renderKanbanCard`, `renderTagBadges` and `kanbanNextStatus`, which were removed along with unused `nowFields` and `zonedUTCProxy` imports. The active List, Kanban and Schedule renderers remain.

Two additional bounded consolidations were completed:

- Baseline `tasks.js:1610` had `toggleTaskStatus`, with the same endpoint, request and next-state calculation as the already-imported `toggleSubtaskStatus` in `task-detail.js:59`. The duplicate helper is removed and active callers now use the shared implementation.
- New Task/subtask skill selection and Activity Template checklist rows now use `components/task-requirements.js` and `styles/task-requirements.css`. Task Detail's existing inline subtask editor uses the same skill picker. The Activity Template and Workflow entry points continue to reuse their existing editors rather than introducing alternative authoring forms.

No globally unreferenced source file has been proven removable. No blanket dead-CSS deletion is recommended. The frontend `normalizeTagList` and backend `normalizeTags` look similar but are **not identical**: backend normalization also accepts comma-separated input and rejects `.` and `..`. Do not replace one with the other without explicitly retaining those contracts and running tag tests.

## C. Architectural debt to retain for a separate pass

- **Multiple legitimate Task writers.** Manual REST creation (`routes/tasks.js:1327`), Task duplication (`:1942` and `:1980`), workflow generation (`services/activity-workflows.js:415`), activity binding/supervision (`services/task-activity-bindings.js:355`), checklist materialization (`services/activity-template-checklist.js`) and MCP creation (`mcp/tools.js:111`) all write Tasks. They differ in recurrence, provenance, permissions, generated responsibilities and identity. A broad common creation service is valuable future work, but moving every writer now would enlarge risk substantially. Reuse the existing checklist materializer for this pass's skill propagation.
- **Large mixed frontend modules.** `tasks.js` holds view state, rendering and form orchestration; `activity-automation.js` (1,754 lines) combines Skills, Activities, Workflows, Places, Trips and availability. Extract bounded reusable controls as the requested behavior needs them. Splitting modules purely by line count is deferred.
- **Compatibility that still serves real behavior.** Archived Task status input, CalDAV target fields, generated activity bindings and old Meal/plan adapters have active callers or persisted data. Their age is not evidence of obsolescence.
- **Date/time contracts are not interchangeable.** Similar-looking date helpers may represent household wall time, UTC instants or date-only values. Do not consolidate them by textual similarity; the broader timezone contract remains a dedicated follow-up.
- **Polymorphic reminder cleanup remains necessary.** The Task frontend's reminder DELETE after deleting a Task is not proven redundant: the Task DELETE route does not itself remove polymorphic reminder records through a Task foreign key. Consolidate cleanup only with explicit backend ownership and regression coverage.

## D. Suspected performance issues: measure first

These are verified source-level request patterns, **not measured latency or production load findings**:

| Pattern | Evidence | Next measurement |
| --- | --- | --- |
| Seven parallel requests on initial Tasks render | `tasks.js:5445–5457`: Tasks, metadata, preferences, activities, obligations, Places, Place-search status | Request timing/size; identify catalogs that can load only when needed |
| Four catalogs fetched whenever the external/shared Task detail entry is opened | `tasks.js:5218–5223`: activities, Places, Place-search status, preferences, in addition to Task/reminder loading and occasionally metadata | Measure repeated opens; distinguish freshness requirements from redundant reloads |
| One additional sync-target request per eligible Task editor mount | `tasks.js:464–473` | Verify whether configured-target defaults require it; avoid weakening unavailable-target preservation |
| One presence request per member after the availability context request | `activity-automation.js:964–971` | Household-size/request timing; consider a batch endpoint only if measured cost warrants it |

The shared `api.js` already centralizes credentials, CSRF, JSON and error handling. The audit found repeated calls and orchestration, not a need for a second API client or speculative global caching. No claim about response duration, database query cost or actual network duplication has been made without a runtime measurement.

## Sync Target and Reminder Lists classification

| Concept | Classification | Why it exists | UI disposition |
| --- | --- | --- | --- |
| Task **Sync target** | Advanced/integration-only control | Selects the enabled external CalDAV VTODO list that receives a locally created Task | Hide from the normal blank +Task flow; offer an explicit external-sync disclosure only when an integration is configured or the Task already has a target/mirror |
| **Reminder Lists** settings | Advanced/admin integration control | Discovers CalDAV lists and maps each enabled list to Tasks or Shopping | Keep in Synchronization settings; clarify that these are external task/shopping lists, not Yuvomi notification reminders |
| `tasks_default_target` | Active per-user integration preference | Chooses the default external list for that user's new Tasks | Preserve existing personal settings and creation behavior |
| `target_caldav_account_id`, `target_caldav_list_url`, external mirror fields | Active backend integration state | Queue uploads, retain external identity and route bidirectional updates | Preserve fields, validations, queues, existing records and public API |

Evidence chain:

1. `public/pages/tasks.js:429–509` renders the selector, loads options, applies the personal default and preserves an unavailable saved target. It omits subtasks and shows immutable mirror status instead of offering unsupported list movement.
2. `server/routes/tasks.js:79–98` validates the target against enabled `caldav_reminder_selection` rows with `target_module = 'tasks'`. Lists mapped to Shopping are deliberately excluded. `GET /tasks/sync-targets` at `:697` exposes the safe list metadata to authenticated members. POST/PUT save the pending target and trigger outbound work.
3. `server/db.js`, migration **136**, introduced the pending-target fields as the upstream outbound Task integration. This is active functionality, not an abandoned compatibility shim.
4. `server/services/caldav-reminders-sync.js:199` changes list mappings; inbound processing creates/updates Tasks and resolves parent/subtask relationships. Its sync loop calls `todoOutbound.processPendingCreations` for Tasks and `processPendingShoppingCreations` for Shopping. Removing reminder-list state would break both directions.
5. `server/routes/calendar/caldav.js:138–180` exposes admin discovery/configuration/sync routes. `public/settings/pages/sync-reminders.js` is the existing admin UI. `settings/registry.js` marks it admin-only.
6. `public/settings/pages/personal-tasks.js:24–126` and `server/routes/preferences.js:875–887` already provide a per-user default list using `cfgUserGet`/`cfgUserSet`; keeping it out of household-wide configuration is intentional.

Hiding the selector must **not** silently clear an existing target, stop applying a valid personal default, or invent list movement for an already-uploaded mirror. A stored but unavailable target must remain recoverable in the integration UI. No backend deletion is justified. Production account/list counts were not obtained in this audit; supported and live code paths are proven, but the household's current external account usage is not asserted.

## Codebase health assessment

Yuvomi has a large supported feature surface, plus some definite retained frontend implementations and several mixed-responsibility modules. It is not defensible to label all of that as bloat. The highest-value bounded cleanup is to remove the proven unused Task renderers, keep one canonical Task form and reuse the existing Activity/Workflow editors plus shared skill/checklist primitives. A later review can consolidate Task writers with explicit contracts and measured catalog loading, without changing assignment, recurrence, grocery or synchronization semantics.

## Final implementation checkpoint

The cleanup above was rechecked against the settled Task form on 2026-09-08. `public/pages/tasks.js` is 5,055 lines / 245,557 bytes, compared with baseline 5,554 lines / 269,055 bytes: a net reduction of 499 lines and 23,498 bytes despite the new Task form behavior. This is source size, not a measured performance improvement or a repository-wide size reduction. Shared editor, draft-model and test files were added deliberately; extracting them does not by itself prove a reduction in total application complexity.

The later approved Calendar picker parity request also extracted the existing Tasks month/year renderer and styles into `components/month-year-picker.js` and `styles/month-year-picker.css`. Each module retains its own cursor and navigation behavior. The Settings overview reuses the existing sidebar search and guarded links rather than adding a second search or routing implementation.

The normal Task form now puts configured external targets inside an explicit external-calendar-sync disclosure. Existing targets, personal defaults, mirrored-task behavior and backend CalDAV data paths are retained. The warning preference uses the existing per-user configuration store and is reversible in personal Task settings. No API client, global cache, task-writer architecture or timezone-contract rewrite was introduced.

Architectural and performance recommendations in sections C and D remain deferred. No blanket file/CSS purge or production integration-data cleanup was performed. Behavioral and browser results belong in the final implementation report; this audit does not substitute source-size reduction for those checks.
