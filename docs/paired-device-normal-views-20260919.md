# Paired devices: normal screens and in-place supervisor approval

Local follow-up to the paired-device implementation. Started from clean
`f1729ab6e12d916fb7f35c430441c7c8c1175754` on
`feature/rotation-groups-20260919`. The Rotation UI refinement and all earlier
Rotation, scheduling, optimistic Task feedback, and device-security work remain
in the history. No production records, configuration, image, or display changed.

## Application and authorization contract

Paired devices now use the ordinary Dashboard, Task List, Kanban, Task Details,
Calendar, Meals, Shopping, and Rewards screens where their capabilities allow
access. The old `/device` entry restores the configured normal landing view;
there is no separately maintained device dashboard implementation. The persistent
display banner identifies the device and offers **Sign in temporarily**.

The principal remains a device with no human user ID. Normal API URLs terminate
in a device-aware adapter before human-only routers or user-keyed idempotency.
Every projection and mutation enforces current device module capabilities and
content scope. Layout filters do not authorize access. Personal Search, document
ACLs, administration, unsupported creation/automation APIs, and reward redemption
still require authenticated personal access. This is a shared screen implementation,
not an identity substitution or a copy of the pairing administrator's permissions.

The existing administrator opt-ins for plain Task creation, title/description,
assignment, dates, recurrence, expiration, and points work in the normal editor.
Unsupported structural checklist, skill, template, Workflow, Rotation-binding,
document, and recurring-series definition changes remain personal operations.
The initial family-checklist preset grants none of those creation/edit/points
permissions. Claiming, if separately enabled, asks for an explicit permitted
recipient for that claim; it never establishes a current-child identity.

Device Task creation retries have device-owned transactional receipts, not a
fabricated human creator or a replay of a cached private response. Identical
concurrent requests create one Task. A replay rechecks current grants and scope.

Device appearance, widget layout, and Task-view preferences remain separate from
human preferences. Shared shower order appears in the normal Dashboard through
the existing Rotation presentation. The new widget defaults off for personal
layouts; a device's existing configured Rotation widget is preserved. Kitchen
navigation opens the permitted Meal view, rather than a personal recipe screen.

## Supervisor approval on the existing board

Protected incomplete learner/helper actions show **Supervisor approval** on
expanded Task cards and in Task Details. A child modal names the single action
and requests real authentication. Cancel returns to the unchanged board/details.

Approval uses the existing password verification, configured second factor, or
OIDC flow. OIDC requests fresh authentication and requires a linked existing
member; it cannot provision an account. The currently assigned qualified
supervisor/helper must authenticate. Administrator role alone does not override
the canonical skill, delegation, dependency, start-window, expiration, permission,
or revision checks. Protected required descendants cannot be bypassed by a
device's parent/bulk completion control.

The proof expires after two minutes and is bound to the device credential,
browser session, authentication context, Task and parent revisions, and one
completion action. Consuming it is transactional. It grants no personal session,
general supervisor capability, reopen/reset permission, or persistent member
selection. Concurrent consumption and retries cannot duplicate completion,
history, parent points, or recurrence effects.

The canonical mutation records the authenticated human actor plus the device
source. Responsibility and reward beneficiary remain the Task's established
learner/assignee. Ordinary permitted device checkbox actions continue without
authentication and do not claim that a household member authenticated.

**Sign in temporarily** remains separate: real administrator authentication opens
that account's normal app and preferences. The existing defaults remain 120
seconds idle and 600 seconds absolute, enforced server-side. Return, fresh launch,
expiry, permission reduction, and revocation retain the existing context/cookie,
cache, late-response, pending-write, and live-stream protections.

## Defects caught during this pass

- A suspended Task Details live update could rename a nested approval modal.
  The update now targets its own panel heading.
- SSO second-factor continuation is returned inside the approval receipt. The
  UI now reads that receipt and exposes the existing authentication-code flow.
- A late modal cancellation could cancel a newer proof. Cancellation now names
  the original approval ID and only clears matching pending authentication.
- Completion-history pagination could return an excluded member's timestamp/ID
  after scanning hidden rows. Canonical device visibility is now applied before
  the SQL page limit, including the empty authorized set. Full-payload regression
  coverage includes 1,001 hidden records and mixed visible/hidden pagination.
- The long device-configuration form left Save out of reach. It now uses the
  existing pinned modal footer, verified while changing device-only preferences.

## Persistence and migration

Additive migration **10042** creates scoped approval persistence and device Task
creation receipts. Existing 10041 and Rotation migrations 10039/10040 are unchanged.
No browser is paired or converted automatically.

