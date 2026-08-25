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
