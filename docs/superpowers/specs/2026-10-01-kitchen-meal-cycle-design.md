# Kitchen meal planning: family workflow and integration design

Date: 1 October 2026. Status: written design for human review; not an implementation plan or a deployed feature.

## 1. What the family should experience

Kitchen coordinates meals from the first choice to shopping and cooking. People should understand what they need to do without learning about database snapshots, rotation tracks or grocery runs.

Duane's confirmed weekly rhythm is **Friday: choose; Saturday: review and confirm; Sunday: groceries**. Kitchen creates each person's planning Task. That Task opens their authorized meal-planning view. Submitting there completes the Task, but the saved choices stay editable until the coordinator finalizes the household period on Saturday night. Finalization uses the latest saved responses. Changes afterward are visible adjustments, with clear effects on groceries and responsibilities.

This serves breakfast, lunch and dinner across all seven days. It works for households with or without children, different weekend routines, school lunches away, holidays at home, and whole or partial household travel. A school holiday does not imply that anyone is away. Snacks, a new nutrition system, and new presence sensors are outside the initial delivery.

The initial finalization mode is **manual confirmation by a designated coordinator**. Kitchen stores the mode so timed automatic finalization can be added later, but this delivery does not execute automatic finalization. Saturday-night timing and the coordinator are editable setup choices; neither is assigned to a real household by this spec. If the coordinator is late, choices remain editable until actual confirmation. The screen says “Waiting for household confirmation,” rather than silently locking or shopping.

## 2. Screens and everyday actions

### A. Set up the usual routine

The organizer chooses meal slots, days and times; usual diners; who chooses the shared main; eligible cooks and supervisors; enabled chores; and the destination shopping list. Existing schedules, groups, skills and trips are reused. Label the roles separately: choosing dinner does not mean cooking it or eating it.

Kitchen also owns “When to create planning Tasks,” the period being planned, personal response deadlines, household review time and shopping due date. Setup previews real calendar dates before saving. It requires an eligible coordinator and complete timing choices before scheduled generation can be enabled. It never picks the first adult, assumes children exist, or silently changes existing household settings.

The common path shows practical defaults and their effective values. Fallback chains, per-chore assignment overrides, time windows and rotation configuration are expandable advanced settings. Existing advanced configurations remain editable and visible in a summary; hiding controls does not reset them.

### B. My meal choices

A Task such as “Choose your meals for 5–11 October” opens the person's applicable breakfast, lunch and dinner cards. Each shared chooser action is specific: “Choose Monday's dinner.” Use short sentences, recognizable recipe images where already available, large controls and an obvious selected state. A five-year-old should not need to interpret “policy,” “context” or “execution.” Do not add image generation, voice input or child-account permission changes.

The assigned chooser selects the **shared main course**. Each diner separately chooses “I'll have the family meal,” “I'll have something else,” or “I'm not eating this meal.” A diner choosing something else supplies their own recipe or named alternative; the shared chooser does not choose everybody's alternatives. Choosing an alternative is distinct from declining chooser responsibility or being away.

Preserve existing sides and their selections. The redesigned primary chooser action does not require selecting sides and does not delete existing sides when the main changes. Optional side management remains available in meal details to authorized people. Existing portion semantics remain: a person's amount applies to their chosen main and selected sides, with each dish rounded independently for cooking.

The amount control accepts custom positive values within the current backend contract: **0.01–1000 portions, at most two decimal places**. Convenient buttons do not restrict direct entry to half or whole portions. Show a recipe's serving basis when defined; do not invent a physical serving size when missing. Values such as 0.001 are rejected with the actual limit, not silently rounded.

“Save changes” preserves drafts without completing the period Task. “Submit my choices” validates all applicable required responses and completes the linked Task. If the shared main is not chosen yet, a diner may save preferences, but a dependent unconfirmed response is shown as waiting and cannot make the Task falsely complete. Away or explicitly not-eating responses can satisfy the person's attendance requirement without creating food demand.

After submission: “Submitted. You can edit until household confirmation.” Valid edits keep the Task complete. Opening a menu editor, canceling it or navigating back preserves the parent draft. Acting for another person is clearly labeled and requires the existing authorized administrator permission.

### C. Review the whole household period

