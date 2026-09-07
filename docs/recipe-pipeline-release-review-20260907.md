# Optional Cooking Map release-readiness review

Verdict: **READY WITH KNOWN LIMITATIONS**. No unresolved release blocker was found after the corrections below. Nothing was pushed, merged, or deployed.

## Scope and candidate

- Branch: `feature/recipe-pipeline-20260906`.
- Submitted candidate: `376b9e898f24998263064328cf8f5b07cb6da827`, initially clean.
- Released branch baseline: `f63c226cb00f904f707f35f9df439a8c49571324`.
- The complete feature diff against that baseline was reviewed, including the shared modal changes, recipe routes/editor, graph engine, renderer, service worker, migration, OpenAPI descriptions, and test changes. This document accompanies the follow-up correction commit; the final commit identity is reported separately after committing.
- Review corrections are limited to the feature's editor lifecycle, portion drafts, frontend conventions, and the CSS test parser exposed by its imports. No new recipe capability, graph model, grocery behavior, migration, or provider behavior was added during this review.
- Automated checks used isolated or in-memory databases. Browser checks used a new synthetic household at `http://127.0.0.1:3099`. Production data and configuration were not used.

## Blockers and defects corrected

| Finding | Correction and evidence |
| --- | --- |
| A late native-copy response could replace a newer, dirty Cooking Map and lose its draft. | The workspace that started the copy now owns the navigation. A closed or replaced workspace cannot reopen itself, including during the mobile close animation. Tests exercise the production editor and recipe-list callback with delayed responses. |
| Repeated clicks on native-copy creation could issue multiple POSTs. | A busy state locks the operation until completion or failure. The regression verifies one POST for two clicks, correct opening of the returned native recipe, and retry after failure. |
| Unfinished portion names and quantities existed only in DOM fields and disappeared when the editor rendered another view or operation. | Portion inputs now live in the local workspace draft, participate in dirty-state protection, and survive preview, written-view, and operation changes. Save asks the author to create the portions or clear the fields. Scratch fields are never persisted as graph data. Cancel explains and guards their removal. |
| Removing a selected division material could leave an invisible stale selection that blocked Save. | Removing that resource clears only the stale selection. Typed portion names and quantities remain visible and protected. Both edge-case regressions failed before correction and passed afterward. |
| New rendering code bypassed the repository's HTML-update convention, and the mobile graph breakpoint differed from its token contract. | Renderer/editor updates use the existing DOM insertion pattern. SVG redraws replace paths rather than duplicating them. The single-column breakpoint is 640px; its Edit controls use the shared touch-target token. |
| Draft confirmations lacked a clear explanation of consequences and were styled as persistent destructive actions. | They now explain what happens to the draft and saved map, and follow the shared modal's ordinary draft-discard treatment. Saved records are not deleted by these dialogs. |
| The new CSS imports exposed a test-parser defect: the first `.recipes-page` rule was swallowed by preceding statement at-rules. | Exact baseline testing passed, and the unchanged runtime scrollport declarations were verified. The shared test scanner now handles semicolon-terminated at-rules without losing selectors or nested contexts. Its existing eight-page assertion remains unchanged. |

## Compatibility, integrity, and API results

**Written recipes:** verified normal reads and CRUD without pipeline fields, provider reading, ordinary instruction editing, and recipe-to-shopping handoff. Legacy create/update payloads cannot inject or replace the execution columns. Graph outputs do not become shopping items. Existing recipes without a map remain valid, and written instructions remain the default recipe presentation.

**Graph:** reviewed explicit `consumes`, `requires`, `equipment`, and `produces` semantics. Dependencies come from resource relationships, never card order. Ingredients are starting resources; components and readiness have exactly one producer. Material can be consumed at most once, and terminal outputs need no consumer. Deliberate material fan-out uses explicit portions. Readiness may be required by multiple operations without being consumed. Equipment is descriptive metadata and adds no implicit edge or reservation.

Validation and adversarial checks covered linear and deep chains; independent branches; fan-in and fan-out; direct/indirect/self cycles; missing references; deletion of referenced resources; multiple producers and repeated material consumption; duplicate display labels; stable resource/operation identity; renamed labels; invalid metadata; and graph size limits. Additional checks enumerated all completion subsets of a small branching graph, all 120 operation-order permutations, a 100-operation chain, 99 readiness consumers, and 2,808 arrow-routing geometry subcases. These subcases are not counted as thousands of independent tests.

