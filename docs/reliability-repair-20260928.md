# Vidamia reliability repair — September 28, 2026

This is an incident-driven repair of transport, live refresh, and interrupted Task interactions. No Task, Rotation, rewards, permission, recurrence, or database semantics changed. Release evidence is kept in `.qa/reliability-release-20260928`; isolated diagnostic/test evidence is in `.qa/reliability-20260928` and the named transport logs.

## Incident and initial state

- At 07:33 EDT (11:33 UTC), production and remote `main` were `83705e825fcf46ec60c77869fc80ddc768d527a2`. The feature checkout was clean at that same commit. There was no unrelated pending source to publish.
- Production image: `yuvomi:release-83705e825fcf46ec60c77869fc80ddc768d527a2`, image ID `sha256:d6a34facba222985f1c412d450d03e62fb57939aa25dd4ec98085738d3c3d773`.
- The container had been running since September 22 at 20:19:42 EDT, with Docker restart count zero. It was healthy, using about 1.85 GiB and 0.13% CPU at inspection. These samples do not establish absence of earlier pressure.
- Schema was 10043, 213 migration records, encrypted database, integrity `ok`, zero foreign-key violations. Migration history hash: `e4d789c506ed59dfdba713cd9df79f001a6cf6cf7e3366ec19555bbc29e0cdb7`.
- Six rounds at 07:35:56–07:36:05 EDT returned 200 from container, Windows localhost, Windows LAN, and public HTTPS. Observed health latency: container 26–31 ms, localhost 2–65 ms, LAN 3–30 ms, HTTPS 2–40 ms. This is reachability evidence, not authenticated Task latency.
- Caddy was still using `127.0.0.1:3000`; Docker published port 3000, and Windows had listeners. Retained Caddy log directory was empty and its service stdout/stderr were not configured. The actual reported morning 502 window cannot be correlated to a retained proxy error.
- Application logs showed hourly recipe-provider fetch failures between 00:19 and 07:19 EDT; these ran independently of Task requests. No captured Task-route crash, process restart, or database-lock error established them as the 502 cause. The 02:00 database backup finished in about 198 ms, outside the reported morning use.
- The historical WSL localhost forwarding incident remains a plausible lead, not a diagnosis of this incident. No Docker Desktop, WSL, proxy, firewall, TLS, port, or network changes were made. No recovery restart was needed during investigation because all observed paths were available.

## Confirmed defects and repairs

| Finding | Repair and direct evidence |
| --- | --- |
| All write 403 responses were retried as CSRF failures, including permission denial. | Retry once only for the canonical explicit CSRF rejection. Context is checked before token publication and replay. Permission failures remain rejected. Transport/device-context tests cover both. |
| Interrupted successful JSON bodies could become a null success; network failures did not preserve uncertainty. | Body reading remains bound to its original auth context. Structured errors retain status, retry timing, and unknown/rejected/unavailable outcome. No automatic write replay. |
| A read-only service-worker snapshot could appear to confirm an uncertain write. | Canonical Task readback requires a fresh response and rejects `x-cached-at`, including with an older installed worker. |
| EventSource errors triggered auth checks and broad refetches on native repeated reconnects; ordinary Task version events also reread auth. | One owned connection with bounded exponential backoff/jitter, cancelled listeners/timers, and coordinated catch-up. Ordinary version invalidation needs no additional auth read. Old auth contexts cannot resume on focus. Device and rewards streams use the same bounded principles. |
| Repeated Task invalidations started overlapping list reads. | Per-view coalescing: 20 simultaneous triggers produced 20 reads before, at most one in flight plus one catch-up (two total) after. No authorization/eligibility cache was added. |
| An initial failed Task load could leave a sticky error after successful recovery. | Successful canonical refresh clears the load error. Retrying uses the existing mounted view, preserving filters, expansion, focus and scroll. |
| Checkbox acknowledgement loss cleared provisional feedback and reported a definite failure. | Preserve an unconfirmed intent, stop duplicate/queued writes, read back canonical state. An unchanged revision cannot prove rejection; show canonical progress plus a read-only Check status action until settled. No offline write queue. |
| Router session-read errors sent valid users to Login. | Only actual 401 causes the expiry path. Transport failure uses a neutral retry screen. Existing authorized board data stays visible during transient failures; auth end or permission loss still removes private content. |
| Installing a service-worker update forcibly reloaded open drafts. | Offer an explicit update action; retain the existing stale-module guard on later navigation. An already-running old client still contains its old update handler until refreshed. |

The Task board has one polite stale/reconnecting indicator. Successful reads remove it. Definite permission/lifecycle/revision rejection retains canonical handling; 429 is not aggressively retried. Reward adjustment/redemption retry keys and once-only server effects remain unchanged and are covered by the affected safety gate.

## Diagnostics and scope

Added bounded request diagnostics: request correlation ID, module bucket, method, status/outcome and duration only; at most 30 records per minute plus a suppression count. No full URLs, query strings, household identities/content, cookies, credentials, or request/response bodies. Successful fast requests and normal long-lived stream disconnects are silent. `REQUEST_DIAGNOSTICS=false` disables it.

This can help distinguish future application errors, rate limits, slow responses and interrupted connections. A proxy failure before the request reaches Vidamia will still require proxy/forwarding evidence. The application middleware does not establish prevention of a WSL forwarding recurrence.

