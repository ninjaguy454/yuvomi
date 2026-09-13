# Availability consolidation: adversarial review

Reviewed branch: `feature/availability-consolidation-20260911`.
Reviewed base: `a02a70ce0207d1be67fbbe920f18ed76e078a86f`.
Scope: correctness, explanations and Task consumers. No redesign, schema change, migration, data conversion, push or deployment.

All writes and browser actions used an isolated source clone, in-memory databases or the synthetic loopback QA database. Existing production data was not opened or changed. The original Schedule tables, API, shift identities and independent dated overrides remain intact.

## Defects found and corrected

| Area | Reproduced defect | Correction |
| --- | --- | --- |
| Task edits | Moving only the due/start time could bypass an existing Activity or workflow occurrence policy. A policy-bearing supervisor Task could also be reassigned without an Activity binding. | Revalidate the actual performers against the occurrence policy before writing dates or changing assignees; preserve assignment rather than silently replacing it. |
| Claims and acceptance | A Task saved as unavailable could never recover after its routine was removed. Pending obligation acceptance did not recheck changed Availability. | Claiming an open-claimable unavailable Task now checks live eligibility; the UI offers “Check availability and claim.” Acceptance also checks live eligibility. |
| Supervision | The learner and supervisor could each qualify in different, nonoverlapping parts of a completion window. Generated supervisor Tasks lost the policy used to create them. | Require a shared eligible interval and retain the policy on the generated supervisor Task. This does not invent or prove a Task duration. |
| CalDAV | Inbound dates could bypass the Task edit guard. | Validate before local writes; on conflict preserve the Task and remote item, avoid partial hierarchy rebuilding, retain the item for pruning, and return a visible conflict response. Corrected remote edits can retry. |
| Assignment lifecycle | Due edits left an obligation's response deadline at the old due time. Declined performer records could prevent edits of an unassigned Task. | Keep a due-tracking response deadline aligned while retaining a distinct custom deadline; remove stale declined performers from the active assignment state. |
| Household time | Dated-period/Trip inputs were compared in the server timezone, accepting reversed mixed-offset ranges or rejecting valid ones. Planning-context overlap and union writes could then fail lexical database constraints. | Use the resolver's household-time instant conversion for comparisons; normalize both endpoints together only when either is explicitly zoned. Floating pairs retain their stored wall-clock form. |
| Editor time | UTC/offset timestamps were sliced into datetime-local inputs. A note-only save could change the time, discard seconds or switch a later DST occurrence to the earlier one. | Display household wall time and preserve the original timestamp when its displayed minute is unchanged. Preview defaults also use the resolver's timezone. |
| Clearing manual fields | Clearing expiry or Place retained the prior value through null fallback. | Explicit null clears the field; omission retains it. Eligibility and current-location explanations change accordingly. |
| Trip dates | Offset Trips near midnight could receive the wrong phase Task date, disappear from household date filters, or group itinerary stages/events under the wrong day. | Phase dates, date filters and itinerary grouping use household dates; a bounded candidate envelope is followed by exact overlap filtering. All-day declared dates remain unchanged. |
| Calendar signals | A lexical UTC candidate filter dropped overlapping positive-offset Calendar events. Recurring offset events could reconstruct their end in the server timezone. | Fetch a conservative candidate envelope, filter by actual instants and preserve explicit-offset recurrence duration. |
| Resolver input/reasons | Minute-precision inputs received false DST warnings; impossible dates were accepted; dated DST adjustments lacked warnings; a rejected away-at-home policy could explain success. | Strict shared instant validation, consistent clock-change warnings and reasons matching the eligibility predicate. |
| Future Task window | A future start-only Task could acquire today's fallback due date. | Use its start date for the fallback useful window. |
| Member isolation | Numeric-string member IDs could lose their roster restriction, while invalid explicit ID zero could broaden a service lookup. | Normalize valid scoped IDs and reject invalid explicit scope. |
| Unknown explanation | A manual unknown signal overriding a busy roster was explained as “no planned restriction.” | Explain that the policy permits unconfirmed time and retain the overridden busy source. The inherited permissive policy is unchanged. |

## Eligibility contract actually verified

Intervals are half-open: `[start, end)`. A shift beginning at 08:00 blocks at 08:00; a shift ending at 16:00 does not block at 16:00. Date validity bounds select occurrences inclusively; they do not truncate the next-day tail of an overnight occurrence.

For each interval, precedence is manual dated override, explicit dated exception/Trip, workflow dated period, rotating routine, weekly routine, advisory Calendar. Same-priority conflicts prefer the later start and then record ID. The response retains winning and overridden sources.

