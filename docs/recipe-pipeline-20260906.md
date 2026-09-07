# Native Recipe Pipeline / Cooking Map

Implemented on `feature/recipe-pipeline-20260906`, based on released commit `f63c226cb00f904f707f35f9df439a8c49571324`. This feature has not been pushed or deployed.

## Product behavior

Written ingredients and instructions remain the normal Recipe Book view. **Visualize recipe** opens an optional Cooking Map. A recipe without structured data offers **Build Cooking Map**, which copies its ingredient occurrences into a new draft and leaves operations empty. Nothing is inferred from prose and there are no AI calls.

The editor lets the author select each operation's inputs, ready-state prerequisites, outputs, equipment, optional duration/range, and temperature. It supports adding/removing operations, renaming outputs, and changing display order. Connections follow resource selections automatically; users never enter dependency IDs or draw arrows. Removing an output that another operation uses is blocked until that input is replaced.

**Preview Cooking Map** draws independent branches, convergence, and sequential steps. Materials use solid arrows and ready-state prerequisites use dashed arrows. Cards also name their producers and prerequisites, so the relationships do not depend on color or the SVG. Stages indicate dependency depth, not a timed schedule or a requirement to finish every card in a stage before starting the next one.

Edits are drafts until **Save pipeline**. Cancel/discard, operation removal, and closing use the existing modal/history infrastructure. A confirmed in-place removal keeps the editor open; canceling confirmation retains edits. Errors retain the draft and receive focus/scroll into view, including when Save is in a fixed mobile footer.

## Domain document

Each native recipe may own one optional document with `schema_version: 1`:

| Part | Fields and meaning |
| --- | --- |
| Resource | Stable recipe-local `id`, `kind` (`ingredient`, `component`, or `readiness`), `name`, optional textual `quantity`, and ingredient `source_index` |
| Operation | Stable `id`, `label`, `consumes`, `requires`, `equipment`, `produces`, optional `duration`, optional `temperature` |
| `consumes` | Ingredient/component resource IDs transformed by this operation |
| `requires` | Reusable readiness resource IDs, such as an oven heated to a stated temperature |
| `equipment` | Tool names only; they create neither dependencies nor reservations |
| `produces` | Component/readiness resource IDs created by this operation |
| Duration | `{ min_seconds, max_seconds }`, or unknown (`null`) |
| Temperature | `{ value, unit: "C" | "F" }`, or unspecified (`null`) |

The shared deterministic engine validates and normalizes the document, indexes each resource's sole producer, derives operation edges from `consumes` and `requires`, and performs a stable topological traversal. It exposes independent layers, an ordered traversal, initially executable operations, terminal outputs, unused ingredients, and executable operations for a supplied set of completed IDs. No cooking-session completion state or scheduling is stored.

Validation rejects unsupported versions/fields, duplicate IDs, invalid references/types, missing or multiple producers, self-dependencies, cycles, invalid metadata, and repeated consumption of the same material. Limits are 100 operations and 300 resources. Output names can change without breaking their references.

A starting ingredient binds to one current written ingredient occurrence, independent of replaceable SQL ingredient row IDs. Saving rejects missing, duplicate, out-of-range, or mismatched bindings. The author explicitly relinks changed ingredients; resource IDs and downstream connections remain stable.

For divided ingredients, **Divide into portions** inserts an ordinary operation consuming the original material and producing named portions. An existing consumer visibly moves to the first portion. The author enters quantities; there is no unit conversion, quantity arithmetic, Pantry reconciliation, or second grocery model.

## Banana bread example

The executable fixture in `test/fixtures/recipe-pipeline.js` contains the full versioned document. Its branches include:

- Preheat oven → ready state **Oven heated to 350°F**.
- Divide butter → **Butter for pan** and **Butter for batter**; divide flour similarly.
- Butter/flour portions → prepare pan → ready state **Buttered and floured loaf pan**.
- Mash bananas, melt butter, and beat eggs → combine with vanilla → **Wet mixture**.
- Whisk flour portion, sugar, baking soda, baking powder, and salt → **Dry mixture**.
- Wet mixture + dry mixture + walnuts → fold → **Banana bread batter**.
- Batter, requiring the prepared pan → **Filled loaf pan**.
- Filled pan, requiring the heated oven → bake with explicit time/temperature → **Baked banana bread**.
- Cool in pan → cool on rack → **Cooled banana bread**.

Other fixtures cover a linear recipe, kneading/resting/rising, stovetop plus oven components, a separately prepared sauce, and cooling/resting stages.

