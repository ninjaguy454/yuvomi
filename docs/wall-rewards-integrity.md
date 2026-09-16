# Wall dashboard and reward integrity

This refinement keeps the existing Task lifecycle, linked supervision, helper ownership, permissions and Rewards ledger. It adds a protected interactive Wall projection and durable reward provenance. No deployment or production data correction is part of this change.

## Completion and points

- A rewardable Task occurrence claims `reward_task_awards.task_id` once, transactionally with its recipient ledger rows. The first recipient set is frozen. Reassignment, repeated completion, concurrent requests, reopening and helper callbacks cannot issue a second award for that occurrence.
- Recurring occurrences have separate Task IDs and remain independently rewardable. Reopening preserves the original earn rows; corrections use an explicit reasoned ledger adjustment.
- Completion of a recurring occurrence is blocked before its **explicit start date**, evaluated in the household time zone. This covers source actions, parent bulk completion and mapped helper actions through the canonical lifecycle. An absent start date is not inferred from its due date. The policy for future nonrecurring Tasks is unchanged.
- Helper containers/counterparts do not earn the learner's parent reward. Existing attribution for explicit point-bearing delegated source actions is retained.
- Historical Activity completion/reopen events remain. The older `task_completions` current-completion feed retains its existing reopen behavior; it is not a new append-only history store.

Redemption requires an `Idempotency-Key` header or matching `request_id`. Identical retries replay the original result indefinitely; conflicting reuse returns 409 and missing keys return 428. The balance check, redemption, deduction and request record share one immediate transaction. Decisions/refunds are atomic and repeated cancellation cannot refund twice. Clients retain uncertain request IDs across retries and reloads; an in-memory fallback protects same-document retries when browser storage is unavailable. A new key means a new intentional redemption.

## Wall architecture and setup

Enable Wall Mode from personal Appearance settings. Wall settings require administrator verification. The configuration is household-wide but independent of personal Dashboard layouts, stored in existing `sync_config` under `wall_dashboard_v1`.

The frontend reuses existing Dashboard renderers with explicit `/api/v1/wall/*` projections. Ordinary module links and private create actions are removed. Available widgets are Calendar/upcoming events, active Tasks, today's selected household Meals, Shopping, presence, points, Rewards, pinned household Notes/announcements and existing household weather. Presence/points/Notes are opt-in. Weather requires an existing household location/provider.

Settings include widget visibility, order, small/medium/large size, layout reset, comfortable/compact density, Warm/Neutral/Cool, Light/Dark/System, default/Serif headings, clock/date, read-only/interactive mode, allowed actions and hidden/generic/count notifications. Natural-height grid rows fill gaps beside taller widgets. Reordering uses labeled up/down controls rather than touch dragging. Widget scroll state survives data refresh.

Safe detail views are available for shared Tasks, Calendar items, selected Meals, Shopping, Rewards and enabled pinned Notes. Interactive actions currently supported are Task completion, Task claim and Reward redemption. Nested Task completion explicitly confirms remaining steps. Meals and Shopping are read-only; there is no second participation/edit model.

## Identity and privacy

- The session owner supplies the maximum module access the device can expose. Every mutation additionally requires a freshly verified household member and that member's canonical capabilities.
- Existing password and two-factor authentication verify identity. An opaque proof is bound to the host session/current credentials, lasts at most two minutes and is held only in page memory. Done, hiding the page, expiry, password changes, logout and server restart invalidate or discard it.
- A pending action retains its original verified actor. Changing identity while a revision read or confirmation is pending cancels the action instead of borrowing another member's proof.
- Configuration and exiting to a personal view require a verified administrator and the host's administrator ceiling. Sign out is available without revealing the host's private account.
- While Wall is active, a persisted server session lock rejects ordinary private APIs and Reader, including alternate routes. Only Wall endpoints, minimal identity/version/logout and payload-free Task/Rewards streams remain accessible.
- Personal-to-Wall entry closes overlays, clears private caches and replaces the document once, even during a pending navigation. Established Wall documents do not reload during live refresh. Stale session writes cannot undo the lock. Service-worker privacy state survives restart/update; delayed writes and storage quota failure cannot restore private API cache access.
- Task visibility must be household-public through its ancestry; host ownership does not make private Tasks public. Private Calendar sources remain private even if an imported row says household-visible. Personal/unpublished Meals are excluded. Canonical mutation errors are sanitized so private dependencies and sibling skills are not exposed.

Current Vidamia has no separate member PIN model. Password-disabled/SSO-only members need their personal device for protected actions. Fully Kiosk remains responsible for Android brightness, sleep, launch and kiosk lockdown. Personal photo screensavers do not run on the shared Wall.

## Reusable emoji picker

`openEmojiPicker` in `public/components/emoji-picker.js` returns an actual Unicode sequence for the existing icon field. The reproducible bundled dataset contains all 3,944 Unicode Emoji 17 fully-qualified RGI sequences: 1,914 primary tiles and 2,030 secondary variants. English plus 16 CLDR locale packs provide names, keywords and categories. Search supports partial/multiple words, ranking names before keywords. Recent choices are scoped to the member.

Only visible rows plus one overscan row are rendered. Categories, touch selection, hold/Shift+F10 variants and keyboard navigation do not depend on an OS emoji keyboard. Metadata is precached with application assets; search makes no remote request. Dataset sources, hashes, licenses and regeneration steps are in `public/data/emoji/README.md`. Rendering newer glyphs still depends on the device font.

## Schema and compatibility

Additive migration **10034** adds occurrence receipts, durable redemption request records, a guard against new duplicate deduction/refund ledger rows and the Rewards invalidation clock/triggers. Existing award receipts are seeded from existing earn rows without changing amounts, people or timestamps. No Wall/emoji database model is added. Historical earns previously erased by old reopen behavior are not fabricated.

Older redemption clients without request IDs must refresh/update. Plain unstructured CalDAV VTODO status imports retain their existing no-award behavior; structured Task imports use the canonical lifecycle.

## Validation and known limits

Focused checks cover independent SQLite writer concurrency, HTTP retries, recurrence/reopen behavior, household midnight/DST, production-shaped 10033→10034 upgrade/restart, restricted users, private dependencies, actor expiry, stale session saves, service-worker updates and privacy races. Browser fixtures use real application renderers and disposable databases, plus actual Task SSE across two clients/network recovery and real-router cross-tab privacy entry.

Browser targets include 390/412px mobile, tablet portrait/landscape and 1920×1080/2560×1440 walls, representative palettes/themes and Serif. Testing uses Chromium 146 with touch events and Android WebView/Fully-shaped user-agent settings. This is not physical Android WebView, Fully Kiosk, Safari or Apolosign testing.

Final validation passed 362 focused checks: 248 backend, 92 frontend/SW/router/metadata and 22 actual browser scenarios. Two old Dashboard date-cutoff assertions were separately reproduced unchanged on the baseline (90 passed, 2 failed); they remain documented failures rather than passes.

Emoji search input-to-DOM was 0.5–2.0 ms in the final run, with at most 144 tiles. At 4× CPU throttling, first unseen People glyphs took approximately 586 ms to paint versus 50 ms for the same warm scroll (earlier cold samples reached 649 ms). Actual Android font and physical keyboard/scroll performance remain device acceptance checks. New Wall/picker control labels are English; searchable emoji metadata is localized.

The tested Chromium compositor retained a translucent entrance frame over the Wall backdrop even after the dialog animation finished. Wall dialogs therefore paint directly without that entrance animation; ordinary module dialogs retain their existing behavior.
