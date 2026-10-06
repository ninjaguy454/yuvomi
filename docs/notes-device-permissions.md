# Device Notes permissions

Device configuration separates content permissions (View, Create, Edit, Delete) from layout permissions. All layout actions require View, authorize every affected note, exclude Private and Selected members notes, and use the device's own board owner. Content permissions remain independent; Edit still controls checklist items and Show on Dashboard.

| Grant | Operations |
| --- | --- |
| `device_notes.move` | Move, resize, reorder pages within a group, Always on top, Auto-organize |
| `device_notes.pin` | Change position lock |
| `device_notes.group` | Create a group from standalone notes or join an existing group |
| `device_notes.ungroup` | Extract pages into individual notes |
| Group + Ungroup | Transfer between groups, extract into a new group, or move selected pages onto a standalone target |

Same-group transfer is a reorder and requires Move. An arrangement containing both geometry/layer changes and pin changes requires both Move and Pin. Full rectangle requests retain unchanged flags without requiring unrelated grants. Entire mixed requests roll back on denial, stale revisions or invalid content.

Existing device records with a missing new key explicitly inherit that action from Edit. Normalization and cosmetic saves preserve the missing key. The configuration control displays **Use Edit permission (legacy)** until that action is configured. Explicit Allow or Not allowed overrides inheritance independently. New pairing presets contain explicit denials for all four actions, so enabling content Edit on a newly paired device does not grant layout actions.

Receipts remain scoped to the current principal and layout owner. Replay reauthorizes the operation; Undo requires permission for its inverse effects and fresh structure. For example, undoing Group needs Ungroup, while undoing extraction needs Group. The UI only offers Undo when the current inverse authorization succeeds.

No schema migration, live grant rewrite, Calendar authority change or security-policy change is required. Release integration must retain the concurrently deployed Notes changes and use the release's normal asset-cache refresh procedure.

Validation lives in `test/test-note-granular-permissions.js`, `test/test-note-granular-browser.js`, and `test/test-device-config-browser.js`, alongside the existing device, Notes layout and group suites.
