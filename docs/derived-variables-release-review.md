# Derived variables — release review, 10 September 2026

Verdict: **READY**. This bounded feature extends the existing variable and
template paths; it does not introduce general scripting or a parallel renderer.
See [usage and architecture](derived-variables.md).

## Delivered

- Optional versioned expressions on reusable definitions and workflow-local
  questions; canonical linked definitions remain shared.
- Typed Member/Place references; allowlisted metadata and scalar helpers.
- Dependency validation, missing-input errors, safe renaming and deletion guards.
- One shared parser/evaluator; server revalidation before previews and writes.
- Existing variable editors now offer input, saved value and calculated value
  sources, function/property help, member-ID insertion and live sample results.
- Optional explicit member first name, last name and nickname in existing
  Account/member editors; consistent hint translations across all 24 locales.
- Activity drafts, workflow Tasks, titles, descriptions, checklist and initial
  supervision text use the existing interpolation path with resolved values.
- PWA cache generation advances to `vidamia.4`; new editor/parser/profile assets
  refresh together. Technical application identity and private-cache rules stay
  unchanged.

## Validation

Final affected matrix: **535 passed, 0 failed, 0 skipped**.

| Group | Passed |
| --- | ---: |
| Expressions, metadata/migration, workflow and Task backend | 165 |
| Admin password-reset compatibility | 3 |
| Auth, invitations, SSO and family compatibility | 173 |
| Workflow launcher, Task fields and recovery | 37 |
| PWA, schema, API, locale and dependency guards | 129 |
| Mounted expression/profile/+Task browser tests | 28 |

All 30 changed JavaScript files pass syntax checks; all 52 tracked JSON files
parse; diff/whitespace checks pass. Existing frontend audit checks also passed
after completing the profile hint translations. New tests are registered in
the appropriate normal/browser test chains. The pre-existing mobile Meals
test was also connected to its missing browser-chain entry.

An initial Windows test-process teardown assertion was resolved by limiting
forced exit to the legacy admin-password-reset harness that leaves a server
running. The affected auth suites then passed; no application workaround was
introduced. The shared parser is explicitly registered in the repository's
pure isomorphic-module allowlist.

## Browser evidence

In the actual isolated application, a member was edited to first name Grace,
nickname Gracie, display name Gracelynn LaPrease. A reusable Member input and
derived name were created through the UI. Nickname fallback preview returned
Gracie, then automatically changed to Jamie Learner when another member was
selected. Invalid private-property access showed a clear inline error.

An Activity Template using `{{derived_name}}'s Laundry` generated **Gracie's
Laundry** and **Wash the laundry for Gracie.** through the ordinary +Task form.
A workflow linked to the same reusable formula asked only for its Member input,
previewed the derived title and created a **Laundry for Gracie** parent Task.

Desktop 1366×900, tablet 768px and mobile 390×844 layouts were inspected. Mounted
editor tests exercise Warm/Neutral/Cool × Light/Dark and Serif. Fields, controls,
help, errors and wrapping fit their dialogs. Screenshots are retained under
`artifacts/derived-variable-ui/` and `artifacts/member-name-editor/`.

## Correctness findings addressed

- Unrelated invalid saved entity defaults no longer block another expression.
- Booleans, arrays, objects and unsafe numeric IDs cannot coerce into Members.
- Inactive transitive dependencies fail clearly.
- Repeated Activity recalculation preserves manually edited Task/subtask text.
- Late preview callbacks cannot restore stale results or overwrite a new template.
- Recurrent supervision uses frozen parent text when original variable inputs
  are unavailable, preventing unresolved placeholders without adding Task state.

## Migration and limits

Migration 10030 is additive: three nullable name fields on users and one nullable
reusable-expression document. A populated 10029 database upgrades once, retains
existing values/history, and restarts without replay. No previous migration is
modified; deployed portions and grocery accounting are unchanged.

Created Tasks and recurring Task text remain snapshots. Profile/formula changes
affect future template runs, not existing Tasks. New structured entity types,
arithmetic, scheduling and ongoing Task recalculation are outside this feature.
Existing profiles need explicit optional names entered to use those properties;
display-name fallback works immediately. Production release evidence is recorded
separately after the exact committed candidate is deployed.