A roster override replaces the member's occurrence starting on its selected date before this precedence is applied. It cannot defeat a Trip or erase the previous night's tail. Overrides belong to the member/date, not to an individual routine, and intentionally survive routine deactivation/deletion. An explicit day off removes the roster contribution only; a weekly or dated restriction can still win.

`available_before_due` checks capacity, with an optional target Place match. The `must_be_*` policies check expected location, not spare time. `ignore` bypasses both and explicitly says so. Current Presence is an inferred now-snapshot, not a future-capacity override.

**Unknown is not confirmed available, but the policy is still permissive in some cases.** Ordinary gaps and effective weekly/manual unknown signals can qualify with `confirmed_available: false` and an unknown explanation. A manual unknown period with a Place can therefore override a busy roster; it is not a location-only observation. Explicit rotating unknown and missing cycle days block. This distinction is tested and reported, not silently converted to a new strict policy.

Tasks have **no persisted required duration**. Completion mode without duration proves only that some eligible interval exists in the useful window. Start/due mode without duration checks an instant. Explanations do not claim duration fit. Where a duration is explicitly supplied to the shared resolver/preview, a continuous interval is required; disjoint short openings cannot be added together. Adjacent eligible intervals may merge, but any unknown portion keeps the merged window unconfirmed.

## Stress-test matrix

The regression assertions cover both decisions and their window/source/reason evidence; lifecycle tests also check retained records and actual HTTP behavior.

| Case | Eligibility and explanation verified |
| --- | --- |
| Weekly routine, Week A/B, 4-on/4-off | Correct working intervals and pattern sequence; explanation identifies the effective shift or weekly source. |
| Before/after reference date | Positive modulo wraps consistently on both sides of the reference date, including distant cycles. The reference date is not an activation boundary. |
| Exact boundaries and midnight | Start inclusive, end exclusive, midnight uses the next local date; reason changes at the exact boundary. |
| Overnight and cross-midnight Task | Previous-day tail is included, final valid occurrence survives midnight, next-day off does not cancel it; Task checks its own occurrence date. |
| Layered overlap | All levels split at actual boundaries; only the winning signal grants/rejects eligibility, with losing evidence retained. |
| Dated override scope | Manual exception starts/ends exactly at its own bounds; the underlying shift resumes afterward. Roster exceptions affect their starting occurrence. |
| Trip overlap and return | Away wins over routine/off only during the Trip period; unrelated availability survives outside that period. |
| Missing day vs explicit day off | Missing day blocks with “This routine day has not been configured.” Day off restores underlying weekly/dated evidence or unconfirmed gaps. |
| Partial-day availability | Two separate 30-minute openings fail a 45-minute requirement and pass a 30-minute requirement. Reasons distinguish insufficient continuous time from known busy periods. |
| No duration / ignore | No synthetic Task duration or duration-fit claim. Ignore explicitly bypasses restrictions, including a supplied duration. |
| Routines and shifts changed/deleted | Changes affect new evaluations immediately; disabled routines contribute nothing; referenced shifts cannot be deleted, including references from inactive patterns and overrides. Shift types have no independent active switch. |
| Legacy Schedule records | Existing explicit null days remain off, omitted days remain unconfigured, preserved out-of-range null rows do not block shrinking, and re-expansion restores them. |
| Household members | Routines/overrides stay scoped per member, including numeric-string service IDs; deleting one member does not change another's records. |
| Calendar advisory | Calendar remains a read-only roster projection and advisory location signal; an ordinary event alone does not block capacity. |
| Current Presence | Uses now independently of a future preview, changes at exact expiry and says that inferred location does not imply spare time. |
| Planned statistics | Counts an overnight occurrence once; planned hours remain nominal clock hours rather than elapsed DST hours. Untimed entries do not manufacture timed hours. |

## Timezone and DST result

The shared resolver, dated input validation and relevant Trip/context comparisons now agree on the household timezone. Explicit offsets identify instants independently of the server timezone; floating values remain household wall times.

Verified cases include:

- New York 22:00–06:00: 7 elapsed hours across spring-forward and 9 across fall-back.
- Lord Howe's 30-minute transition: 7.5 and 8.5 elapsed hours.
- Santiago's midnight transition: a local all-day routine spans 23 elapsed hours.
- Nonexistent local times shift forward with a warning. Ambiguous floating times choose the earlier occurrence. An explicit offset can identify the later occurrence.
- UTC and positive/negative offset encodings, a Honolulu server timezone, east-of-UTC Calendar data, and display preferences differing from the household.
- Actual browser/server separation: household New York, QA server UTC. The browser editor showed the later fall-back 01:30 correctly, and a note-only save preserved `06:30:45Z` and its seconds.

