# Known correctness corrections — 6 September 2026

**Verdict: READY WITH ACCEPTED EXTERNAL LIMITATIONS.** The three requested correctness issues are fixed within the boundaries below. Nothing was pushed, merged or deployed. Production deployment still requires the user's approval.

This pass started from clean `20f7bc2a72af50ce7b189b3e90ff2ca84b61387e` on `refine/product-coherence-20260906`. It supersedes the grocery draft, Reader header and lost Task-create-response findings in [the earlier release review](release-readiness-20260906.md). It adds no feature area, visual redesign or domain migration. The final handoff identifies the commit containing these corrections and this report.

## Corrections and deliberate boundaries

### Grocery draft ownership

An unpublished canonical grocery draft already records its Meal sources in the existing grocery ledger. The legacy preflight previously recognized only published sources. Removing that publication-only condition makes existing source ownership authoritative from draft creation onward.

All three legacy import routes now reject owned Meal demand before writing: individual Meal transfer, weekly Meals transfer and Shopping's date-range Meal import. The existing 409 response directs the user to continue the canonical grocery run in Shopping, including finalizing its draft. Mixed batches reject before partial transfer, and selecting another Shopping list does not bypass ownership.

This uses the existing item/source ledger without guessing quantities from ingredient names. Draft refresh releases sources that no longer belong to its demand; published history remains protected. Contexts excluded from canonical grocery tracking do not create ownership, so unrelated legitimate legacy quantities remain eligible. Grouping, categories, context overrides, Meal Plan generation and canonical Pantry reconciliation are unchanged.

The exact regression is now: draft exists → legacy transfer blocked → canonical publication → generic Pantry bypass blocked → canonical purchase reconciliation once, including retry. It produces one Shopping row and one unit in Pantry. Additional tests preserve 1.25l Home plus 2.75l Trip as 4l and a legitimate excluded-context 5l purchase as a combined 9l in Pantry; equal ingredient names do not cause legitimate quantities to disappear.

Existing contaminated data is intentionally untouched. This guard does not infer or merge unlinked legacy purchases made before a canonical draft existed, or redesign overlapping canonical runs. Automatically repairing such history could discard real quantities and remains outside this pass.

### Reader cache headers

The first Reader router middleware sets `Cache-Control: private, no-store` before session lookup and every handler. Anonymous sign-in, two-factor pages/redirects, validation failures, access denials, successful pages and mutation redirects now share the protection. Redundant handler-specific headers were removed. Reader layout, authentication and offline behavior are unchanged.

### Lost Task-create responses

The Task form now uses the existing `Idempotency-Key` middleware and receipt table. Each logical create retains its key and original POST payload on the same form until the Task ID is recovered. A lost response retries that original request. If the user has edited fields, recovery first retains the original ID, then updates that Task through the existing PUT path. A failed follow-up update or accessory save therefore retains the same ID for the next retry.

An initial definitive 4xx rejection can release the attempt for corrected input; timeouts and in-progress conflicts cannot. Once any result is ambiguous, later validation, authentication, permission or rate-limit failures cannot discard its identity. Malformed successful responses also retain the attempt. Keys are not attached to unrelated mutations. The existing API client's CSRF retry preserves the key and payload.

This fixes an accepted create whose HTTP response is lost, including edited retries. It does not promise global exactly-once creation: receipts retain the existing 24-hour lifetime, and closing/reopening the form starts a new create. Existing receipt-storage fail-open behavior, stale in-flight takeover after 60 seconds and process failure between domain commit and receipt capture remain broader lifecycle boundaries. The separate assignment-request POST/refresh ambiguity identified in the earlier report is not part of this Task-create correction.

The service-worker cache generation advances from `refinement.1` to `refinement.2` so existing candidate installations receive the changed Task module. Visible app release and device privacy state remain unchanged; the upgrade regression now includes the preceding candidate generation.

## Migration changes

