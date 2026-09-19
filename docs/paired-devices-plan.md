# Paired household devices

Verified base: `59682354368d87a18594c49cea557d841a4c3921`, branch
`feature/rotation-groups-20260919`, clean. Production has the same image revision
and schema 10040; read-only integrity and foreign-key checks pass. This pass is
local only. Migration 10041 extends persistence and relaxes the human-creator
constraint through a preservation-tested table rebuild; Rotation migrations
remain unchanged.

## Implementation contract

- Separate household device records and hashed, revocable browser credentials;
  never a `users` row or a substitute human actor. Reuse capability names and
  canonical Task lifecycle, reward, supervision and public Wall projections.
- A default-deny device API adapter exposes explicitly supported shared content.
  Neither an ambient personal cookie nor an API token upgrades device mode.
  Reader/MCP/unsupported APIs reject the device rather than invent a member.
- Pairing uses a short-lived single-use code approved by an authenticated admin,
  plus a secret held in the requesting browser session. Claiming pairing explicitly
  destroys only that browser's ordinary personal session.
- Temporary access runs existing password/2FA/SSO authentication. A durable device
  context generation binds the temporary session and every request; return,
  expiry, revocation and permission changes invalidate older requests and streams.
  Default timeout: 120 seconds idle, 600 seconds absolute. Background polling
  does not extend idle time. A fresh application launch returns to device mode.
- Frontend context changes hide private content, abort old requests, discard late
  responses, clear caches and synchronize tabs. Service-worker API caching stays
  disabled throughout both device and temporary personal access.
- Device completion uses the existing responsibility and reward beneficiary;
  Activity records device source separately from an unauthenticated human actor.
  Protected supervision and helper work requires actual temporary human access.
- Separate device preferences hold layout and appearance. The checklist preset
  can read permitted public/shared content and complete existing independent work;
  reopen/reset/claim are separate opt-ins. Plain Task creation, text editing,
  assignment, dates and point changes have separate administrator opt-ins.
  Templates, Workflows, structural checklist editing, ledger/reward-price changes
  and administration require authenticated personal access.

The final interface is Household Settings → Devices. Default visible widgets are
Tasks, Calendar, Meals, Shopping, Points, Rewards and Shared Rotation. Household
Wall appearance may seed a new display; all subsequent preferences belong to
that device. Device Task actions use the existing optimistic subtask queue.

Temporary access defaults to 120 seconds idle and 600 seconds absolute. Allowed
configuration is 30–300 seconds idle and 60–1800 seconds absolute, with maximum at
least as long as idle. Hiding the privileged page, loss of connectivity, or a
fresh application launch returns conservatively to device mode. The server still
enforces both clocks and the original request context. Ordinary personal phones
and PCs retain their existing session behavior.

Reader, personal token-only feed subscriptions and full database restore require
an ordinary personal browser. Restore replaces the credential/session database
used to enforce temporary authority. Temporary access otherwise uses the normal
administrator app. Personal push delivery remains disabled on a paired display,
including during temporary access and after service-worker restart.

Validation uses synthetic households, real HTTP authentication and focused UI
tests, encrypted populated migration rehearsal, context-race/privacy tests and
held-response checkbox observations. Physical Fully Kiosk/Apolosign behavior is
reported separately from browser emulation. No production household data changes.
