# Activities for people and bounty helper views

In Tasks, open **Manage → Create from template**. Choose a saved Activity Template, select people, enter its inputs and Start Date, then preview before creating.

- A category with `max_assignees = 1` creates one independent Activity per selected person, each with its own checklist, scalar subject, completion identity and recurring series.
- A category with a larger limit, or no limit, creates one shared Activity. Choose its primary person explicitly; template Assignee text and existing primary-owner behavior use that person. The other selected people are direct co-assignees. Existing scoring rules determine recipients and amounts.

Template assignment overrides must already be allowed to choose different people. Shared co-assignees must qualify independently, as with the existing multi-person assignment resolver. Personal supervised Activities continue to use their existing helper rules. Category limits count direct performers, separately from supervisors and child-derived visibility participants. The launcher accepts at most 100 distinct people and rechecks permissions, eligibility and the current category at creation.

Preview creates no records or rotation changes. A launch commits all Activities, checklist items, notifications, recurrence definitions and its durable request receipt in one transaction. A failed member rolls everything back. If the response is interrupted, the browser remembers the exact request for a safe retry, including after reloading or a temporary permission denial. A replay reads currently authorized Tasks rather than saved response content. Deleted results are never recreated automatically; an explicit separate launch remains possible after acknowledging that other earlier Activities may still exist.

Shared rosters are captured in their occurrence/series definitions. Current edits and explicit future edits follow existing recurrence scopes. An ordinary editor echo preserves the chosen primary. Editing a reusable template does not rewrite existing Activities. No existing Task is converted or split automatically.

For an accepted bounty with recorded direct-assignee provenance, grouping the List or Kanban view by assignee shows the current primary's full original Activity. Each helper receives a display-only card containing that person's assigned checklist items and the unassigned items shared by all direct performers. A helper card disappears when no applicable items remain. Reassignment and normal refresh rebuild these views from current assignments; historical claim responsibilities do not keep obsolete cards alive. Older accepted work without direct provenance retains its existing participant cards until an explicit assignment review establishes that provenance.

Helper cards use original Task and checklist IDs. They offer authorized checklist actions and a labeled link to the full Activity, with no separate parent completion, reward badge, drag, swipe or bulk-selection action. They create no Tasks, awards, copies or independent completion state. The canonical Activity and other grouping/calendar/detail surfaces retain existing behavior. Whole-Activity scheduled progress totals are omitted from helper cards because those totals cannot be attributed safely to a subset.

Migration 10063 adds two empty launch-receipt tables. It changes no existing household rows, balances, grants or assignments. Launching Activities for people requires a signed-in member with the existing create, assignment and Activity Template capabilities; anonymous paired-display principals cannot use this launcher. Devices retain explicit child-assignment metadata for consistent helper cards.

This implementation is a local candidate. Publication, deployment, live data changes and historical balance repairs require a separate authorized release.
