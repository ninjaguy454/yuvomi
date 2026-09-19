# Paired-device validation evidence

This records the locally executed API, projection, database-lease and migration
checks for the paired-device candidate. It does not constitute production or
physical-kiosk validation. Final SHA, Task/browser evidence and readiness belong
in the final sections added by the integrating agent.

## Executed checks

| Evidence | Latest result | What it directly establishes |
| --- | --- | --- |
| [Device HTTP tests](../test/test-device-auth.js) | 14/14 passed | Real password/session/pairing routes, real 2FA enrollment and recovery verification, explicit personal-to-device transition, single-use concurrent claim, default-deny endpoint boundaries, origin/CSRF, context changes, idle/absolute expiry, revocation, live-stream termination, and post-await write rejection. |
| [Device content tests](../test/test-device-content.js) | 7/7 passed | Complete returned-payload privacy, member/module/point/Group scope, pure Rotation previews, overnight shared order, preference persistence and isolation. |
| [Database write-lease tests](../test/test-device-write-context.js) | 4/4 passed | Native statement compatibility, post-await run/get/all/iterate/exec/pragma protection, rollback, independent request contexts, and no extra ordinary-request SQL. |
| [Encrypted migration rehearsal](../test/test-device-migration.js) | 1/1 passed | Populated encrypted 10040 → 10041 upgrade, record/index/trigger/sequence preservation, integrity, foreign keys and fresh-process restart without replay. |
| [Documents](../test/test-documents.js) and [DMS routes](../test/test-dms-routes.js) | 34/34 passed together | Existing document preview policies and DMS route behavior remain compatible after the targeted guards. |

These are suite counts, not a sum of repeated executions. The combined device
run had 25 passing tests before the additional preferences test; that later
content run passed all seven content tests. Earlier failing reproductions were
not counted as passing runs.

Executed from the repository root with the bundled Node runtime:

```text
node --test test/test-device-auth.js test/test-device-write-context.js test/test-device-content.js test/test-device-migration.js
node --test test/test-device-content.js
node --test test/test-documents.js test/test-dms-routes.js
```

Runtime used:
`C:/Users/Duaner/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe`.
These owned runs returned terminal/tool stdout; no raw stdout log file was
retained. The migration fixture creates an encrypted temporary database and
removes it and its ephemeral key in `finally`. The integrating release gate may
add its separately retained logs; there is no claimed backup artifact from this
synthetic rehearsal.

## Security and context-race evidence

The HTTP fixture mounts the actual authentication, device-management, Reader,
document and live-stream routes with real SQLite session persistence. Protected
catch-all handlers deliberately contain private markers to prove that the
central boundary rejects device access before dispatch. Those endpoint-denial
checks are not a substitute for full-application testing of every module.

Direct attempts cover Task creation/duplication, automation creation, reward
adjustments/prices/redemptions, account/API-token management, document links,
Search, private dashboard, notifications, Rotation consumer history, Reader and
MCP. Device credentials take precedence over ambient personal cookies and
administrator API tokens; missing/forged device authority never falls back to a
personal session. Cached/idempotency headers do not bypass this boundary.

Real HTTP requests held during password hashing demonstrate that account
creation, another member's password reset and the temporary administrator's own
password change cannot write after return to device mode. The users table and
password hashes remain unchanged, and late session saves cannot resurrect the
tombstoned temporary session. A separate held authenticated HTTP route, with no
route-local lease check, proves that canonical database guards reject `.run`,
`INSERT … RETURNING .get` and `.all` after return, idle expiry and revocation.

Two candidate defects were directly reproduced and corrected:

- Returning regenerated the session but retained the old CSRF response header.
  Canonical token publication now keeps header, body and cookie equal; repeated
  temporary sign-in and all three held-password cases pass.
- Normal account Logout invalidated its own database write lease midway through
  the atomic return transition. Only that already-authorized transition now runs
  without the lease; the old SID is tombstoned and unrelated sessions survive.

Payload-free device and temporary-personal SSE streams terminate after their
context changes. Tests separately verify server-enforced idle and absolute
limits, fresh-launch return, permission reduction and device revocation without
revoking the administrator's other personal session.

## Projection and preferences

