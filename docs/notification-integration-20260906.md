# Notification integration technical appendix

This appendix describes the notification work in the product refinement branch based on `de4be2702dee7f1cd9828f01f9ab6c7b4bd0ad04`. It accompanies [the product review](product-refinement-review-20260906.md). The changes were integrated as reviewed patches; release metadata and unrelated upstream behavior were not imported.

## Upstream changes and fork compatibility

| Upstream commit | Integrated behavior |
| --- | --- |
| `c2f348e8` | Auth-router scope hardening: scoped API tokens cannot reach account/authentication management outside the regular scoped API gates. Session and legacy full-access behavior are preserved. |
| `c57725dc` | Email delivery through the existing shared SMTP service, provider readiness, recipient input and provider documentation. |
| `01bd7dfe` | Bounded recipient validation with linear processing. |
| `967423e0` | Inactive form fields disabled, live SMTP readiness, one recipient per channel, transport timeouts and reduced email-content logging. |
| `08350363` | Guarded outbound requests for Gotify, ntfy and webhook, with an explicit deployment option for private network destinations. |
| Supporting `04d139a4`, `2a2b1e6e` | Shared HTTP redirect validation, TLS downgrade prevention, credentials restricted to their original origin, and guarded resolution of IP literals. |
| `307b85d7`, `e1af7c73` | Shopping list email via existing SMTP, valid household-member recipients resolved from stored contact mailboxes, and snapshot/send UI. |
| `45f56920` | Already present event-reminder fanout verified with existing regressions; no second integration. |

Existing Calendar reminder fanout remains authoritative; the already present fanout change was not duplicated. Fork Tasks, Calendar, Meals and automation origins and channel scopes remain supported. A regression checks that a Meal reminder reaches household and matching personal email channels, excludes another member's channel, and does not repeat a successful delivery during retry.

Shopping email uses the same SMTP settings and single-address parsing, with household-member recipient checks kept separate from notification channel configuration. It sends a snapshot of the current open list. Later list changes do not alter an already delivered email; the explanatory hint now states this in every locale.

## One durable receipt, multiple delivery channels

The separately authorized notification center adds migration `10026`: personal inbox rows, category preferences and inbox delivery receipts. The migration is additive. The live-like migration regression checks that upgrading a database at fork version `10014` applies only the expected new migrations, preserves existing migration timestamps and domain values, and performs no work on a second run.

Existing reminder generation and event fanout are unchanged. When a due reminder is processed, the dispatcher first saves a personal inbox receipt with a unique source key. New assignment, Meal, Calendar/planning, Shopping and automation events use the same receipt service. Each delivery channel receives the saved title, body and destination rather than independently regenerating a message. Read and dismissed history survives duplicate source attempts.

Personal domain events use personal channels. Existing reminder household channel behavior is preserved. Source access is checked using the recipient's current module and entity permissions. Inbox and preference endpoints require a session; an API token accompanied by a valid cookie cannot bypass that boundary.

The bridge imports legacy target receipts before attempting delivery. Successful targets are not resent, and failed targets retain their attempt count and retry time. Already pushed reminders are not backfilled: history starts with newly processed notifications. Muting and later reenabling a category therefore does not replay a muted reminder backlog.

The dispatcher checks dismissal, category preference, source access and current assignment state again before each target, including after another provider has awaited a response. Completed or superseded requests stay in history but do not produce an obsolete outbound alert. Deleting a reminder cancels pending retry while retaining its existing inbox history.

One active run per database prevents overlapping scheduler ticks in the same process. A recovery path also handles interruption between recording completed inbox delivery and updating the legacy reminder completion marker.

## Delivery and device privacy

Web Push carries the inbox ID and opens `/?notification=<id>`. The application resolves that ID for the authenticated current user before navigating to its canonical destination. The service worker accepts only safe destinations on the application's origin.