Encrypted populated rehearsals pass for `10040 -> 10041 -> 10042` and
`10041 -> 10042`, including existing users, sessions, device/temporary contexts,
Tasks, supervision, rewards, documents, and Rotation relationships. Older
Rotation rehearsals also pass from 10038 and 10039 to the new final schema.
Only expected migrations apply; preexisting rows, indexes, triggers, sequences,
and migration history are preserved. Integrity is OK, foreign-key violations
are zero, and a fresh process applies no migrations on restart.

## Focused validation

Counts below describe individual suites, not a sum of overlapping reruns.
Evidence files are local ignored artifacts in `.qa/`.

| Check | Result | Evidence |
| --- | --- | --- |
| Scoped approval service and real HTTP authentication | 32/32 passed | `device-approval-cancel-final.log` |
| OIDC protocol, fresh auth, bound 2FA and superseded callback | 4/4 passed | `device-approval-oidc.log` |
| Normal API, full-payload privacy, opt-in creation and concurrent receipt workers | 11/11 passed | `device-app-final-review.log` |
| Existing device Task lifecycle | 12/12 passed | `device-tasks-final.log` |
| Existing device content projection | 7/7 passed | Agent's direct test output |
| Normal create/edit/claim with real app, pairing and backend | 3/3 passed | `device-editor-browser.log` |
| Desktop/mobile inline approval, second client, parent reward once, receipt-driven 2FA | 3/3 passed | `inline-approval-browser-final.log` |
| Existing personal Task Details and optimistic checkbox browsers | 21/21 passed | `device-human-feedback-regression.log` |
| Canonical completion/history after pagination change | 31/31 passed | `device-history-canonical.log` |
| Expiration presentation/history | 13/13 passed | `device-history-expiration-ui.log` |
| Encrypted populated device migration and fresh-process restart | 2/2 passed | `device-migration-normal-approval.log` |
| Older encrypted populated Rotation migration paths | 3/3 passed | `rotation-migration-device-normal-approval.log` |

The full normal-screen browser run passed **7/8** scenarios; its legacy Wall
conversion case hit a browser-evaluation/navigation race in the harness. That
case now enters Wall through the real Appearance control rather than competing
with navigation from an evaluated API call. A final targeted run passed **2/2**:
pairing/normal Dashboard on the final CSS and legacy Wall conversion. All eight
scenarios thus have direct passing evidence across these runs, not a claimed
single green eight-test run. The other scenarios cover permitted module screens,
rapid different-child steps, second-client convergence, mobile touch scrolling,
device-only preferences, manual temporary return/reload, server idle/maximum
expiry, revocation, and browser Back. Logs: `device-normal-browser-seven-pass.log`
and `device-normal-browser-targeted.log`.

With real mouse activation and HTTP acknowledgement deliberately held for
450 ms, pending checked SVG/DOM state was present on the second animation frame
at **29.9 ms List**, **44.0 ms Kanban**, and **51.2 ms Task Details**. Duplicate
clicks sent one mutation; the database remained unchanged until the hold was
released. Captured screenshots show pending feedback before release. These are
local browser observations, not physical tap-to-pixel measurements or a guarantee
that every frame is below 50 ms. Ordinary completion uses the existing optimistic
queue; authentication is only on the protected action's separate approval path.

The combined client/adversarial/write-lease/checkbox/service-worker/registration
gate returned **80 passes and four failures**. Three failures are the existing
test-registration guard (unreachable older scripts and unregistered older test
files), reproduced exactly using a clean HEAD archive. All new test files are
registered. The fourth is the existing Dashboard suite: its two date-window
fixture assertions fail on both candidate and unchanged HEAD, with 90 internal
assertions passing and two failing in each. These remain baseline failures;
the combined command is not claimed green. Evidence:
`device-final-integration.log`, `device-suite-chain-baseline.log`, and
`device-dashboard-baseline.log`.

Earlier browser attempts exposed test navigation/viewport and suspended-modal
timing assumptions. Harnesses now wait for the actual route, removal of the child
modal, and the restored enabled parent control. A UI test first invoked without
its required browser loader failed to import; the corrected invocation passes.
No failed launch or intermediate failed run is counted as a pass.

## Known boundaries

Physical Apolosign/Fully Kiosk hardware has not been tested. Browser emulation
and frame/DOM observations do not establish physical tap-to-pixel latency.
Actual household SSO-provider UX is untested: the protocol tests use signed
synthetic ID tokens and the real OIDC client, with only provider transport
stubbed. Local password and configured 2FA exercise real authentication paths.

No production inspection or release was part of this pass. Prior production
state is not asserted as freshly verified. No push, deployment, household points
adjustment, or conversion of a real display has occurred.

## Local handoff

**READY WITH KNOWN LIMITATIONS** for local review. The new permission and scoped
approval boundaries, actual application flows, concurrent mutations, and encrypted
migrations have direct passing evidence. Baseline Dashboard/registration failures,
physical kiosk timing, and the real household SSO-provider UX remain explicitly
separate above. The candidate is committed locally; publication and deployment
require a later release task.
