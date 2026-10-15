# Category assignee limits

Task categories already support adding, renaming and ordering. In **Tasks → Manage categories**, the assignee-limit field now accepts a positive whole number, or a blank value for no limit. Use1 for personal work and a larger maximum for shared work. These are maximums, so unassigned/claimable work remains possible. Category names do not imply behavior.

The limit counts people directly assigned to the activity. People included through a subtask and supervisors retain their separate roles. A person holding both roles counts once as a direct assignee. A rotation may have a larger candidate pool; only its requested performers per occurrence count toward the limit.

New work and explicit changes to direct assignment/category use the configured rule. An unchanged editor save, completion, past award or existing recurring definition is not converted when a category limit changes. New recurring definitions capture the rule, and later occurrences keep it until an explicit future-series change. Accepting or manually claiming work is an explicit assignment choice and checks the current category limit.

An existing Activity whose direct authorship cannot be established safely requires explicit review before adopting a restrictive category rule. The application does not guess direct assignees from the old combined visibility list. It never truncates, splits or rewrites that work automatically.

This setting does not change scoring modes, award sources, beneficiary selection, supervisor eligibility or subtask visibility. A single-person template still has one beneficiary and one scalar override. Creating independent activities for several people in one launch, fixed multiple-person template overrides and helper-specific activity views are separate features.

Implementation uses an additive migration10061 on the280410d baseline. Existing category limits start null; existing records are not backfilled. Separate prospective policy/direct-assignee metadata preserves the meaning of the older assignment relation. Older clients may omit the category field; edits retain its stored value. New clients send `direct_assignee_ids` alongside their matching `assigned_to` selection to distinguish direct intent from old visibility echoes. Reusable Activity/Workflow category references prevent deletion; stable category keys survive renaming.

This is a local feature candidate. Publication and deployment are outside this change's authorization.