The review includes every date and all configured breakfast, lunch and dinner slots, with Home and any trips visible together. A planning cycle covers the household date range; contexts are slices within that cycle, not competing independent weeks. A trip crossing a period boundary contributes its applicable dated occurrences to each period. For each meal show shared main, sides, individual alternatives, diners, requested and cooking portions, and **preparation, cook, supervisor, serving and cleanup**. Distinguish planned assignees from actual generated Task assignees. A disabled role, or supervision explicitly configured as unnecessary, says “Not required”; an unresolved required role says “Needs assignment.” Do not fabricate a cleanup assignment merely because no execution Task exists yet.

Show attendance reasons such as “Away: business trip,” “Lunch at school,” or “Location unconfirmed.” Summarize missing responses, unavailable assignees, unresolved travel overlap, missing shopping destination, and ingredient/yield warnings. Link each issue to the relevant action. A routine family member should not have to inspect several settings dialogs to understand why a meal is blocked.

The coordinator sees “Confirm household plan and create groceries.” Before confirmation, unresolved required decisions, invalid assignments or context conflicts block confirmation. A deliberately open/claimable chore is permitted only where the configured policy allows it and the coordinator sees it as unclaimed. A named custom meal without structured ingredients requires an explicit reviewed acknowledgment that it contributes no automatic ingredients, or ingredients must be entered; it is never silently reported as fully covered by groceries.

### D. Shop, then use today's Tasks

Confirmation creates authoritative grocery revisions from the current choices, attendance, portions and ingredient sources and adds required items to the chosen shopping list. Existing explicit trip-list overrides are respected: each source belongs to exactly one list partition, and the review names every destination. It also creates or refreshes the existing enabled meal execution Tasks. Friday submissions do not publish Shopping items or generate duplicate cooking chores.

The Sunday shopping Task opens that planning period and its named shopping destination. If Home and a trip use different lists, the landing view names both and links directly to each rather than choosing one silently. Setup assigns this Task to the coordinator unless the organizer explicitly chooses another household member; the assignee is shown before activation. Groceries are ordinary Shopping items with retained source provenance. Marking a purchase, completing the shopping Task, and transferring purchased items to Pantry remain different operations. Completing the Task records that the person finished their shopping work; it does not mark unchecked items purchased or automatically change Pantry stock.

Today's meal card links directly to its existing cooking and other chore Tasks. Due times remain relative to the meal; creating them on Saturday does not make them due Saturday. Show separate progress for choices, household confirmation, shopping and cooking instead of one misleading “Week prepared” state.

### E. A change after confirmation

A new trip or an edited portion request shows “This plan needs an adjustment” and identifies the affected dates, people, food and chores. The last confirmed revision remains visible alongside the proposed changes. The coordinator reviews the delta before affected published outputs change. The unaffected days remain confirmed.

Purchased food remains purchased. Started/completed work keeps its history. Unresolved staffing stays visible. An adjustment cannot silently assign an outsider, rewind a rotation or claim to have removed food from the house.

## 3. Scheduling contract

Separate four concepts in storage and UI: **period coverage, Task creation, response/review due dates, and the finalization event**. A Friday due date must never invoke the existing shared-menu edit lock before Saturday household confirmation.

Initial planning-period presets are daily (one local date), weekly (seven dates), every two weeks (14 dates), and monthly (one calendar month). An organizer chooses the first period start and the creation day/time relative to it. These presets create consecutive, non-overlapping periods for a scope; they do not create a fresh rolling window on every page visit. The initial editor pairs cadence with its corresponding period length rather than promising arbitrary overlapping horizon/cadence combinations. This is a deliberate first-release constraint, while creation lead time and all due dates remain separate settings.

Daily periods use an explicit day offset/time; weekly and fortnightly periods use a weekday/time before or within the period; monthly periods use a numbered day/time with an explicit month offset. Monthly dates beyond that month's end use its last day. “First Saturday of the month” is not offered initially because the existing recurrence parser does not support ordinal weekdays. Setup previews the coverage and resulting dates and rejects an order in which response/review deadlines occur after the first meal they govern. The family weekly preset proposes Friday choices, Saturday review and Sunday shopping for the following Monday–Sunday, without enabling it until its times and coordinator are supplied.

