# Availability routines and resolver contract

Base: deployed Vidamia `3c89120cb64cb9ddd915a3bd96237347ad41eda6`.

Calendar projects what is happening. Availability explains when someone can reasonably perform an activity. Presence describes where someone is believed to be now, including the source of that belief. A location does not imply spare capacity.

## Precedence, defined before eligibility changes

For each half-open time segment `[start, end)` in the household timezone:

1. Manual dated Availability overrides.
2. Explicit dated Availability exceptions, including Trip/context periods; then existing workflow-produced dated periods.
3. Rotating routines resolved from the existing Schedule tables.
4. Weekly Availability routines.
5. Assigned Calendar events, advisory under the existing policy.

The resolver chooses a winner within each segment, not just at the end of the request. Equal-priority conflicts use later starting time, then record ID, with explanatory provenance. Calendar overlap does not alone reject the existing `available_before_due` policy.

A **roster exception** (`schedule_overrides`) replaces that person's roster occurrence on its starting date before the global precedence above. It does not override a Trip. A day off contributes no roster restriction; other Availability/weekly/Calendar signals still apply. An overnight occurrence belongs to its starting date: cancelling Tuesday's shift does not cancel Monday night's remaining hours.

Current Presence is a separate, inferred snapshot, not an input fed back into future availability. Existing manual Availability periods retain their meaning and expiry; none are silently converted into observed location records. The application has no independent physical-location observation source today.

## Unknown and available are different

A missing cycle-day record is unconfigured, contributes an unknown blocking routine signal, and is visibly identified for correction. An explicitly stored null shift is a day off this routine. Existing saved null rows are preserved; the historical UI did not record whether a user deliberately selected each default Free day, so that intent cannot be reconstructed.

An ordinary gap with no planned restriction remains eligible under the existing permissive policy, but is labelled unknown/no planned conflict, never confirmed availability. A shift has an explicit Availability effect (busy by default, available, away, unknown, or information only) and optional Place. Existing types keep their identity/times/colour and default to busy; untimed types span a local calendar day. Names are never parsed to guess their effect.

## Explained windows and compatibility

The shared resolver exposes windows, continuous usable windows, winning and overridden sources, advisory events, warnings, eligibility and a reason. Existing `effective` and `signals` fields and `evaluatePresence()` callers remain compatible. Start/due policies evaluate the selected instant; completion policies search the useful window. Optional duration requires a sufficiently long continuous usable window. Without supplied duration the resolver does not claim duration-fit.

The original four Schedule tables and API remain. An additive migration adds shift Availability effect and optional Place only. Shortening a cycle ignores out-of-range saved day-off records, preserving them inertly; assigned shifts must be explicitly addressed. Unconfigured days are omitted from submitted day records, not converted to null. Calendar projections never write Calendar events or become the source of truth.

## Existing behavior deliberately retained

Availability routines affect Activity Template assignment, generated workflow tasks, task binding, claims and explicit reassignment through the same resolver. They do not generate tasks by themselves or rewrite existing task assignees when a routine changes. Changing only the due fields of an already-bound task also does not automatically reassign it.

`available_before_due` checks capacity; `must_be_home`, `must_be_at_location` and `must_be_away` check expected location. `ignore` deliberately bypasses both. A location-only policy does not assert spare time. Activities and Tasks currently have no persisted duration field; the explanation preview and resolver accept an optional duration, but existing task assignment must not be described as checking duration fit.

Calendar events remain advisory for availability, matching existing behavior. Routine statistics report planned occurrences and nominal shift hours, not attendance or elapsed DST-adjusted working time. Information-only time ranges affect neither availability nor inferred location.

Existing permission and token-scope keys are retained. Roster APIs still require `schedule` access. Explained Availability/Presence responses require Calendar read access and, when they contain routine-derived data, Schedule read access as well. This prevents the consolidated view from bypassing an existing restriction; no permissions are silently granted or migrated.

## Release gate

Existing roster data, overrides, types and statistics were surfaced through Availability first. Regression checks, 15/15 isolated HTTP acceptance checks and all nine required actual CUA browser cases established the consolidation parity gate before standalone Schedule navigation was retired. Legacy `/schedule` links now redirect to `/calendar?section=availability`; the original API, tables and permission/token-scope keys remain.

See [the QA record](availability-consolidation-qa.md) for verification boundaries and the unexecuted Puppeteer tests. No production migration or production browser test has been performed. No push or deployment is authorized in this task.
