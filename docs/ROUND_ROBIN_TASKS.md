# Round-robin recurring task assignment

This fork adds an optional **Round robin** assignment mode to recurring top-level tasks.

- **Fixed** preserves Yuvomi's existing assignment behavior.
- **Round robin** stores an ordered list of household members.
- The first member owns the current/new occurrence.
- Completing the task creates the next recurring occurrence for the next member.
- The rotation wraps back to the first member after the final member.
- The recurrence schedule itself is unchanged; assignment rotation is independent of due-date calculation.
- Existing fixed tasks remain fixed by default.

Example for three synchronized shower-position tasks:

- `Take Shower - 1st`: Grace → Eleanor → Frank
- `Take Shower - 2nd`: Eleanor → Frank → Grace
- `Take Shower - 3rd`: Frank → Grace → Eleanor

Each task advances one position when its current occurrence is completed.

## Current scope

Round robin is intentionally limited to recurring top-level tasks and requires at least two household members. Automatic skipping of unavailable members and manual rotation reseeding are not included in the first version.


## Rotation groups

Recurring round-robin tasks can optionally share a **Rotation group**. Give each task in the group the same ordered member list and recurrence schedule, then assign each one a unique **Group position**. The group waits until every task in the current cycle is complete, then creates the entire next cycle atomically and shifts every position to the next member.

For a shower order with Grace, Eleanor, and Frank, create three daily tasks in the same group with positions 1, 2, and 3. The assignments advance as a cohort: `Grace / Eleanor / Frank`, then `Eleanor / Frank / Grace`, then `Frank / Grace / Eleanor`.

Reopening a task from the completed source cycle removes the entire generated next cycle only when all of those generated tasks are still safe to discard. If any generated task contains work under Yuvomi's existing recurrence safety checks, none of the group is deleted.