Shared display mode applies to the entire browser device, including routes outside the dashboard. The worker persists a privacy flag across restart, logout and service-worker upgrades. Enabling shared display suppresses queued notifications and clicks, closes visible notifications and revokes the local browser subscription before attempting server removal. A server failure therefore does not leave the local subscription active.

Push startup verifies that an existing subscription belongs to the current session. Switching accounts does not silently bind another household member's browser subscription. Returning from shared display does not automatically enable push. Generation checks prevent delayed permission, ownership, repair or registration responses from reenabling delivery after logout or a privacy change. Cross-tab shared-display changes also invalidate personal delivery.

## Security details

- Notification email uses the shared pure single-address validator. Display names, groups, lists and parser-control syntax cannot redirect a message to an unintended mailbox. Household membership is enforced separately where the workflow requires it.
- An already aborted email request cannot begin an SMTP send. Shared SMTP connection, greeting and socket limits bound stalled transport work.
- Gotify, ntfy and webhook requests validate every redirect, including literal addresses that bypass DNS lookup. DNS results remain guarded, cross-origin redirects lose sensitive credentials, and HTTPS cannot downgrade to HTTP.
- Synchronous HTTP setup failures reject normally after asynchronous address validation. Invalid schemes and request headers cannot leave a pending promise or produce an unhandled rejection.
- Existing LAN/private provider destinations require the documented `NOTIFICATION_ALLOW_PRIVATE_NETWORK=true` deployment option. The default denies private destinations. This does not change SMTP's existing application-level configuration.

## Validation evidence

The final automated matrix passed **1,670 checks across 76 unique suites**. Counts use each suite's final result once; earlier attempts remain in the evidence rather than inflating the total. Relevant coverage includes:

| Area | Final checks |
| --- | ---: |
| Notification dispatcher and retry behavior | 60 |
| Inbox permissions, preferences and source lifecycle | 16 |
| Push server routes | 23 |
| Actual push client privacy behavior | 9 |
| Actual service-worker notification privacy behavior | 4 |
| Notification center | 8 |
| Shared HTTP and SSRF | 29 + 18 |
| Shared email and Shopping email | 22 + 15 |
| Migration remap and Meal reminder migration | 5 + 3 |
| OpenAPI structure and route coverage | 6 + 3 |
| Test chain and module registry | 5 + 12 |
| Frontend audit | 346 |

The broader matrix also covers Tasks and recurrence, assignment rotation, Kitchen and grocery lifecycle, Meal Plans, travel contexts, Calendar, Reader, settings, appearance, modal navigation and service-worker caching. Changed JavaScript passed 89 syntax checks, and all 25 changed JSON files parsed. This application serves native modules directly and defines no package build script.

Machine-readable results are in `artifacts/product-refinement-20260906/integrated-matrix-results.json` outside the checkout, alongside per-suite logs and `integrated-syntax-results.json`. The evidence retains the initial stale migration-count assertion and the missing Meal hint locale key, their corrections, and successful targeted reruns. Earlier baseline Meal/grocery failures were reproduced before correction; explicit qualifying skills repaired those test fixtures without changing assignment semantics. The grocery failure concerned three versus five eligible responsibility rows; its five Tasks and five execution rows already passed.

Browser checks are recorded in [the visual QA report](visual-qa-20260906.md). Email QA used synthetic local recipients and a local SMTP sink. No production deployment or external recipient was used.

## Remaining limits

SMTP acknowledgement can be uncertain when a connection times out after the remote server accepts a message. Transport limits and target receipts reduce duplication but cannot guarantee exactly-once delivery. The scheduler guard also covers one process, not multiple independently running application processes.

The client and worker tests execute production source with controlled browser boundaries. They do not establish successful delivery through every browser vendor's remote Web Push service. The existing push transport's handling of an all-subscription transient failure remains a separate reliability improvement.

Inbox retention policy, multi-process delivery coordination and any expansion of notification categories beyond the authorized sources require a separate product or architectural decision. Existing medication scheduling remains outside this five-category extension. Some newly introduced interface text uses English fallbacks pending a full translation review.
