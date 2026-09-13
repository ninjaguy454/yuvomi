# Tasks release gate — September 13, 2026

The gate started at `d0dcae0187b33ac4b76e83582d3c6814b6b3fbbd` on `feature/tasks-refinement-20260912`. This follow-up contains confirmed release-blocking fixes only. It does not change the single-supervisor product model or add a migration.

## Correctness and security fixes

- Task authorization now runs against Express's matched route and validated decoded identifiers. Encoded IDs, numeric aliases, trailing slashes and case variants previously bypassed raw-path checks. Equivalent Automation and Housekeeping adapters are covered.
- Existing-Task replacement, status, supervisor, archive/delete and related destructive mutations require a saved revision. Missing revisions return HTTP 428 with an update/refresh explanation, malformed revisions return 400, and stale revisions return 409. Child actions also require their parent snapshot; action-scoped supervisor requests require the canonical source snapshot. First-party writers supply these tokens. Positive compatibility fixtures emulate a current client; adversarial fixtures deliberately retain missing/stale tokens.
- Append-only comment creation and Task creation do not require a nonexistent prior revision. Trusted internal CalDAV transitions explicitly opt out inside their existing canonical lifecycle transaction; interactive clients cannot request that exception.
- Live Task streams recheck their persisted authenticated session. Logout, expiry and permission revocation close old streams within the one-second observer interval. SSE is session-only; API-token consumers retain ordinary permission-checked reads/writes.
- Clients refresh on stream failure, suspend on network loss/page hide/auth expiry, and reconnect on recovery/resume. A rejected closed stream is replaced rather than retained forever.
- A successfully saved comment exits its edit form before the guarded refresh. Failed saves keep the draft editable. Previously the successful editor blocked its own refresh and stayed disabled.

## Upgrade and rollback evidence

The supported encrypted production backup contained schema 10031, 201 migration records and 70 Tasks. The exact base candidate upgraded an isolated encrypted copy to 10032 by applying only migration 10032. Every old table's rows and columns, and every prior migration record including timestamps, remained unchanged. Integrity was `ok`, with no foreign-key violations. Reopening the upgraded database applied nothing and preserved every table hash. Full application startup and controlled container restart returned HTTP 200 at `/health`, with only one migration application across both starts. No supervision backfill ran during the gate.

The previous production image, `ac4e4a26ab1d4d0026ce5747a9e4021ca5a2a027`, opens the additive 10032 schema without replay. That is not a safe functional rollback: it has neither member capabilities nor linked-supervision enforcement. **Rollback requires the pre-deploy schema-10031 database backup together with the previous image and configuration.** Its startup against an isolated restored backup returned HTTP 200 and preserved schema 10031. Retain the upgraded database separately before restoring; later changes are absent from the older backup.

Rehearsals use network-disabled disposable containers and encrypted copies. The database key is read only into process memory from the existing protected configuration; no workspace secret file is created. Deployment must repeat identity, fresh backup, migration-history, restart and health checks against the final validated commit.

## Validation scope and limits

The final combined regression passed **2,251 tests in 123 files and 25 suites**, with no failures, cancellations or skips. The separately run OpenAPI/MCP contract subset passed 65 tests; those overlap the main matrix and are not added to its count. The dedicated release suites exercise restricted Task-adjacent surfaces, simultaneous supervisor changes, invalidation around supervised completion, recurrence races, missing/stale revisions, live session revocation and lifecycle recovery. Browser checks cover multiple tabs, actual isolated server restart, logout and permission revocation. The exact production SPA/service-worker 8 to candidate 9 upgrade retained login and received a new Task live after activation without another refresh. Physical host sleep and network disconnection are not performed; the corresponding browser lifecycle/reconnection events are exercised without disrupting the household host.

The unchanged production lockfile has existing Nodemailer 9.0.5 and qs 6.15.3 advisories. Source review found no newly reachable untrusted application path for their reported vulnerable features. This remains a known dependency-audit limitation, not a claim that the dependency audit is clean. No broad dependency upgrade belongs to this gate.

One-time legacy supervision backfill is a separate post-deployment operation. It must first preview remaining explicit requirements, canonical supervisor selection and recognized helper identities; preserve learner progress and all prior history; reject ambiguous helper/checklist adoption; and record exact changed Tasks. It is not a recurring legacy rewrite job.
