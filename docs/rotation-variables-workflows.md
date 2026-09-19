# Rotation values and Task Workflows

Rotation values use the existing typed expression engine. They are not executable templates and reading one never creates, resolves, finalizes or advances a Track.

- `rotation_group`: a named Group reference, hydrated from a validated database ID. Supports `id`, `name`, `description`.
- `rotation_occurrence`: an immutable resolution reference, hydrated from its recorded history. Supports `order`, `selected_member`, `position`, `status`, `strategy`, `id`, `track_id`. `position` is supplied for the contextual household member when a consumer renders its current occurrence.
- `household_member_list`: an ordered, unique, bounded list of typed household members. Saved inputs store IDs; expression results retain safe member metadata. Historical Rotation results retain their recorded names even if a member is later renamed.

The pure expression functions are `rotationOrder(occurrence)`, `rotationSelected(occurrence)`, `rotationFirst(occurrence)`, `rotationLast(occurrence)`, `rotationPosition(occurrence, member)`, `rotationNext(occurrence, member)` and `rotationPrevious(occurrence, member)`. Positions are one-based; an absent member has a blank position. Next and previous wrap within that occurrence's order. Member-order comparisons should use calculated Yes/No values rather than an untyped condition string.

A configured Activity or Workflow purpose makes its key available as a calculated Rotation Occurrence. For example, a purpose with key `shower_order` supports `Tonight: {{shower_order.position}}` in an Activity field. A Workflow Number variable can calculate `rotationPosition(shower_order, context.household_member)`. To reference member metadata in another expression, calculate a Household Member value with `rotationFirst(shower_order)`, then use that variable's normal member properties.

## Shared Workflow occurrence

A Rotation purpose configured on a Workflow belongs to the Workflow template/purpose Track. One Workflow run owns one Rotation Occurrence. The generated parent Task holds the durable binding and all descendants inherit that exact occurrence. Child-specific text and contextual position use the child's subject/assignee against the same recorded order. Individual child completion cannot advance the parent Track; completion of the Workflow parent settles it once through the existing lifecycle adapter.

An Activity-local purpose on a Workflow step is separately owned by that stable step. Copying an Activity Template into multiple independent steps does not accidentally share their Tracks. Configure the purpose once on the Workflow when its child Activities should share one nightly order.

The launcher retains a request key across creation retries. The server transaction records the Workflow instance, Rotation snapshots and reviewed result against `(workflow template, actor, request key)`. Reusing a key with different inputs returns a conflict; retrying the same request returns the recorded result without creating more Tasks or advancing. New previews do not persist Rotation state. The pre-existing legacy assignment preview retains its rollback-only simulation so repeated assignment steps still preview their established behavior.

Authorized integrations can inspect `/automation/workflow-instances/:id/rotations` or record a contextual outcome at `/automation/workflow-instances/:id/rotations/:purpose/outcome`. Outcome requests require the existing Workflow and Task permissions plus `rotations.advance`, and carry `expected_revision`. The UI does not require users to create or manipulate Track IDs.

## Boundaries and validation

Client-supplied snapshot objects are rejected; editable inputs provide IDs only. Workflow resolution/configuration and contextual operations enforce Rotation capabilities. Rotation Occurrence variable inputs additionally require history access. Streams and other clients remain responsible for fetching authorized current representations, not trusting a typed expression as authorization.

`renderRotationVariableTemplates` is a read-only bridge for already resolved consumer contexts. It returns rendered values plus the required expression definitions and input IDs so a recurring series can preserve authored expression provenance without consulting a later edited source Template. It also identifies whether a field actually depends on Rotation; unrelated interpolation retains existing behavior.

Focused evidence: `.qa/rotation-workflow-final-backend.log` (95 checks: 93 passed; two unchanged baseline failures), `.qa/rotation-workflow-browser.log` (18 passed), `.qa/rotation-workflow-new.log` (8 new checks passed). The unchanged baseline failures reproduce in `.qa/rotation-base-cf4b5e2d` from the clean starting commit: a historical supervision-title expectation, and an existing isolated launcher fixture missing `activityTimingFields`. No failed browser launch is counted as a pass.
