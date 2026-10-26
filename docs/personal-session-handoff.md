# Personal session continuity and remembered browsers — integration handoff

Scope: approved personal-session work only. No pairing code/QR, shared-device
credential lifetime, live credential enrollment, key rotation, publication or
deployment. These notes describe the personal-session release contract.

## Source and integration

Branch: `fix/personal-session-continuity`.
Base: `45a1d81548024fdcd7a3524f2b8c4d3e74c697b1` (public main on October 26).
Live source label was `f8a0256e72c7772dd70c19376b135d45d0df3862`, healthy;
the base adds only a documentation star-count refresh to that live revision.
All production inspections were read-only metadata queries. No production DB
was opened and no signed-in browser or live credential was used.

Cherry-pick this branch's implementation commit onto the combined release.
`public/sw.js` is intentionally untouched: the integration owner must advance
the combined release cache generation so browsers fetch the changed login,
API and account-settings modules. No changes to the release owner's checkout.

## Implemented contract

- Personal cookies and server expiry renew together for seven days of HTTP
  activity, capped at 30 days from login. Cookie bounds are reapplied when
  express-session touches the cookie at response completion, including first
  issuance near a remembered grant's expiry. Static assets avoid forced JSON
  session rewrites and new Set-Cookie responses.
- Successful password + fresh local second factor offers an unchecked
  “Remember this personal browser for 30 days” checkbox. A random 256-bit
  cookie credential has a server-side SHA-256 hash, fixed expiry and account
  security epoch. The cookie is HttpOnly, SameSite=Lax, host-only, Path=/, and
  Secure when the existing deployment flag is true. Tokens never appear in
  JSON, URLs, diagnostics or browser storage APIs.
- Remembered login still verifies the password and account eligibility, then
  rotates the SID. It skips only the repeated local factor. It neither extends
  the grant nor confers fresh-factor assurance. Trust expiry/revocation is
  checked on every linked personal-session read and save.
- Logout forgets presented browser trust, including when the SID already
  expired. That sessionless, access-reducing logout checks exact Origin and
  Fetch Metadata; authenticated logout retains existing CSRF protection.
- Own browser listing/revocation and sign-out-everywhere are available in
  personal account settings. Both use the existing logout cleanup/broadcast.
  Grants cannot be enumerated or revoked across accounts; bearer API tokens
  cannot operate these personal-browser endpoints.
- Password/factor changes invalidate personal authentication through durable
  per-account epochs and revoke remembered grants. Recovery-code regeneration
  also revokes personal trust/sessions. This can require the current personal
  session to log in again after a successful security change.
- Security changes require a factor verified within five minutes. Existing
  per-action factor requirements for disabling 2FA/recovery generation remain.
  Password, reset-email, OIDC linking, account management, API token and household
  2FA-policy writes cannot borrow remembered-browser assurance. The client
  prompts for a current factor and retries only the pre-handler rejection.
- Paired device contexts cannot enroll/use trust; their leases, launch behavior
  and action approval proofs remain intact. Personal metadata continues to
  govern a personal session after it enters Wall view, preventing an exemption
  from its existing cap/revocation. Legacy Wall-only sessions retain their flow.
- Session deletion records a durable tombstone. An atomic conditional upsert
  prevents stale saves from resurrecting a deleted SID, including writers in
  another process. Account epochs invalidate held stale personal saves as well.

## Schema, compatibility and recovery rulings

Ruling: use auth-store-owned idempotent DDL, following the existing `sessions`
table ownership, rather than allocate a fork migration number that collides
with concurrent release work. The new tables are `personal_session_policy`,
`personal_auth_epochs`, `remembered_browsers`, and `personal_session_revocations`.
Triggers cover session deletion, password-hash changes and factor changes.
No household rows are rewritten. A first-rollout timestamp is persisted once.

Ruling: unknown legacy session issuance cannot be reconstructed. Existing
unexpired personal sessions without metadata adopt a fixed cap 30 days after
first rollout; it cannot slide on traffic or restart. Accounts with a security
epoch change cannot adopt a legacy session. No existing browser is auto-trusted.

Ruling: fresh-factor assurance lasts five minutes, without extending trust or
the absolute session cap. Revocation and sign-out operations only remove access
and do not require an additional factor.

Personal tombstones are retained for 31 days; a stale personal session is past
its maximum lifetime before cleanup. Existing device tombstones are untouched.
Restoring an older DB may restore old grants, so recovery must explicitly
invalidate personal grants/sessions. An old-code rollback that ignores epochs
or tombstones cannot preserve new revocation guarantees. Prefer a forward fix
or a rollback retaining this enforcement, with new grant issuance disabled.