Use the household IANA timezone, local calendar arithmetic and the existing Task DST policy: nonexistent times move forward through the gap; repeated times use the earlier instant. A settings change affects periods not yet created. Existing periods retain their timezone and scheduled instants unless an authorized explicit reschedule is recorded.

A durable generator runs at startup and at least once per minute. At a due creation instant it creates each eligible period and its required personal, review and shopping Tasks once. Restart/retry uses the same identities. Missed generation catches up for periods not yet ended; it does not flood Tasks with ended historical periods. Task creation may be early, with start/due times controlling actionability. Planning Tasks use keep-overdue behavior: a due time is not an expiration or an edit lock. An unfinished previous Task does not prevent the next calendar period from being created. Completion-relative recurrence is not used for this household rhythm.

## 4. Smallest coherent extension and ownership

Keep the existing Meals, Tasks, presence, rotations, Shopping and Pantry models authoritative. Add a thin planning-cycle coordinator rather than a parallel workflow engine or duplicate meal records. Proposed persistence must cover these logical records; exact migration syntax belongs to the later implementation plan:

| Record | Responsibility and required identity |
| --- | --- |
| Kitchen cycle settings | Household, timezone, preset/first-period anchor, creation rule, due offsets/times, coordinator, shopping assignee, default shopping list, manual finalization mode, revision and enabled flag. Existing context grocery overrides remain authoritative. |
| Meal planning cycle | Household plus start/end dates, settings snapshot, monotonic revision, open/finalized state, finalized revision and timestamp. A finalized cycle may additionally have a pending adjustment. |
| Cycle-to-meal membership | One owner for each dated meal occurrence within a context; link existing IDs rather than cloning meals. Home and trip occurrences remain distinct. |
| Cycle Task links | Unique cycle + purpose + beneficiary identity; authoritative Task ID, required obligation/decision references and submission revision. Review and shopping have explicit owners. |
| Finalization/adjustment record | Immutable input fingerprint, decision/attendance/assignment source revisions, resulting grocery and execution IDs, actor, reason and retry key. |
| Reconciliation events | Durable affected scope/date/member identifiers, source revision, reason and processing status, deduplicated before effects. |

Reuse Task lifecycle operations for permissions, completion, revisions, notifications and rewards. Do not directly set Task status from a UI handler. Existing chooser obligations remain the source of chooser responsibility; a period Task is a projection of the person's currently required responses, not a new competing assignment system. Completing it is idempotent and cannot earn duplicate rewards on resubmission. A superseded assignment keeps its audit trail and cannot be completed through an old deep link.

Personal links identify cycle and beneficiary, but the server derives access from the authenticated actor. Members can edit themselves; authorized administrators can act for someone else with an audit entry. Household review/finalization is limited to the designated coordinator with the necessary existing capabilities, or an authorized administrator acting explicitly. The client cannot grant access by changing query parameters.

An ordinary edit before finalization preserves completed submission status if the response remains valid. If a main change invalidates a dependent response, a newly required meal has no answer, or responsibility is reassigned, mark only the affected personal work as requiring action. Reopening uses the existing lifecycle and cannot erase completion history or issue rewards again for the same submission obligation. If that lifecycle cannot represent the correction safely, issue a linked non-rewarding follow-up Task rather than mutating completed history.

## 5. API and consistency boundaries

Existing setup APIs for Meal Plans/defaults/execution/groceries remain. Existing menu and decision APIs remain the canonical input writers. The new screens reuse `/meals/week-model`, `/meals/status`, per-meal execution details, and existing grocery services through the coordinator. Their current GET paths can materialize meals: this behavior must be explicit in server orchestration. New period preview/status operations are side-effect-free; the generator or an explicit ensure operation establishes occurrences first. Existing compatibility GETs may still ensure old-style occurrences, but cannot bypass cycle ownership, cutoffs or duplicate prevention.

Introduce service operations for ensure-cycle, save/submit-person, review-cycle, finalize-cycle, propose-adjustment and apply-adjustment. Transport route naming is implementation detail; these contracts are not:

