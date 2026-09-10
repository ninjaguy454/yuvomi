# Laundry assignment eligibility review

## Finding

A read-only trace of the deployed `7161d59c1b39a1e26d877a00de4463d08e5d372e` candidate, schema 10030, reproduced the reported no-qualified-helper error. The evaluated Laundry template had no parent skills, independent checklist skill requirements, fixed Home location, and `must_be_at_location` presence. All household members passed the parent skill check. The selected member's stored Normal overrides also passed every checklist skill check. No matching planned presence was available for the evaluated day, so the subject and all potential helpers failed presence.

The original failed HTTP request's date was unavailable. This finding describes the current saved configuration, evaluated on 2026-09-10. An additional failure after actually saving `none`/`ignore` was not reproduced.

The private member-by-member trace is retained as a local ignored artifact, not committed household data.

## Eligibility contracts verified

- Candidate pool excludes guest and housekeeping-worker logins; fixed assignment does not apply to the subject-skill strategy.
- Normal is the string `normal`, rank 2 for aggregate comparison. Explicit overrides, automatic age rules and adult-only safety retain their existing meaning.
- The parent reads only `activity_template_skills`. Checklist skills do not become parent requirements.
- Checklist skill references match current Skills IDs and copy independently into generated subtasks. Renaming preserves IDs; invalid IDs are rejected atomically.
- Task `location` is its displayed location/directions in `task_locations`. It does not override the template presence constraint in `task_planning_context`.
- The template editor and API correctly persist `location_mode: none`, `place_id: null`, `presence_policy: ignore`. The same Normal member is then assignable. Skill qualification is unchanged.

## Bounded correction

The failed subject/helper path previously reported missing qualified help even when Normal members existed and only presence prevented assignment. It now reports that qualified members were found but none meets the location/availability rule, with guidance to check required presence and planned availability. This guidance also applies to workflow-specific presence overrides.

No assignment, proficiency, safety, supervision, location, rotation, or permission rule changes. No profile, template or production data edits. No migration; schema remains 10030.

## Validation

- Eight new Laundry regressions: precise presence failure; Task No Location cannot silently override template presence; saved template Ignore location succeeds; generated skill IDs; Normal accepted and supervised rejected; parent/child independence; renamed/invalid references; supervised subject and blocked helper diagnostics with unchanged supervision/rotation behavior.
- Existing Activity automation service/routes, Task activity binding, Task/subtask skills and migration regressions passed: 41 existing checks. Total affected coverage: 49 distinct checks.
- Five suite-registration checks passed. New tests are included in `test:task-subtask-skills` and the existing integrated test chain.
- Syntax, package JSON and diff/whitespace checks passed.
- Desktop Chrome, fresh loopback-only synthetic household: Task from Home-required Laundry + Normal subject + Task No Location rejected with a presence-specific error. Saving No required location/Ignore location in the actual Activity Template editor then allowed creation of the parent Task and five subtasks. No production browser mutations were performed.
- No mobile/theme pass: no layout, styling or frontend behavior changed.

## Remaining limitation

The trace does not establish why the reported prior Ignore-location edit was ineffective: it was not present in the production template at inspection. Do not disable presence or loosen skills to compensate. If the error persists with a confirmed saved Ignore policy, capture that request's template ID, subject ID and occurrence date and trace it separately.
