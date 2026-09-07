# Meal portions and recipe serving basis

Status: implemented and validated locally on `feature/meal-portions-serving-basis-20260907`. No push, merge, or production deployment. Base commit: `6481168dd62f926d4ddd69e4f1fe53004e9aead2`.

## Product and model decision

Each person's portion amount belongs to their existing Meal occurrence response (`meal_person_decisions`). It is a request for that occurrence, so it does not belong to a completed execution record, a Recipe, or a Cooking Map resource. Existing participation records determine whether the amount counts. Their saved amount survives opting out.

The existing Recipe is the reusable food definition. It now has two independent optional concepts:

- **Recipe yield:** how many portions the listed ingredients make. This enables batch scaling.
- **Serving basis:** the physical amount represented by one portion. This supports the live display and does not independently change ingredient quantities.

No new participation, allocation, preference, or grocery ledger table was introduced. Dish totals are derived from the existing menu selections, responses, and individual/Backup Meal children. Stable selected-menu identifiers distinguish ingredient sources within the existing grocery ledger.

The user approved rounding each selected dish independently and including selected dishes in canonical grocery runs. One person's chosen amount applies to their selected entrée and each selected side. This pass does not add a separate amount for each side.

## Additive schema 10028

| Existing table | Added fields | Defaults and purpose |
| --- | --- | --- |
| `meal_person_decisions` | `portion_amount`, `revision` | Amount defaults to 1; revision defaults to 1 and supports stale-save checks. |
| `meals` | `planned_portions` | Cached exact requested total; backfilled from participating participant-role records. Existing fixed cook amounts are preserved. |
| `recipes` | `yield_portions` | Nullable batch yield; old recipes remain unspecified. |
| `recipes` | `serving_basis_amount`, `serving_basis_unit`, `serving_basis_label` | Nullable physical serving definition. |
| `meal_grocery_item_sources` | `planned_portions_snapshot`, `cook_portions_snapshot` | Demand evidence retained with the existing source history. |

The response amount is authoritative. Meal totals and dish totals are projections; the cached Meal total and grocery snapshots do not create another editable source of truth.

Amounts accept 0.01 through 1000 with at most two decimal places. Recipe yield accepts 0.01 through 10000, and serving amount 0.01 through 1000000, also with at most two decimal places. The stepper changes an amount by 0.25 and clamps at the supported boundaries. A decrement at 0.01 stays at 0.01.

## Defaults and units

The default is the saved response for this occurrence, otherwise 1. There was no suitable existing member-wide usual-portion preference, so none was added. Recipe yield and physical serving size do not silently choose a person's appetite.

Serving units are `count`, `oz`, `lb`, `g`, `kg`, `fl_oz`, `cup`, `tbsp`, `tsp`, `ml`, and `l`. Countable food uses a free display label such as cob, slice, taco, or fish stick. Unit identity is separate from display wording (`fl_oz` displays as “fl oz”; `ml` as “mL”). There is no food-unit taxonomy or new mass/volume conversion engine.

Examples: 1.50 portions of a four-fish-stick serving display 6 fish sticks; a six-ounce serving displays 9 oz. Fractional items are allowed. The live physical amount retains the four-decimal product of the two inputs, so a valid small serving does not display as zero.

## Exact demand, cooking, and groceries

Requested totals retain hundredth-portion precision. In automatic mode, each dish's requested total rounds upward to its whole-portion cook target. For example, 2.25 portions of the shared entrée and 1.25 of a Backup Meal mean 3.50 requested portions, with cook targets of 3 and 2 respectively. Sides have their own targets; the UI lists each dish rather than presenting an ambiguous sum of entrée and side portions.

An existing explicit fixed cook amount or manual ingredient override remains authoritative. Changing to automatic mode uses requested portions again. Generated individual Meal children use automatic portions, while explicit fixed overrides on those children remain intact.

For an explicitly yielded recipe, ingredient scaling is:

`listed ingredient quantity × dish cook target ÷ recipe yield`

This buys for the intended cooked amount, including the upward whole-portion rounding. Serving-basis metadata is not a second multiplier. Explicit-yield calculations retain up to six decimal places and round positive scaled demand upward at that precision. The shared parser handles decimal/comma quantities, leading decimals, ordinary fractions, and supported Unicode fractions. Unparseable ingredient wording remains unchanged.

Existing quantity semantics are preserved when yield is unspecified:

- Existing materialized Meal ingredient snapshots and manual overrides remain authoritative.
- The legacy recipe fallback keeps raw recipe quantities.
- Existing automatic ingredient materialization retains its historical portion-count scaling. Unspecified yield does not mean all legacy paths had identical semantics.
- Recipe Book handoff with an explicit yield delegates initial batch scaling to the server; unspecified yield keeps the existing handoff payload.

Selected recipe-backed sides and alternate dishes enter the same canonical run and provenance system. Custom recipe-less sides do not accidentally reuse the entrée's ingredients. A side-only response does not invent an entrée selection. Individual Meal demand is included once. Category/grouping and context-specific grocery exclusions remain in effect.

Changing portions or yield invalidates affected unpublished drafts. Finalizing or publishing a stale draft returns a refresh instruction. Refresh preserves published history, subtracts only already-published demand, and cannot publish a superseded draft. Legacy transfer remains available where safe; Meals requiring selected-dish accounting are directed through the canonical grocery run.