- All mutations carry the expected cycle/response revision and a stable request key. Retrying the same request returns the same result; reusing its key for different input returns a conflict.
- Every menu/decision/attendance writer affecting a cycle increments its revision or participates in an equivalent shared source fingerprint. This includes legacy routes and administrator edits. No direct route bypasses finalization rules.
- Before finalization, saving changes and submitting are separate. Submission validates the required response set and synchronizes Task completion atomically with the saved submission record; notification delivery occurs after commit.
- Finalize verifies authorization, manual mode, readiness, expected revision and current source fingerprint. In one database transaction it records the immutable finalized input, creates/finalizes/publishes the authoritative grocery revisions, ensures the existing meal execution outputs, and records the review result. The grocery service receives the exact owned meal/source set for each destination partition, not merely a date range that could collect another context's demand. Any failure rolls back the entire finalization. Request retries cannot publish twice, advance rotation twice or duplicate Tasks.
- A response saved before that transaction is included. A concurrent response based on the old open revision is rejected after finalization with a clear “Plan confirmed; propose an adjustment” response. There is no last-writer-wins gap.
- Post-finalization menu/response changes are staged adjustment proposals. Accepting an adjustment validates the latest finalized revision and all protected downstream state again before committing it. A stale proposal conflicts and must be refreshed.
- Existing chooser deadline semantics must be adapted for cycle-owned meals: personal Task due time can make a response overdue, but only actual household finalization closes the normal editing window. Legacy non-cycle meals retain their existing deadline contract.

These operations use the same grocery demand/scaling and execution services as the existing application. A grocery-run `finalized` state alone is not household finalization. Preparing a cycle must not run both old “Prepare week” and a new workflow that creates the same chores. For cycle-owned meals the old action redirects to the cycle's appropriate review or adjustment operation; non-cycle meals retain their existing path.

## 6. Presence, travel and targeted reconciliation

Reuse `evaluateAvailability` and its current input precedence: manual periods, explicit periods, workflow periods, rotating routines/overrides, recurring availability rules, and Calendar location/advisory signals. The current meal presence policy is `available_before_due`, not a proof of physical presence at home. Respect the slot's presence setting and Place. Unknown availability remains explicitly unknown and follows the configured existing policy; do not silently turn a school holiday or a Calendar title into an away period.

Travel contexts separate home diners from actual trip members at the meal time. School lunch can be excluded through configured availability/location and meal participation while breakfast and dinner remain at home. Whole-family travel plans breakfast/lunch/dinner in the trip context; partial travel leaves a home cohort. Ambiguous travel-plan selection or overlapping memberships require review. A date-specific routine override can express a holiday at home; automatic school-holiday-to-meal routine switching is not part of this delivery.

Extend the current partial reconciliation with durable events from relevant availability, routine, trip/context, membership, skill/group and meal-decision changes. Process affected open/future occurrences promptly after commit, with startup retry and a minute-based recovery sweep. A status refresh can request recovery but is not the sole trigger. Deduplicate by source revision and affected occurrence. The UI reports pending/failed reconciliation instead of displaying stale assignments as current.

For an open cycle, recompute effective attendance and demand without deleting the saved personal response. Away overrides contribution to the home meal; returning restores the saved choice subject to current eligibility, while a deliberate opt-out stays an opt-out. Preserve a valid submitted shared main when its chooser travels; do not ask another person to reselect an already chosen dinner. Reassign outstanding chooser responsibility only where it is still needed.

Reevaluate required cook/supervisor and enabled chores under their configured skills, presence and group policies. Preserve eligible assignees. If a replacement is required, record an explicit correction against the original assignment; do not rewrite finalized canonical rotation history or consume an ordinary extra turn. Repeated reconciliation selects the same correction until its inputs change. If nobody qualifies, report the unresolved role and prevent household confirmation; never choose outside the permitted group. An intentionally open/claimable role remains unclaimed under its policy.

Before confirmation there are normally no execution outputs from this new flow. For adopted existing outputs, only untouched, unfrozen work can update automatically. Any started, completed, archived, expired, deleted or explicitly frozen output retains its existing protection. If one task has frozen the meal execution snapshot, the coordinator must not update other outputs through that frozen snapshot implicitly. Conflicts require an authorized, auditable follow-up action. The known generated-task stale-assignee behavior must be corrected for the eligible untouched case, with explicit history protection tests.

For a finalized cycle, a source change creates/updates a visible adjustment proposal and a targeted coordinator follow-up; it does not silently edit the confirmed baseline, publish groceries or transfer chores. The proposal shows effective absence immediately so the family is not told an away person is still available. Existing personal submissions remain recorded. Only people whose responses or duties genuinely need action receive new work.

