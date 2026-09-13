# Task helper responsibilities

After resolving a Task's actual learner, the shared supervision resolver evaluates each explicit action requirement:

- Independent: the learner performs the action.
- Supervised: the learner performs it with the Task's one helper. The assigned helper records completion using the existing synchronized supervision rule.
- Excluded: the helper performs the entire action instead. The learner cannot complete or reopen that action. The helper must independently qualify for every explicit skill on it, including skills the learner already knows.

One helper must cover the intersection of all remaining supervised and delegated requirements. Supervised actions require an eligible shared window; delegated actions require the helper's own Availability/Presence eligibility. Missing qualifications or availability leave helper work unresolved without removing the learner Task. Whole-Activity assignment, claim and obligation-acceptance qualification requirements remain unchanged; an excluded child action no longer disqualifies its learner from the structured Task.

The original action remains in the occurrence's structure and owns the only completion status. `task_supervision_actions.execution_mode` distinguishes supervised and delegated projections. A helper counterpart maps back to that same action; it has no independent completion or reward. Completed mappings retain their historical mode and actor. Current helper validity is checked again at mutation boundaries, and the existing linked-work refresher rechecks unfinished work. Reads remain side-effect free.

Learner progress counts learner-responsibility steps only. Delegated steps stay editable as definitions but are omitted from the learner's operational checklist. Overall completion still includes every original action. After the learner's steps finish, the UI explains that the occurrence is waiting on the helper. Manually completing the whole parent cannot bypass unfinished delegated work. Authorized reset/reopen uses existing status and Activity history rather than rewriting past completion events.

Explicit points on a delegated subtask belong to its performing helper. Ordinary supervision does not transfer learner points, and generated helper Tasks never award duplicate points. The learner retains the ordinary parent reward after the complete occurrence; an explicitly excluded parent action awards neither the prohibited learner nor an accidental helper parent reward. Existing reward reversal behavior on reopening is unchanged.

Recurring occurrences copy original definitions and source links with incomplete state, then resolve current proficiency and one current helper afresh. New template materialization records `activity_template_checklist_item_id` and an append-only provenance event. Template edits do not rewrite existing occurrences; deletion clears the nullable definition reference while retaining occurrence work and historical provenance. Legacy rows without authoritative item IDs are not automatically matched by title.

Migration 10033 is additive: the execution-mode column defaults historical mappings to supervised, and a nullable template-item reference is added to Tasks. The migration itself does not backfill or reassign work. The previous image does not understand delegated ownership, so rollback after reconciliation requires the pre-deploy database backup as well as the previous image/configuration.