Shared projections exclude private/draft Meals, private Calendar feeds, Notes,
ledger reasons and human preferences. Rotation responses allowlist Group-owned
order and schedule fields; tests deliberately contaminate nested stored context
and order data with private markers and verify none reach the response. Private
consumer usage, eligibility reasons, subject/context, completion evidence and
history are not exposed. Reading/previews do not create or advance occurrences.

Devices default to seven visible supported widgets: Tasks, Calendar, Meals,
Shopping, Points, Rewards and Rotations. A real create/update/projection test
verifies reordered widgets, hidden Shopping, large Rotation presentation,
separate theme/default view, rejection of duplicate or unsupported widgets and
unchanged household/personal configuration. Dashboard projection reuses the
device preference normalizer, including its Rotation extension, rather than
feeding Rotation widgets back into the legacy Wall-only validator. Layout does
not grant content access.

## Database lease and external-operation boundary

The write lease is request-local `AsyncLocalStorage`, installed only for bounded
temporary personal contexts. Existing permissions still authorize operations.
Native connection/statement wrappers revalidate before writes, including cached
prepared statements and returning-row statements. Read-only queries stay
read-only. Session bookkeeping has a narrow explicit exception while retaining
tombstone protection; explicit device context transitions intentionally revoke
their own authority atomically.

The measured normal path executed 1,000 wrapped INSERTs in **2.50 ms**, with
exactly 1,000 INSERT statements and **zero additional SQL**. This is a local
database microbenchmark, not a browser tap-to-paint measurement.

Document reads revalidate after awaited retrieval before disclosing bytes;
temporary responses use `private, no-store`. Document configuration/upload and
DMS link/upload paths recheck after preparation. An external deletion already
issued while authorized cannot be undone by a later session return. After that
deletion succeeds, only matching original document metadata is cleaned up
(ID, storage backend/key and creation timestamp), without authorizing another
action or returning private content. A real authenticated held filesystem-delete
test verifies this exact cleanup, preservation of another document and rejection
of a fresh device-mode delete. External providers themselves were not exercised.

## Migration design and preservation

Migration **10041** adds device principals, pairings, hashed credentials,
context/audit/tombstone persistence and source-device attribution. It also
widens `tasks.created_by` to nullable through the controlled table rebuild so
explicitly permitted device-created Tasks need no fabricated human creator.
Historical Task and completion source-device columns remain NULL; human
attribution is not rewritten. Earlier deployed migrations and Rotation
10039/10040 remain intact.

The encrypted synthetic production-shaped fixture populates human/legacy-Wall
sessions, roles/capability overrides, personal/Wall settings, Tasks and optional
progress, recurring definitions, templates, comments/history, supervision and
skills, Availability/Presence, documents/access, rewards, Workflows/Variables,
Meal compatibility assignments and independent/shared Rotation history.
Existing column values and relationships are compared by table digests; existing
index/trigger SQL and sequence high-water values are compared directly.

Only **10041** applies; integrity is **OK**, foreign-key violations are **zero**,
and a second fresh process applies **no migrations** and preserves migration
history. No device, pairing, credential or fake member is automatically created;
existing signed-in browsers and household routines are not converted.

The final integration gate found that the two existing Rotation migration tests
still expected the latest runtime schema to be 10040. This was a candidate
integration adjustment, not an unrelated baseline failure: only expected final
schema, additive migration lists and history counts were updated to 10041. All
original data/relationship/index/trigger/restart assertions remain unchanged;
neither Rotation migration nor Rotation service code changed. Running
`node --test test/test-rotation-migration.js test/test-rotation-shared-migration.js test/test-device-migration.js`
passed **4/4** encrypted cases, covering starting schemas 10038, 10039 and 10040.
That count includes the already-listed device migration case; it is not four
additional independent tests.

## Limits and separate evidence

- No production records, settings, credentials or wall display were changed.
- Actual external SSO-provider authentication and external DMS/WebDAV/Drive
  service behavior were not tested here. Real local password and 2FA flows were.
- Physical Fully Kiosk/Apolosign, touch hardware, browser Back/cache rendering and
  tap-to-visible-feedback require the separately reported browser/device checks.
- An earlier combined run including `test-admin-password-reset.js` completed its
  three assertions but did not exit because its full-server harness left
  schedulers accessing a closed database. It is an incomplete harness run, not
  a passing command; the focused suites above exited cleanly.
- Temporary-device backup/restore admission and the Task/browser suites are
  owned by the integrating agents and are reported separately below.