The actual browser was not timezone-emulated across multiple operating-system zones; those combinations were exercised in automated service/editor tests. The datetime-local UI has no explicit earlier/later fold selector for newly entered ambiguous times. Planned-hour statistics deliberately continue to show nominal hours.

## Task assignment call sites

| Consumer | Shared path and result |
| --- | --- |
| Activity assignment and member eligibility | `activity-eligibility.js` calls the explained resolver with the Task window. |
| Workflow preview and generation | `activity-workflows.js` uses Activity eligibility and occurrence policy overrides. |
| Task binding and recurrence | `task-activity-bindings.js` uses the same Activity eligibility path and occurrence dates. |
| Claim, explicit reassignment, acceptance, fallback | `assignment-responsibilities.js` performs live checks; supervised work requires shared time. |
| Task date edits / policy-bearing reassignment | `routes/tasks.js` validates actual performers before mutation. |
| Inbound CalDAV edits | `caldav-reminders-sync.js` calls the same validation; `routes/calendar/caldav.js` surfaces conflicts. |
| Meal availability filtering | `routes/meals.js` and `meal-plans.js` use the shared resolver when presence filtering is enabled. |

There is no separate roster arithmetic in these policy-aware consumers. **Not every Task is policy-aware:** ordinary manual Tasks, and generated Trip/Meal Tasks without an attached availability policy, retain their existing skill/assignment rules. Location-only and ignore policies are deliberate bypasses of capacity checking.

## Stale assignments and remaining limits

Availability edits do not automatically move, revoke or regenerate existing accepted assignments. Their assignees remain snapshots. A subsequent claim, acceptance, reassignment or protected date edit now checks the current data. Existing obligation timeout/fallback processing can still change an assignment independently.

No historical deadline repair was attempted: an already divergent response deadline cannot reliably be distinguished from a deliberately custom deadline. Future rescheduling moves deadlines that still match the old due time.

A recurrence completion can still fail atomically if generating the next occurrence's fixed assignment is ineligible. No recurrence backlog or deferred-assignment redesign was added.

CalDAV conflicts are exposed in sync responses/logs and can retry, but there is no persistent conflict inbox. Tests used mocked CalDAV responses; no real account was synchronized.

The permissive unknown policy, lack of Task duration, location-only policy behavior, inferred rather than observed Presence, nominal statistics, and independent roster overrides are explicit model limitations. No new policy was inferred from a Task title, shift name or location.

## Browser QA and final regression

Actual in-app browser checks used the synthetic loopback server:

1. Two separate 30-minute openings rejected a 45-minute requirement.
2. An exact 30-minute requirement passed.
3. An unconfigured routine day blocked with its explanation.
4. An overnight preview showed the busy 00:00–06:00 tail and the off-day remainder as unknown.
5. Trip overlap retained Away and explained the overridden rotation.
6. The Trip's exclusive midnight end restored the underlying off/unknown result.
7. A note-only dated edit preserved the later DST occurrence and stored seconds.
8. A formerly unavailable open-claimable Task recovered and was claimed.
9. Moving a fixed Task into a work shift was rejected.
10. Moving that Task to the exact 16:00 shift end saved successfully.
11. Advisory Calendar location remained separate from unconfirmed availability/current Presence.
12. Calendar showed 22:00–24:00 and 00:00–06:00 on consecutive dates. The overlay remains background information; clicking the underlying grid opens a separate blank Calendar event form, not a roster editor. That form was cancelled.

Browser error log: no unexpected errors observed. After restarting against the final code, the Task edit guard was rechecked: 15:59 during the shift was rejected and 17:00 after the shift saved. No production browser actions were performed. The temporary browser tab and QA server were closed.

Final aggregate: **1,374/1,374 checks passed across 59 test files**, with zero failures, cancellations or skips. This includes **74 new adversarial cases** across four files (26 resolver, 15 input/timezone, 22 lifecycle and 11 Task-consumer cases). All 12 actual browser scenarios above passed. The final regression log is `.qa/availability-adversarial-final-regression.log`.

Separate harness limitation: the first broad run also attempted five existing Puppeteer UI checks, which failed at browser launch before any assertions. They are not counted as passing browser tests or included in the final 1,374 checks. Actual browser QA used the supported in-app browser; no claim is made that the Puppeteer harness passed.

New adversarial tests are registered in `npm run test:availability-consolidation`. On Windows, use Node 24 with `DB_PATH=:memory:` and a synthetic `SESSION_SECRET`; the test command also uses `test/test-browser-loader.mjs`. Logs and synthetic databases remain ignored under `.qa/`.