Pantry reconciliation and later stock operations preserve six-decimal quantities, including when several small receipts merge to a two-decimal-looking balance. Existing manual creation retains its prior two-decimal default. Tests cover repeated receipts, consumption, editing, and idempotent reconciliation.

## Interface and compatibility

The existing Meal participation form contains the portion field, right-aligned numeric entry, quarter-portion buttons, and live physical quantities for the chosen entrée and sides. It becomes inactive while opted out. The existing confirmation action saves the response. Invalid/empty values cannot silently become 1; stale tabs show a clear reopen instruction instead of overwriting a newer response. Arrow keys also step by 0.25, and wheel scrolling cannot change the field.

Recipe editing has a compact “Portions and serving size” group. Blank optional fields retain legacy behavior. Existing recipes without serving metadata and Meals without a linked recipe still support ordinary participation and generic portion display.

Existing actor/beneficiary permissions apply when responding for another member, and audit records retain the acting user. Portion updates, participation changes, child Meal updates, and audit writes remain transactional. The UI sends the expected response revision. API callers omitting that optional field retain backward-compatible last-write behavior; stale-write protection requires sending it.

Provider mirrors remain read-only. Users duplicate into a native recipe to edit serving data. Native duplication preserves serving metadata and an independent Cooking Map. Serving-only changes do not reinterpret the written-batch Cooking Map, mark it stale unnecessarily, or alter its graph. This pass adds no scaling of Cooking Map resources, AI generation, scheduling, timers, or assignments.

## Validation

The final integrated run passed **896/896 checks across 37 test files**, with no failures, skips, or cancellations. It included Meals, plans, contexts, groceries, Pantry, Shopping, recipe routes/providers, Cooking Maps, migration lineage, OpenAPI, service-worker precache, frontend guards, responsive rules, appearance, and typography. The retained local log is `artifacts/portion-final-integrated.log` (ignored by Git).

Focused coverage includes:

- Persistence, exact sums, upward cook targets, live physical math, fractional countable items, input limits, and 0.25 stepping.
- Opt-out/rejoin restoration, acting for another member, independent member edits, invalid input, stale revision rejection, and audit ownership.
- Independently rounded entrée/side/Backup demand, chooser selection inheritance, side-only choices, custom sides, and legacy extra snack choices.
- Explicit yield during create, apply-plan, Recipe Book handoff, and legacy transfer; unspecified yield and fixed/manual snapshots remain compatible.
- Stale draft publication rejection, refresh before/after publication, preserved provenance, Pantry reconciliation, and idempotent retry.
- Small quantities: two 0.0025 kg receipts become 0.005 kg; four receipts become 0.01 kg and consuming 0.0025 leaves 0.0075; consuming 0.0175 from 0.02 leaves 0.0025. Editing 0.01 to 0.0125 remains precise.
- Native/provider-copy rules, partial serving edits, invalid basis rejection, and Cooking Map preservation.

Migration coverage builds a populated schema-10027 database, starts the real database module, verifies only 10028 applies, and starts it again. Restart applies nothing; schema stays 10028; previous migration history, existing recipe/ingredient/Cooking Map data, fixed cook amounts, and Meal timestamps remain intact. Old response rows receive amount/revision 1, optional recipe fields remain null, and integrity/foreign-key checks pass. The isolated browser database also restarted at 10028 without a migration replay.

JavaScript syntax checks passed for all 31 changed/new JavaScript files. `package.json` parses successfully, and the diff whitespace check passed. An independent final review found no remaining severe issue in the changed permissions, revision, transaction, or draft freshness paths.

## Visual QA record

All browser interaction used the isolated application at `http://127.0.0.1:3097` with synthetic household data. Production was not changed.

| Viewport | Appearance / theme / typography | Surfaces inspected |
| --- | --- | --- |
| Desktop, about 1366 × 900 | Light / Warm / Serif | Meal details, portion control and recipe serving editor. |
| Desktop | Dark / Cool / Serif | Meal details and recipe serving editor. |
| Tablet, 768 × 1024 | Dark / Neutral / Default | Meal response and recipe serving editor. |
| Tablet, 768 × 1024 | Light / Neutral / Serif | Meal response, live amounts and recipe serving editor. |
| Mobile, 390 × 844 | Light / Cool / Serif | Meal response, quarter stepping and recipe editor through More actions. |
| Mobile, 390 × 844 | Dark / Warm / Serif | Final portion fields, both selected serving bases, focus states, scrolling, recipe save and precise Pantry display/edit. |

The controls fit the inspected surfaces without introducing horizontal overflow. Desktop places the physical quantities across a row; mobile stacks them and retains practical input/button targets. The recipe serving amount and unit share a row on mobile, with the countable label below. Existing token-based themes and heading typography are retained.

Final interactive checks verified 1.50 → 1.75 gives 6 → 7 fish sticks while the corn quantity also updates; 0.01 cannot step below its minimum; 1.125 is rejected; opt-out/reload/rejoin restores 1.50; saving from a stale second tab is rejected; and an unchanged Pantry edit/reload retains 0.0025 kg. Recipe serving fields saved successfully. Provider and acting-for flows were covered by route/regression tests rather than a live external provider or production household browser session.

## Deliberate limits

No member-wide default preference system, per-side personal amount, unit conversion engine, provider metadata inference, or Cooking Map batch scheduling was added. Legacy free-text quantities cannot be safely interpreted when they are not numeric. Existing manual/fixed decisions remain intentional overrides, so automatic requested-portion changes do not replace them. The local candidate is ready for review; deployment still requires a separate release instruction.