## 7. Groceries and protected downstream work

An accepted adjustment recomputes demand using the latest approved meal/portion/attendance data. Keep per-source provenance and show additions, reductions and unchanged purchased quantities separately.

- Unpublished drafts refresh normally with stale-revision rejection.
- For published, unchecked, unmodified meal-owned Shopping rows, apply reviewed quantity increases/reductions to the attributable source demand, never to unrelated items. Remove an unneeded row only if no other source owns it.
- If a row is purchased, partially fulfilled, reconciled, manually edited, or has ambiguous mixed ownership, preserve it and show the discrepancy for explicit resolution. Excess purchased ingredients stay available in Pantry; meal changes never fabricate negative receipts or undo purchases.
- New unmet demand produces only the additional required purchase quantity. Retrying publication or Pantry reconciliation never duplicates items or receipts.
- Started/completed cooking and pantry-consumption history remains attached to its original snapshot. A prospective correction is separate from what the household already did.

The current grocery engine already supports source fingerprints and positive incremental demand, but does not implement every reduction/reconciliation rule above. That is required targeted extension, not an assumed existing capability. Existing QA findings concerning stale quantities, manual-empty ingredient overrides, old-run lookup, custom alternative identity and retained reconciled rows remain regression evidence; the implementation plan must identify which paths this integration touches and resolve launch-blocking cases explicitly. This document does not claim those bugs are fixed.

## 8. Approach and alternatives

**Recommended: a Kitchen cycle coordinator over existing services.** It adds only the period state, Task links, scheduling and reconciliation needed to make one coherent workflow. It preserves mature Tasks, meal decisions, grocery provenance and rotation history. The cost is transactional integration and a small durable event-processing layer.

**UI-only simplification** would be smaller, but cannot guarantee Saturday cutoffs, submit-to-complete linkage, scheduled creation or safe late-trip updates. It is insufficient for the approved behavior.

**A generic recurring Workflow for everything** would reuse more visible configuration, but would duplicate meal-owned assignments and groceries, risk completion-relative drift, and still need a domain coordinator for attendance and finalization. Workflows may supply reusable task-definition/dependency primitives; they do not become a second source of meal truth.

## 9. Rollout boundaries and acceptance

Design review precedes the implementation plan. Later implementation should ship behind an initially disabled Kitchen cycle setting, validate on synthetic data, then support deliberate household activation. Existing plans remain usable. Show an adoption preview for any current period: link existing occurrences/outputs once, flag conflicts, and do not backfill historical Tasks or publish historical groceries. Activation is an explicit future rollout action, not authorized or performed by this spec.

Disabling generation stops future cycle creation. It does not delete existing Tasks, unfinalize plans, undo purchases or remove access to adjustments. A rollback must preserve all committed period identities, decisions and provenance. Partial deployment cannot expose the new UI as ready while its server-side finalization and write guards are absent.

Acceptance must cover these observable outcomes:

1. A family member can identify and submit the correct meal action without learning planner terminology; a supervised five-year-old usability session validates the short labels and controls. Desktop and responsive mobile checks are separate from physical-device testing.
2. All seven days and breakfast/lunch/dinner appear with every enabled role. No-child households, weekday school lunch, weekends, a holiday at home, whole-family travel and one-person business travel produce the correct cohorts without school-night assumptions.
3. A shared-main choice does not overwrite another person's alternative or delete sides. Custom valid fractional portions persist; invalid precision is explained. Cancel/back preserves unsaved draft input.
4. Daily, weekly, fortnightly and monthly creation occurs once at the configured household-local instant, including restart, concurrent worker, month-end and DST cases. Completing late never shifts the next calendar cycle.
5. A Task link cannot edit another member by changing its URL. Submit persists current responses and completes the linked Task once. Valid pre-confirmation edits keep completion; invalidated requirements cause only targeted corrective work without duplicate rewards.
6. Friday overdue status does not close editing. Manual Saturday confirmation includes the latest committed responses. Racing edits/finalizations conflict correctly; retry returns the same grocery revision and Task IDs. A missed Saturday confirmation leaves the cycle open and visibly waiting.
7. Missing choices, unresolved required staffing and ambiguous contexts block confirmation with actionable reasons. Open/claimable roles and custom meals lacking automatic ingredients are explicitly disclosed rather than falsely resolved.
8. An unrelated person's trip preserves an eligible cook/supervisor. An actual assignee's trip triggers a valid correction or unresolved state. Immutable rotation results and prior decisions remain intact; no outsider or duplicate turn appears.
9. A late finalized-period change shows the precise proposed impact. Untouched eligible work can be corrected after review; purchased groceries, manual Shopping edits and frozen/started/completed Tasks are preserved and discrepancies remain visible.
10. Existing grocery/Task retry tests still pass, source reductions do not damage unrelated Shopping demand, and old purchase-to-Pantry reconciliation remains traceable. Existing non-cycle flows remain operational with their original permissions and history.