## Integrated candidate gate

Verified checkout: branch `feature/rotation-groups-20260919`, base
`59682354368d87a18594c49cea557d841a4c3921`. The initial tree was clean and
production was independently inspected as that same source revision, schema
10040. All work below is local; production was not changed.

The retained gate `.qa/device-final-gate.log` passes **50/50** tests across
`test:devices`: 15 real HTTP authentication/lease/supervision tests, five
adversarial boundary tests, seven content/preferences tests, 12 Task tests,
four native database lease tests, six client-context tests and one encrypted
populated migration rehearsal. Counts are reported per suite, without adding
repeated runs. The earlier 43-test backend gate is a subset, not extra coverage.

Other affected evidence:

- Ordinary authentication/token/2FA/OIDC-source/session-secret and append-only
  migration compatibility: **39/39**, `.qa/device-final-auth-compat.log`.
- Client context, session lifecycle, push and service-worker privacy: **65/65**,
  `.qa/device-final-client.log`, including bootstrap recovery. The six context
  tests overlap with the 50-test device gate.
- Existing Task/lifecycle/Wall affected validation: **190/190** in
  `.qa/device-task-final-affected.log`; after the reopen correction,
  **80/80** affected Task tests in `.qa/device-reopen-affected.log`. These
  overlap and are not summed.
- Existing Documents/DMS **34/34** as recorded above.

### Task responsibility and reward evidence

Synthetic Grace, Eleanor and Frankie routines complete without selecting or
impersonating a person. Canonical assignment remains the reward responsibility;
the device has no balance and cannot be a recipient. Device-origin Activity
records a NULL authenticated human actor plus the device identity/name snapshot;
the completion feed displays that source explicitly. Repeated completion does
not duplicate awards, history or recurrence. Claiming requires a scoped,
eligible recipient for that single action.

Direct tests reject default-preset structural/rewarded-work creation, resolved
nonzero default points, point-value changes, private descendants, stale revisions,
not-yet-started/expired work and protected supervision/helper/bulk paths. Explicit
plain-Task creation/edit opt-ins reuse canonical definition writers and retain a
NULL human creator with separate device provenance. Recurrence still materializes
through canonical lifecycle side effects without granting general creation.

The real HTTP supervision test uses the actual Tasks router. Device mode cannot
complete supervised learner work, delegated originals, helper counterparts,
support parents or bulk roots. A real password-authenticated temporary admin with
recorded proficiency completes the protected work. The learner receives exactly
2 points; Activity records the authenticated administrator rather than the device.
Returning preserves the administrator's unrelated personal session.

A directly reproduced reopening defect is retained in
`.qa/device-reopen-red.log`: a completed leaf checkbox advertised Reopen but
incorrectly also required Reset. Reopen-only now works for that leaf, preserving
sibling progress and canonical parent reconciliation. Parent/bulk resets retain
separate permission and explicit confirmation; human Task semantics are unchanged.

### Additional privacy and integration corrections

- Case-insensitive Reader/API aliases cannot bypass the principal boundary.
- Replacing/revoking device access invalidates earlier approved but unclaimed
  pairing codes; later replacement cannot revive them.
- Reader and personal token-only feeds are unavailable in a paired browser,
  including temporary access. Ordinary personal browsers remain unchanged.
- Destructive full database restore requires an ordinary personal browser before
  body/file processing, because restoring replaces the credential/session database
  enforcing temporary authority. Other permitted temporary-admin backup functions
  keep their normal authorization.
- Personal push remains disabled throughout temporary access. Two focused tests
  directly failed before the paired-client and persisted-worker checks were
  added (`.qa/device-push-red.log`), then the affected push/cache gate passed
  **53/53** (`.qa/device-push-final.log`, overlapping the client gate).
- A device invalidation stream initially buffered under full-app compression.
  Its `no-transform` policy now matches canonical streams. HTTP tests include
  production compression and assert this property; the actual browser verifies
  second-client convergence.
- Revoked-device bootstrap errors must reach the neutral recovery surface,
  rather than trigger repeated sign-in redirects. Dedicated client coverage
  preserves this distinction from expiry of a running personal view.

### Baseline and infrastructure failures