**Persistence and review state:** server validation is authoritative. Saves require the expected revision and current written-source hash, then validate current ingredient bindings within the transaction. Concurrent saves and written-source changes produce conflicts rather than overwrite existing data. Ordinary ingredient/instruction edits retain the graph and mark it for review. Title/category/meal-type-only changes and replacement SQL ingredient row IDs do not cause unnecessary review. The editor requires review acknowledgment before saving a stale map; the server enforces the current source hash and ingredient bindings, with no separate acknowledgment flag. Browser checks confirmed preservation of the graph after an instruction change, refusal before acknowledgment, successful review/save, and cleared review state after reload.

**Save/Cancel and asynchronous work:** tests exercise production workspace handlers, including clean open/edit, rejected and confirmed discard, double Save, failure/retry, conflicts, late save/copy responses, mobile close animation, portion-only dirty state, and removal of a selected portion material. Browser Back uses the existing shared dirty-state guard. A late response cannot reset a newer editor's dirty baseline.

**Duplication:** topology and internal recipe-scoped IDs are preserved within independent recipe documents. Editing the duplicate and deleting its source leave the copy intact. Stale review state is preserved rather than silently acknowledged. Creation is transactional, including failure during ingredient copying.

**Provider/native copies:** Mealie and Tandoor mirrors remain read-only and usable as written recipes. Only Cooking Map authoring requires a native copy. Copies preserve ordinary content while dropping provider linkage. Actual provider-sync logic, exercised with synthetic adapters, updated and deleted mirrors without changing their native copies or maps. No live provider account was contacted.

**Bounds and access:** current creator, effective Meals write permission, and token/module restrictions are enforced. Limits are 100 operations, 300 resources, bounded reference lists, and 20 equipment entries per operation, with bounded identifiers/text/metadata. A maximum-count example of 460,979 bytes saved successfully. Over-limit counts/text were rejected. An 8 MiB request was rejected under the application's actual default 7 MB JSON limit without advancing the map revision. The route-test fixture's smaller parser limit was not mistaken for the production limit.

## Migration and rollback

Migration **10027** is unchanged by this review. It is additive and introduces exactly:

- `recipes.execution_json`: nullable text.
- `recipes.execution_revision`: `INTEGER NOT NULL DEFAULT 0`.
- `recipes.execution_source_hash`: nullable text.

No recipe backfill, data rewrite, table rebuild, or new table occurs. Real isolated upgrade from schema 10026 applied only 10027 once. Restart retained the authored graph, revision, data, and migration history without replay. Fresh startup reached the same terminal schema. Existing append-only migration and live-like earlier-upgrade checks passed, as did integrity and foreign-key checks.

Exact baseline database and recipe-route source was exercised against an already-upgraded disposable database: startup and written-recipe CRUD preserved the new columns and maps without replay. Returning to current code marked written edits made under baseline code as review-needed. A separate SQLCipher round trip also passed.

**There is no schema downgrade.** These checks establish source-level compatibility, not a boot test of the retained old Docker image, its scheduler, mounts, or production encryption configuration. An actual isolated prior-image smoke test remains necessary before claiming that image has been verified against schema 10027. Restoring a pre-upgrade database backup would discard all household writes since that backup, not only Cooking Maps.

## Browser QA record

The changed surfaces were inspected directly in the running local app. This was a representative matrix, not every viewport multiplied by every theme.

| Viewport / appearance | Observations |
| --- | --- |
| 1366 × 900, Neutral Dark and Warm Light | Three-column independent prep; readable ingredient/output labels; material and dashed readiness lines; clearly identified convergence; long banana-bread names wrap without clipping. |
| 768 × 900, Warm Light/Dark and Cool Light | Two-column branches; separate-sauce convergence; operation editor and metadata fields remain aligned; fixed Save/Cancel remain visible; focus outlines remain visible. |
| 390 × 844, Cool Dark and Neutral Light | Single-column map, deliberate toolbar wrapping, 44px graph Edit targets, stacked operation editing, readable provider-copy state and instructions, visible Save/Cancel. |
| 600 × 900, Neutral Light | Confirmed the corrected single-column breakpoint and shared control sizing. |