Timed automatic finalization, arbitrary overlapping cadence/horizon combinations, ordinal monthly schedules, automatic holiday routine switching, snacks and new external integrations are future scope. The first automatic-finalization implementation must separately define incomplete-response handling and failure notifications; it is not activated by storing a mode field now.

## 10. Provenance and review notes

This spec consolidates Duane's approved design direction and subsequent clarifications: Kitchen-owned cadence; Friday choices/Saturday review/Sunday groceries; per-person submission Tasks; editable choices until manual household confirmation; individual alternatives; all three main daily meal slots; all seven days; presence-aware household/travel coverage; and protected late adjustments.

Approved synthetic prototype reference: https://vidamia-meal-flow.dglenns3.chatgpt.site . The private URL could not be retrieved by the web tool during this writing session. The supplied approved requirements and previously captured actual application screens are the design evidence; this document does not claim a fresh visual verification of the hosted prototype.

Source assessment baseline: `e37f30b39a2e5d1b93516cac99d8834ec71e2412`. Deployment was not inspected. The separate `vidamia-meal-qa` checkout contains two uncommitted, tested assignment fixes: unresolved cook Group protection and eligible cook/supervisor preservation during late home-travel reconciliation. They are not included in this documentation branch and must be integrated deliberately before relying on that behavior. The broader dynamic reconciliation described here is new work.

Key repository anchors (line numbers refer to the assessed baseline or its narrowly patched QA copy):

| Existing area | Source and evidence |
| --- | --- |
| Presence precedence and expected availability | `server/services/presence.js`; meal policy/cohorts in `server/services/meal-plans.js` around 1023 and 1424. |
| Limited pending-occurrence reconciliation | `server/services/meal-plans.js` around 1624, 1713 and 2228; `server/services/planning-contexts.js`; `server/services/trips.js`. |
| Choices, revisions, menu deadline and audit | `server/services/meal-plans.js` around 3997, 4175, 4257 and 4510; `docs/meal-portions-serving-basis-20260907.md`. |
| Week/status reads that materialize | `server/routes/meals.js` around 992, 1026 and 1456. |
| Generated chore identities, captured assignees, timing and freeze | `server/services/meal-execution.js` around 237, 288, 395 and 419. |
| Grocery fingerprints, finalization and positive published deltas | `server/services/meal-grocery-runs.js` around 194, 334 and 439. |
| Task recurrence/lifecycle and DST | `server/services/recurrence.js`, `task-series.js`, `task-lifecycle.js`, `task-window.js`, `activity-schedule.js`. |
| Workflow retry identity and action links | `server/services/activity-workflows.js` around 814; `server/services/planning-contexts.js` travel meal-plan Task links; `server/services/notification-inbox.js` meal deep-links. |

Prior isolated QA reported 444 baseline checks, 15 responsive browser cases and a 91-assertion connected week. The two assignment fixes subsequently passed 193 affected checks and an overlapping final 95-check set, with independent review. The real authenticated desktop journey reached choices, preparation, Shopping, Pantry and cooking Tasks; Finalize used its DOM click handler, so this is not a complete pointer-usability or physical-phone claim. None of that evidence proves this proposed integration is implemented.

Self-review completed: the spec separates submission from finalization, deadlines from creation, planned roles from generated outputs, holiday context from absence, and groceries from purchases. Manual mode and delayed confirmation behavior are explicit. Current portion limits and first-release scheduling constraints are stated. Remaining coordinator and exact-time selections are required setup values, not missing architectural decisions. No product changes, dependency installs, live household writes, push, merge or deployment are part of this deliverable.
