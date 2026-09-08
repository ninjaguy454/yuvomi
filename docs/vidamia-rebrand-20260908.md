# Vidamia product identity and upgrade compatibility

Vidamia is an independent household-management platform derived from the open-source Yuvomi project. The upstream MIT copyright and license notices remain intact. The optional tagline is **Life, together.**

This correction supersedes the former Ordoma product name and its radial-O logo. It continues from the completed and deployed Tasks/Cooking Map refinement at `50866278dbd9e71b53bb98f439b0e41a55965423`; that implementation is not being restarted. The deployed Meal portion behavior and schema 10029 are unchanged. No database migration, infrastructure rename, deployment or application workflow change belongs to this branding correction.

## Mark and generated assets

The selected direction follows the user's final logo correction: **two intersecting, tilted ovals**, with a restrained heart-like shape formed through their lower-center overlap. The paired geometry conveys shared lives and connection without using a literal household silhouette or a heart as the entire mark. It replaces the previous radial O and the initial typographic exploration rather than retaining a letter that no longer represents the product.

The startup treatment briefly turns one oval, slows it, then separates it into the final pair as the wordmark appears. This is a single short brand reveal, not a repeating loading indicator. It does not delay application readiness; reduced-motion users receive the static final mark. Final implementation and browser evidence are recorded with validation below.

The canonical vector source is `public/icons/vidamia-mark.svg`; `scripts/generate-icons.js` generates the matching application assets. The generated inventory includes the 192/512 application icons, 192/512 maskable icons, Apple touch icon, 16/32 PNG favicons, 16/32/48 ICO, transparent notification badge, social preview, documentation and installer marks. Shared shell ink follows the selected theme. The existing Warm/Neutral/Cool palettes, Light/Dark/System appearance, module colors and Serif option remain authoritative. No external font or runtime image service is required.

The old asset URL `public/icons/ordoma-mark.svg` remains as a compatibility alias containing byte-identical **new Vidamia geometry**. An installed page with an older cached stylesheet can still resolve that URL without displaying the old radial artwork. It is generated from the same canonical source rather than maintained separately.

The final logo compares three paired-oval proportions and uses the balanced middle composition: two 29 × 55-radius ovals tilted ±28°, with a 12-unit stroke inside a 160-square canvas. The spin and split use the existing shared `--ease-out` token. The wordmark begins revealing after the ovals settle, and the entire sequence finishes at 1.36 seconds. Neither timers nor animation-end listeners gate application readiness.

## User-facing identity

The product name is fixed to Vidamia. The login introduction is **“Your life, together.”**, translated through the existing `login.tagline` key in all 24 locales. The optional documentation/social tagline remains **“Life, together.”**. The Windows/PWA full display name is **“Vidamia — Your life, together.”**, its short name remains **Vidamia**, and its description is **“Your life, together.”**. Both served and static manifests agree, replacing the inherited German descriptor; their metadata language is English. HTML description metadata agrees as well. The removed App Name setting remains removed. Existing household names, member names and explicit administrator choices remain separate from product branding.

Application-controlled branding covers titles, shell/navigation, authentication/setup, loading/offline, install prompts, Settings, notification and email defaults, Reader, Wall Mode, API descriptions, exports, installer and current product documentation. Existing locale keys and fallback behavior are preserved; changing the product name does not create a parallel translation mechanism.

Reader remains lightweight, script-free and text-branded with its existing typography and `private, no-store` behavior. Wall Mode retains its navigation and conservative handling of personal notification contents.

## Technical identity stays stable