**None.** No migration, schema definition, migration history or database reconciliation implementation changed in this pass. The schema remains **10026**, verified in the isolated running copy. The existing migration append-only, remap, schema mirror and reconciliation suites pass in the integrated matrix. There is no new migration whose application or restart replay needs testing; the prior 10025→10026 upgrade evidence remains in the earlier release report.

## Validation

All results below are from this pass. Node 24.19 was used; databases and transport faults were isolated from production.

| Check | Result |
| --- | --- |
| Grocery lifecycle and reconciliation | **15/15 passed**, including four new route-backed regressions that failed before the guard fix. |
| Adjacent Grocery/Meals/Shopping/Pantry batch | **166/166 Node results passed**. The legacy Shopping helper's 40 internal assertions are inside one file-level result, not 40 additional Node results. |
| Reader plus worker upgrade/API-cache batch | **34/34 passed**; Reader alone **15/15**. Anonymous, validation and create-redirect header assertions failed before the header fix. |
| Final Task/API/worker focused batch | **64/64 passed**: real-route idempotency 18, actual controller workflow checks 22, API/CSRF 13, upgrade 5, precache 6. |
| Real Task transport fault | The server commits the first Task and replay receipt, then the test destroys its HTTP socket before the client receives the response. Same-key retries recover exactly one Task; edited retries use PUT; assignment notification is not duplicated. |
| Independent review | Grocery ownership/quantity preservation, Reader middleware order, Task retry/error-state boundaries and cache revision reviewed; no remaining must-fix found in this bounded diff. |
| Full integrated matrix, run once after source freeze | **79/79 suites, 1,751/1,751 checks passed**, no failures, skips or uncounted suites; no source drift. Includes legacy assertion checks as well as Node test cases. |
| Syntax/JSON/whitespace | **95/95 JavaScript files**, **25/25 JSON files**, and `git diff --check` passed. The repository has no package build script. |

The integrated matrix covers the complete refinement branch against original baseline `de4be2702dee7f1cd9828f01f9ab6c7b4bd0ad04`, plus the existing idempotency suite. It reuses the earlier gate's integrated selection; it is not a claim that every test script in the repository was run. Exact commands, logs and SHA-256 source hashes are retained.

## Browser QA

A separate loopback-only preview on port 3097 used a coherent copy of the synthetic household database, with provider channels disabled and Push subscriptions removed in that disposable copy. The user's preview on 3096 and production were not restarted or changed.

Chrome loaded the final frontend from a fresh local origin. A test-only transport wrapper dropped precisely one successful Task create response after the server had stored Task **129** and its 201 replay receipt. The form displayed its existing error and re-enabled Create. Changing the title to “QA lost response browser revised” and retrying closed the form with success. The filtered list showed one Task, and its detail opened successfully. A read-only database check confirmed the same ID **129**, the revised title and exactly one matching row. Warm/Dark/Serif form, list and detail screenshots were visually inspected; no layout changes were made in this pass.

Two generic asynchronous-listener errors appeared in Chrome logs without an identified origin or matching visible failure; the intentionally dropped response was verified separately in server evidence. This is not a claim of universally clean browser logs. The disposable test tab was closed after verification.

## Accepted external limitations and evidence

Accepted remote email/Push cannot be recalled, and SMTP cannot guarantee exactly-once delivery after ambiguous acceptance. Other physical devices/PWA installation and real external SMTP/Gotify/ntfy/webhook destinations were not retested here. The user previously confirmed browser notifications worked after enabling Windows notifications; that confirmation is preserved and is not generalized to other devices. These operational limits remain unchanged as requested.

Evidence is under `C:/Users/Duaner/Documents/Codex/2026-08-26/are/artifacts/known-correctness-20260906`: `grocery-draft-red.log`, `grocery-draft-ownership.md`, `grocery-adjacent-regressions.log`, `reader-before.log`, `reader-cache-focused.log`, `task-cache-focused-final.log`, `integrated-matrix-results.json`, `integrated-syntax-results.json`, `browser-dropped-response.json` and `browser-retry-result.json`. Evidence scripts, disposable data and logs are outside the committed checkout.