Warm, Neutral, and Cool were each inspected in Light and Dark across this matrix. Serif was checked on recipe/map headings, with functional fields and metadata remaining sans-serif. Default typography was also inspected. DOM measurements found no horizontal page, modal, workspace, or graph overflow in the inspected layouts. SVG arrows remained present after resizing and switching views. Long graphs require vertical scrolling; mobile presents one stage card per row rather than squeezing a desktop graph sideways.

Interaction checks included: provider reading and shopping handoff; optional entry from expanded written instructions on mobile; creation of a native provider copy; building and saving explicit ingredient portions; retained fields after preview; blocked Save for unfinished portions; browser Back and cancellation of discard; successful Save and reload; ordinary recipe editing; review-required handling; confirmed Cancel restoring the saved map; and draft-only confirmation consequences. Synthetic shopping received the written ingredient rows without any graph products.

No drag-and-drop authoring is implemented or claimed; existing move controls change display order, while relationships determine graph order. Physical touch devices, a screen reader, and the retained production Docker image were not tested in this review.

## Automated validation and evidence

Final integrated result: **841 passed, 0 failed, 0 skipped across 33 unique test files**. The retained manifest lists each file exactly once. It covers graph/editor/workspace/renderer/routes/migration, written recipe CRUD, duplication/provider adapters/sync/routes, imports/exports, modal/history, schema/migration guards, grocery lifecycle, Shopping/Pantry routes, service-worker caching/update, frontend/typography contracts, module registration, suite registration, and OpenAPI checks.

A separately run changed-area layer-boundary check passed **3/3**. Thus the repository checks reported here comprise **844 distinct checks across 34 files**, without adding repeated focused runs to the total. All 24 changed JavaScript files passed syntax checks; package JSON/lock parsing and diff checks passed.

Supplemental audit evidence, kept separate from that repository total:

- Nine adversarial graph/rendering audit tests passed, including the enumerated geometry/permutation subcases above.
- Nine backend scenario groups passed, including actual sync execution, boundary payloads, written grocery handoff, fresh/restart behavior, and prior-source compatibility.
- The separate encrypted rollback round trip passed.

Earlier failures were retained for traceability: the initial frontend compatibility run exposed the HTML-update, breakpoint, consequence, and CSS-parser findings; the first integrated attempt was 840/841 because draft confirmations still carried persistent-danger treatment. After matching the existing draft-discard convention, its focused check passed and the final complete integrated run passed 841/841. These attempts are not added to the final totals.

Logs, manifests, and supplemental harnesses are under `artifacts/recipe-pipeline-release-review-20260907/` in the parent workspace, including `integrated-final.log`, `integrated-manifest.json`, `confirmation-focused.log`, `layer-boundary-focused.log`, `graph-adversarial-audit.mjs`, and `backend/` evidence. Screenshots and DOM observations were captured in the review conversation; the table above is the concise visual QA record.

## Known limitations

1. If a pipeline save commits but its response is lost, the editor retains its local draft and stale expected revision. Retrying safely conflicts; it cannot overwrite a newer map. Reopening is required to read the persisted version. Capture any additional edits made after the failed response before closing, then reapply them if needed. Automatic reconciliation was not added in this bounded review.
2. Cooking Maps are manually authored deterministic data. Equipment sharing, food safety, quantities, temperatures, and cooking completeness still require the author's judgment. The engine validates graph structure, not the culinary correctness of a recipe. Timers, assignments, schedules, AI generation, and Pantry accounting remain outside scope.
3. New map-specific copy remains English. Existing Markdown export retains written recipes and does not round-trip the graph. Neither limitation blocks ordinary recipe usage.
4. Large valid maps can require substantial vertical scrolling, especially on mobile. The tested renderer avoids card-intersecting routes, but no claim of an optimized diagram for every 100-operation layout is made.
5. Production migration, deployment, real provider-network refresh, physical-device testing, and actual prior-image rollback were not performed. Those remain operational verification boundaries, not completed evidence.

No unresolved blocker remains in the reviewed implementation. Release approval is still separate: **READY WITH KNOWN LIMITATIONS**.