| Retained identifier | Reason |
| --- | --- |
| Manifest `id`, `start_url` and `scope` = `/` | Installed applications keep the same origin and application identity. Only display branding and icon pixels change. |
| `window.yuvomi`, custom elements, browser events and module hooks | Existing callers and third-party modules continue to work. |
| Existing `yuvomi-*` / `yuvomi:*` browser keys and legacy namespaces | Preferences, privacy, session and offline state remain available. The release cache advances through the existing service-worker update path. |
| Database fields, migration history, provenance, source, token and cookie identifiers | Recipes, Cooking Maps, portions, Tasks, notifications and integrations retain their identities and data. |
| Historical `OIKOS_*` and `YUVOMI_*` environment keys | Existing configuration remains valid. No cosmetic migration is introduced. |
| `C:\Yuvomi`, Docker/container/volume names, data and backup paths, Caddy and HTTPS origin | The existing production release process and rollback paths continue to work. |
| Package names, repository paths, Git remotes and upstream registry/catalog slugs | No new repository, registry or catalog release is claimed. |
| External document folders and synchronization identities | Remote folders and calendar/protocol objects are not duplicated or disconnected by a display-name change. |
| Authenticator issuer and operator-configured sender identity | Existing enrollment and explicit operator choices remain usable. Application-controlled email defaults use Vidamia. |

Historical `app_name` values remain stored but do not override the fixed product identity. The shared display helper returns Vidamia without rewriting saved settings. No notification category, delivery provider, recipient rule or notification provenance changes for branding.

## PWA upgrades

Branding updates use normal manifest revalidation, generated icon replacement and the existing service-worker update mechanism with release suffix `vidamia.2`. Manifest identity, scope, start URL and origin remain stable. No localStorage, IndexedDB, cookie, session or installed application reset is used to force the new name.

Browser and operating-system policies determine when an installed application's displayed name and icon refresh. A manifest and service-worker regression check does not establish physical-device installation behavior on every platform. Older installed labels may remain temporarily while those platforms refresh normally.

## Documentation and attribution

Current product-facing documentation identifies Vidamia. MIT notices and upstream Yuvomi attribution remain intact. Installation instructions that reference upstream images or marketplace listings are explicitly marked as upstream packaging references rather than a Vidamia distribution channel.

The [previous Tasks release report](tasks-refinement-report-20260908.md) and [former branding report](ordoma-rebrand-20260908.md) remain dated historical evidence. Their old names, screenshots and validation records are not relabeled as if they were produced by Vidamia. Other historical reports and upstream legal/operator notices retain the facts they describe.

## Branding audit and validation

`node scripts/audit-branding.mjs --json` inventories every occurrence of the previous product names in tracked and pending source files. It classifies each as compatibility, infrastructure, historical/upstream attribution, internal identifier, test fixture or unexplained user-facing branding. Unexplained visible remnants fail the guard; a historical name elsewhere on the same line must not conceal a visible label.

Focused checks cover branding defaults, locale consistency, manifest identity, icon integrity, service-worker update behavior, notification/email defaults, Reader/Wall privacy and syntax/JSON/diff checks. Browser inspection covers representative desktop/tablet/mobile contexts, all three themes, Light/Dark and Serif. Existing Tasks/Cooking Map validation is retained as baseline evidence; expensive unrelated suites do not need to be repeated solely for a label or asset replacement.

Final related validation: **1,138 / 1,138 distinct checks passed across 41 test files**, with no skips or unresolved failures. The coherent related matrix initially passed 1,137 checks; the remaining design-system check identified literal startup easing outside the shared tokens. Reusing `--ease-out` fixed that issue, and the affected frontend audit plus startup suite passed **352/352**. Those replacements are included once in the final total, not added to it.

The final installed-app subtitle correction passed **23/23** focused branding, backend manifest, PWA and precache checks. These recheck the same matrix files, preserving the 1,138 distinct-check total. The served and static manifests are compared in full, including identity, icons, subtitle, description and language; revalidation remains enabled. Static verification passed for **54 JavaScript files**, **50 JSON files** and diff whitespace.