## Persistence, compatibility, and permissions

Append-only migration **10027** adds three columns to `recipes`: nullable `execution_json`, integer `execution_revision` (default 0), and nullable `execution_source_hash`. It adds no table and performs no existing-recipe backfill or data rewrite. Existing recipes begin without a pipeline.

Recipe reads include the pipeline and its current/saved source identity. `PUT /recipes/:id/pipeline` requires the expected pipeline revision and current recipe source hash; competing saves or source changes return a conflict without overwriting data. Only the native recipe creator with effective Meals write access may save it. Existing token/module restrictions remain enforced.

Changing written ingredients or instructions preserves the authored graph and marks it **Needs review**. It is not silently regenerated. The editor requires review acknowledgment, and the backend additionally validates current ingredient bindings. Recipe title changes and replacement SQL ingredient IDs alone do not invalidate the map.

`POST /recipes/:id/duplicate` atomically copies ordinary recipe data, meal types, ingredients, graph, and saved source hash into a caller-owned native recipe. A stale graph stays stale on the copy. Provider-managed recipes remain read-only and must be duplicated before editing a pipeline. Provider adapters/import formats are unchanged. A corrupt saved graph is isolated on reads and cannot be silently dropped by duplication.

The service worker stages the new modules/styles in the separate `recipe-pipeline.1` cache generation. A partially failed install leaves deployed `refinement.2` assets intact. Recipe API responses are not added to the offline API whitelist.

## Validation record

All automated tests ran with Node 24 against isolated/in-memory databases or disposable upgrade fixtures. Browser QA used the local app at `http://127.0.0.1:3098` with a synthetic household. Production configuration/data were not used.

| Automated group | Result |
| --- | --- |
| Pipeline model, editor, graph renderer, persistence, migration | 107 / 107 passed |
| Backend pipeline + recipe/provider/import + schema/upgrade matrix | 171 / 171 passed |
| Frontend model/editor/renderer + modal + SW/cache + module guards | 164 / 164 passed |
| Changed JavaScript syntax, package JSON, diff checks | Passed |

The backend and frontend matrices overlap in three Markdown-export tests: **332 distinct checks** in those two matrices. This is focused and adjacent validation, not a rerun of the previous release's full 1,751-check matrix. Logs are retained outside the repository in `artifacts/recipe-pipeline-20260906/`.

The old live-like migration test expected the previous terminal schema 10026 and 196 history rows. Its expectation now includes 10027 and 197 rows, along with the new three columns; previous migration identities, timestamps, data preservation, and restart assertions remain unchanged. Real upgrades from 10026 applied only 10027 once, and a second startup preserved the graph, revision, migration history, foreign keys, and database integrity without replay.

### Visual and interaction QA

| Viewport | Observed result |
| --- | --- |
| Desktop 1366 × 900 | Three-column parallel branches; convergence and material/readiness arrows; full-width sequential cards; no horizontal page/modal/board overflow |
| Tablet 768 × 900 | Two-column map; side-by-side operation picker and fields; metadata controls align and share rows; no horizontal overflow |
| Mobile 390 × 844 | One-column map; wrapped toolbar; stacked editor/portion fields; operation selection focuses its fields; fixed Save/Cancel; no horizontal overflow |

Warm, Neutral, and Cool were visually inspected in both Light and Dark. Serif applied to map/recipe headings while fields and dense metadata remained sans-serif. Concrete fixes from QA included themed select styling, genuinely hidden read-mode footers, confirmation behavior that retains the editor, and visible mobile validation errors.

Browser interactions verified creating a two-operation map from scratch; duration/equipment editing; preview, Save, and reload; Cancel retaining the saved map; canceled discard preserving a draft; operation removal remaining in the workspace; recipe edits marking review-needed; refusal to save before review; rejection of stale ingredient snapshots; explicit relinking preserving connections; duplication preserving the graph; explicit 180 g/20 g portions replacing one 200 g ingredient use; cycle rejection preserving the saved graph; and the optional mobile entry point from normal written instructions.

## Deliberate limits

No AI/prose parsing, scheduling, timers, assignments, skill checks, Pantry accounting, or provider-mirror annotations were added. Equipment is descriptive and does not guarantee two independent steps can physically share a tool. Quantities and cooking instructions remain authored data. Existing Markdown export remains the written recipe format and does not round-trip the new graph. New Cooking Map copy is English in this pass. Physical-device/assistive-technology testing and production migration/deployment have not been performed.