Background review found expiration and shared Rotation processing already bounded (500 and 100 items per tick respectively), with synchronous work not overlapping within one process. No measured backend algorithm bottleneck justified a lifecycle or scheduler rewrite. Recipe sync overlap was a source-level possibility without incident evidence; no speculative changes were made.

## Focused validation

These gates overlap; their counts must not be summed into one supposed unique total.

| Gate | Result |
| --- | --- |
| Transport regressions against exact production source | 16 failures in 19 tests; three existing guarantees passed. These assertions represent several defects, not 16 independent root causes. |
| Corrected transport/device/live/start/refinement gate | 110 passed; subsequent CSRF context guard covered by 25 transport/device tests. |
| Task regression reproductions against production source | Four failures retained; same paths pass after correction. |
| Task queue/readback/loader and affected UI gate | 104 passed, including unchanged-revision uncertainty and no write retry. |
| Actual-backend expanded-card browser gate | Eight passed; the two new lost-acknowledgement/outage cases passed again after stricter readback. List, Kanban, mobile scrolling, points/recurrence once, second client covered. |
| Task Details browser gate | 14 passed, including keyboard Check status, uncertainty and authoritative convergence. |
| Router/update regressions | Both failed on production source and passed after correction. |
| Root session, service-worker privacy/cache/precache, device context, reward intent and diagnostics gate | 59 passed. |
| Canonical device/supervision, optional, expiration/recurrence, shared Rotation, reward integrity/adjustment gate | 86 backend tests passed. Two reward browser tests failed to launch Edge, then both passed with Chrome. |
| Full-application concurrent soak | See the appended measured result below and retained JSON report. |

Infrastructure distinctions: Edge exited during browser launch; those launches are not test passes. Express's Windows dot-directory handling blocked the isolated full-app fixture under `.codex`; test-only runtime placement/exact-index handling addressed that without changing production static serving. One unrelated service-worker upgrade assertion still expects cache version `vidamia.21`; it fails against unchanged production source (`vidamia.24`) too. It is not a new regression. Physical Apolosign/Fully Kiosk touchscreen timing was not measured.

The short full-app scenario used the same 11 concurrent three-client waves, 36 checklist steps, and injected faults against archived production and candidate runtimes. Production source issued 419 observed requests, 65 auth reads and 81 Task-list reads; the candidate issued 299, 26 and 53 respectively. Production source also hit 12 genuine, non-injected global rate limits; the candidate had only the deliberately injected 429 responses. This reproduces request amplification under multi-client recovery; it does not prove that rate limiting caused the household's morning 502s. The baseline run overlapped another test workload and lasted 93 seconds versus 38 seconds for the short candidate, so these are workload observations, not a controlled server-latency improvement claim.

The final concurrent run lasted **603.013 seconds** and passed. All 653 copied `server`/`public` file hashes matched the final runtime source. It observed 449 API requests, with five deliberately injected 429 and five deliberately injected 502 responses; no unplanned rate limits. Task-stream connections were 1 / 1 / 3 for personal List / personal Kanban / paired display, with the paired reconnections following injected offline and sleep/resume events. Auth reads were 5 / 3 / 19.

| Measurement, final concurrent run | Personal List | Personal Kanban | Paired display |
| --- | ---: | ---: | ---: |
| HTTP acknowledgement median | 198.6 ms | 198.8 ms | 200.7 ms |
| Task-list read median | 281 ms | 218 ms | 290 ms |
| Second-animation-frame DOM feedback median | 25.7 ms | 24.9 ms | 25.6 ms |

HTTP acknowledgement p95 was about 250 ms; DOM feedback p95 about 34 ms. These are local synthetic-browser measurements, not physical paint or external WAN latency, and no before/after backend speedup is claimed. The recorded RSS samples are the test runner, not server leak evidence.

Eleven waves launched writes from all three clients before awaiting acknowledgements. The run completed 36 ordinary steps plus a legitimately authorized supervised action. Each routine received its two points once; recurrence generated one successor; expiration created one event and zero points; the shared scheduled period finalized/advanced once; duplicate completion Activity events were zero. Integrity passed with zero foreign-key violations. Device attempts on protected learner/helper/bulk work were rejected. An unsaved draft survived another client's live mutation; genuine session expiry removed personal content. Separate card browser cases directly asserted second-client convergence, focus/scroll/expansion and held-response optimistic feedback. Rotation coverage here is the initial permitted shared widget plus the canonical scheduled cutoff, not a new end-to-end assertion of every Rotation-bound title refreshing.

Two final direct UI tests additionally verify that local, definitely rejected intents show their actual reason rather than an unknown-write warning (11/11 reliability-file checks including the prior nine). No runtime changed after the long run's copied source was captured.

## Release contract

Publish only the frozen clean commit containing these changes, normally and without rewriting history. Build from its Git archive; compare packaged runtime hashes. Take a new supported encrypted backup and verify it, retain the prior image/configuration, and rehearse database startup twice against an isolated encrypted backup. Expected schema remains 10043 with zero migrations and unchanged prior migration history. Change only the image reference in existing Compose. Verify container, Windows localhost and HTTPS, then one controlled application restart and authenticated read-only Tasks access. Do not mutate real household progress or awards for acceptance.

The release is a bounded reliability improvement. Passing these tests cannot certify the system free of intermittent infrastructure failures.