A stronger startup test also caught an existing CSS specificity defect: `.app-loading { display: flex }` overrode the browser's hidden style. The new scoped `.app-loading[hidden] { display: none }` rule makes readiness remove the loading surface and cancel its animations immediately. Browser coverage verifies readiness during the animation at 100ms, a stable final mark after a simulated four-second load, canonical/static geometry parity, wordmark ordering, one iteration, and reduced-motion behavior including wall startup.

The icon checks validate all raster sizes, ICO entries, monochrome rendering, transparent notification badge, maskable safe-circle bounds, matching canonical/installer/startup geometry, and the byte-identical older URL alias. Every precached path exists. Worker upgrade coverage exercises the previously deployed cache generation, removes superseded assets/private Reader cache entries, and preserves shared-device privacy state. Existing authentication, notification/email delivery semantics and schema history tests pass.

The audit inventories the tracked/pending source paths and classifies every remaining historical-name occurrence; it reports **zero unexplained user-facing remnants**. Existing package, storage, deployment and compatibility identities remain intentionally unchanged. The previous name appears only in explained compatibility/history/test contexts, not the current product presentation.

Live application checks used a fresh copy of the existing synthetic QA household at `http://127.0.0.1:3101`, preserving the user's 3098 data and production. Manual browser checks covered desktop 1366×900, tablet 768×900 and mobile 390×844: login/intro and install prompt, Overview/navigation, Tasks and Task Workflows, notification center, Calendar, Kitchen/Meals, the saved Cooking Map, Appearance, Reader and wall mode. The paired mark and text fit, and the checked mobile/tablet surfaces had no document overflow. Warm Light with Serif and Neutral Dark were inspected in the live application; all six palettes and additional widths were checked in the launch rendering fixtures. Wall mode hid personal notification buttons and retained its normal navigation/exit behavior.

The launch visual record contains **24** checks using the real running application's initial document/styles with initialization scripts deliberately paused in an isolated test browser. It covers desktop/tablet/mobile, all six theme/appearance combinations on mobile, animation phases, and reduced-motion wall startup. These captures establish the visual result under a controlled slow load; they are not presented as actual household loading-time measurements. Fast and long-load behavior have separate focused tests. No final-logo blank frame, clipping, repeated spin or overflow was found in those controlled captures. The ordinary browser refreshed into the new identity without clearing preferences or application identity.

An isolated real Edge service-worker upgrade loaded the historical `ordoma.3` release assets, then updated to `vidamia.2` through the normal controller-change reload. All 13 critical asset hashes matched the final source, old release caches disappeared, the synthetic private Reader cache was purged, and shared-device privacy, theme and a stored preference sentinel survived. The browser parsed **“Vidamia — Your life, together.”** and its new description without manifest errors; identity and scope remained unchanged. The recorded transition had one document reload, no page errors and no blank frames or old branding among 106 sampled new-page frames. Sampling does not establish every compositor frame or physical Windows installed-app label-refresh timing. Before/after screenshots and detailed evidence are under `artifacts/vidamia-live-sw-upgrade/`.

Evidence remains under ignored `artifacts/vidamia-brand/` and `artifacts/vidamia-startup-qa/`: original matrix logs, focused correction logs, deduplicated final summary, branding audit, static checks, concept comparison, and the visual record. Existing 50866278 Tasks/Cooking Map/portion implementation stays intact. This correction adds **no database migration**; schema remains **10029**, with migration definitions and protected portion/grocery persistence paths unchanged. No push, merge or production deployment was performed.

## Deliberately deferred

- Infrastructure, repository/remote, registry and upstream marketplace renaming.
- Rewriting historical screenshots, commits or release evidence.
- Cosmetic changes to persistence, synchronization, enrollment or delivery identity.
- Another module layout, workflow, typography or color-system redesign.
- Forcing operating-system PWA name/icon refresh by creating a different application identity. Physical installed-PWA launch, physical touch hardware and operating-system icon-refresh timing remain untested; normal browser/fixture and service-worker checks are reported separately.