The existing `test-auth-userid.js` lexical source guard fails on preexisting
compact fallback expressions; the unchanged base reproduces it in
`.qa/device-auth-userid-baseline.log`. New device routes do not add an offender.
The suite registry guard reports the same three existing registration failures
on candidate and unchanged base (`.qa/device-suite-chain.log` and
`.qa/device-suite-chain-baseline.log`). New device unit/browser commands are
registered in their respective chains. These baseline failures were not repaired
under this feature and the entire repository is not claimed green.

The previously noted admin-reset harness failing to exit is an infrastructure
result, not a passing command. No failed launch, canceled browser run, overlapping
rerun or source-based review is included as a new passing acceptance test.


## Full application browser acceptance

**6/6** flows passed against the actual application/backend in Edge. The final
retained log is `.qa/device-browser-final/browser.log`; screenshots are beside
it. The source copy used for browser serving was compared against **643** current
`public/` and `server/` files by SHA-256, with **zero mismatches**. The copy
avoids this workspace's hidden ancestor directory, which Express deliberately
does not serve as static content.

| Flow | Direct result |
| --- | --- |
| Pair and configure | Display code approved through Devices UI; device identity, restrictive defaults, separate settings, no new member. |
| Immediate checklist feedback | List, Kanban and mobile Wall show provisional checkmarks/progress while HTTP is held 450 ms; duplicate click suppressed and expanded details preserved. |
| Temporary personal access and live update | Real administrator password login opens the normal dashboard/settings with return banner; manual return and fresh reload restore device; unrelated personal session remains; another visible authenticated browser converges through SSE. |
| Touch and layout | CDP touch pan across a checkbox does not complete it; intentional touchscreen tap works; rapid actions on three children's Tasks complete independently; saved widget order/size/visibility/density affect the rendered view. |
| Legacy Wall conversion | Explicit pairing of an existing personal Wall removes that browser's human authority without ending the other personal session. |
| Expiry and recovery | Synthetic expired server timestamps exercise idle and absolute rejection in the browser; return and Back do not restore personal content; revocation settles on a neutral recovery view without a redirect loop. |

The held-response DOM observations were **3.1 ms List, 2.1 ms Kanban and 2.2 ms
mobile Wall**. Screenshot pixels independently show the provisional checkmark and
progress before release of the held response. These figures time JavaScript/DOM
observations, **not** the first painted frame, end-to-end physical touch latency,
or production network acknowledgement. Desktop 1440, large 1920 and mobile 390
viewports were exercised. Emulation does not establish Fully Kiosk/Apolosign
hardware behavior.

The browser fixture uses focus emulation for two simultaneously visible screens;
it does not count a suspended hidden tab as a live screen. Hidden tabs reconnect
when visible. The production-compression SSE issue was a candidate defect and
was fixed. Earlier viewport/selector initialization races were test-fixture issues;
only the final complete six-flow run is counted here.

## Handoff and readiness

**READY WITH KNOWN LIMITATIONS for local handoff.** No known release-blocking
candidate defect remains in the tested identity/privilege paths. This is not a
production deployment or a claim that every repository test is green.

- External SSO provider and physical Fully Kiosk/Apolosign remain untested.
  Existing OIDC/password/2FA contracts are retained, with source compatibility
  checks and real local password/2FA tests.
- The device dashboard exposes supported shared content only. Notes, documents,
  Search and other human-only modules need temporary personal access. Reader,
  personal subscription feeds and full database restore require an ordinary
  personal browser. Plain Task edit opt-ins do not grant template/Workflow launch,
  structural checklist editing, ledger access, redemption or administration.
- There is no offline mutation queue or offline personal view. Hidden/offline
  temporary pages return conservatively in addition to the server timeouts.
- Already-issued authorized external effects cannot be recalled; stale/new writes
  and late personal UI responses are rejected, with bounded deletion cleanup as
  described above.
- Existing lexical/suite-registration failures and the incomplete admin-reset
  harness are separately identified above. They were not disguised as passes.

No household points, production records, deployed image, configuration or actual
wall browser were changed. The candidate is committed locally; its exact SHA and
clean working-tree verification are supplied in the accompanying final response.

The final ordinary-personal Task card smoke also passed **2/2** existing full-app
browser tests: provisional rapid checkbox feedback/focus/expansion and touch
scroll versus deliberate tap. Evidence: `.qa/device-browser-final/personal-card-smoke.log`.
All 57 changed/new JavaScript files passed syntax checking; whitespace checks pass.