## Validation and review

The first four HTTP regressions failed on the base, demonstrating missing cookie
renewal/trust and stale-save/account invalidation. The final tests exercise the
real Express session middleware, SQLite store, password/2FA routes and guards.
No fake production identity or live trust enrollment is used.

Independent reviewer `review_personal_sessions` inspected the changing branch
read-only. Its actionable findings were Wall-view lifetime exemption,
response-time cookie clamping, reset-email step-up, password-normalization
epoch/hash recheck, static-asset writes, expired-SID logout, and cross-tab
cleanup. These were addressed. The Wall and expired-SID logout regressions
were observed RED then GREEN. The reviewer did not independently execute the
final suites; final execution is the implementer's evidence.

Run with bundled Node v24.19.0 (system Node v18 is unsupported):

```
node --test --test-force-exit --test-concurrency=1 test/test-personal-session-security.js test/test-device-auth.js test/test-two-factor.js test/test-session-lifecycle.js test/test-auth-router-token-scope.js test/test-password-reset.js test/test-password-normalization.js test/test-admin-password-reset.js test/test-sw-upgrade.js test/test-session-secret-guard.js
node --test test/test-personal-session-browser.js
```

Set `VIDAMIA_TEST_SW_CACHE_VERSION=2.54.0-kitchen.5-vidamia.94` on this base;
the combined release must set its own new expected generation. The repository
has no generic `npm test` script; targeted scripts are supplied. The existing
admin-password test leaves its application server open, requiring Node's
`--test-force-exit`; an initial overlapping stale-server run was discarded,
and a clean expanded rerun passed 116/116.
Final Edge browser run passed 2/2: opt-in enrollment, reload and actual process
restart on the same synthetic SQLite DB/key, password-required remembered login,
logout restoring the 2FA prompt, and sign-out-everywhere clearing another tab.
The cross-tab test waits for canonical account data, because authenticated event
streams intentionally prevent a network-idle condition. No known failing test
remains in these selected suites.

Local logs (ignored by Git): `session-final-tests.log`,
`personal-browser-final.log`, `session-last-check.log`. Browser tests require
Edge with a disposable profile; sandbox profile encryption failed, so browser
execution used the approved unrestricted process launch. Safari/iOS and a real
installed PWA have not been tested on this Windows host. User-cleared/private
storage can still erase recognition. No permanent recognition is promised.
The cross-tab fixture uses direct DOM activation of the sign-out control after
real authentication; native pointer activation was intermittent in the Edge
headless/foreground-tab fixture. Its behavior must receive ordinary interactive
release QA. The enrollment test uses actual pointer/keyboard input.
Combined-release verification subsequently passed both browser cases with the
normal Edge browser sandbox enabled and native keyboard activation of the
sign-out-everywhere control. The two tabs both returned to login. This replaces
the earlier direct-DOM activation limitation for that case; physical Safari,
iOS and installed-PWA behavior remain unmeasured on this Windows host.
An encrypted recovery test also verified persisted revocation after reopening
a backup, and explicit trust/session invalidation on an older restored snapshot.

New trust-management copy is English; locale-specific translations are deferred.

## Measured request overhead

Reproducible synthetic helper: `test/helpers/personal-session-benchmark.mjs`.
300 sequential local requests per workload, 30 warmups, baseline/candidate then
candidate/baseline. Each session workload and asset workload made exactly 300
SQLite row changes in both versions. No added write count was measured.

| Run | Baseline p50/p95 ms | Candidate p50/p95 ms |
| --- | --- | --- |
| Identity A/B | 13.55 / 15.68 | 13.40 / 15.79 |
| Identity B/A | 14.60 / 16.19 | 14.36 / 16.18 |
| Asset A/B | 13.25 / 15.93 | 14.20 / 15.64 |
| Asset B/A | 14.41 / 16.08 | 14.11 / 16.17 |

The final atomic upsert candidate measured identity 14.73/16.29 and asset
14.87/16.17 ms, also 300 changes each. These local measurements show no
consistent material latency increase; they do not establish low-end-device,
WAN, or concurrent production performance. Extra indexed reads and larger
session JSON remain real costs. The combined release needs its normal QA,
encrypted-copy/recovery verification and cache-generation check before deploy.
An additional trust-linked candidate run measured identity 14.82/16.14 and
asset 14.80/16.02 ms, with 300 SQLite changes per workload.
