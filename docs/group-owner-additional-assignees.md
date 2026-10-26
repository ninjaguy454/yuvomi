# Group Owner and explicit additional Activity assignees

Migration 10080 adds nullable `additional_assignee_ids_json` policy columns to Tasks and Activity Templates. Existing rows and historical assignments are not backfilled. The API accepts the ordered `additional_assignee_ids` array for a Group Owner, validates household identities, and deduplicates it while retaining first occurrence order.

The source Group stays in `assignment_group_json`. `tasks.assigned_to` remains the recorded occurrence Owner. Direct performers are the union of that Owner and the explicitly configured extras. Selecting the Owner among extras does not count or award that person twice; their configured extra ID remains saved for later occurrences. A missing Owner stays null. Subtask People & Groups remains an independent candidate policy and grants no root assignment.

Current edits preserve the saved Owner and consume no Group cursor turn. The existing assignment and reassignment permissions authorize these edits. Skills, presence, category limits, completion history and ordinary direct-assignment boundaries remain authoritative. Bound Activity responsibility and obligation changes use the existing assignment service. Fixed Person rosters retain their established `assigned_to` / `direct_assignee_ids` and `fixed_assignee_ids` APIs and UI.

Template snapshots, Workflow materialization, recurrence definitions, sparse future edits and reconciliation of existing untouched future occurrences carry the extra policy. An occurrence edit retains the existing future definition; a future edit captures the new policy independently. Reconciliation preserves an already materialized future Owner and its consumed turn. Generation resolves a new Owner once and materializes the eligible union. Captured category limits apply to actual direct people and exclude separate child visibility participation.

Task and Template editors use the existing avatar checkbox controls under **Additional assignees** for the Group path. They preserve configured order, keyboard selection, editor scope drafts, Save as Template visits and the parent Task draft. Fixed Person controls remain in their existing place.

## Verification

- `npm run test:group-owner-extras`: synthetic route, Template API, Workflow, recurrence, permissions, skills, points, cursor and migration cases.
- `npm run test:group-owner-extras-browser`: a disposable real server and database; 330, 390 and 1366 px Task and Template selection, save, reopen and draft return.
- Broader regression coverage uses existing Group assignment, direct assignee policy, Activity binding, Template routes and series generation/edit tests.

No household data, deployment or publication is part of this local change.
