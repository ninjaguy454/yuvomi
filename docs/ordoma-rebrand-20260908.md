# Ordoma product identity and upgrade compatibility

Ordoma is an independent household-management platform derived from the open-source Yuvomi project. The upstream MIT copyright and license notices remain intact. This is a product identity change in the current Tasks refinement pass, without a repository rename, infrastructure rename, deployment, or branding migration.

## Mark

The selected **radial O** uses 24 evenly spaced strokes around a strong circular opening. The repeated strokes suggest arrangement and household rhythms while the empty center keeps the letter recognizable without the wordmark. Eighteen-, twenty-four- and twenty-eight-stroke variants were compared at application and favicon sizes. The selected mark has equal horizontal and vertical radii following the user's correction of the first oval version. It does not rotate, pulse or fade like a loading spinner.

The canonical source is `public/icons/ordoma-mark.svg`. The existing `scripts/generate-icons.js` derives application assets from it: 192/512 application icons, 192/512 maskable icons, Apple touch icon, 16/32 PNG favicons, a 16/32/48 ICO, a transparent notification badge, and documentation/installer marks. The social preview uses the radial O as the first letter of Ordoma. The shell uses a monochrome version with theme-controlled ink; application tiles use a fixed contrasting background and foreground. No remote fonts or image service is required. The existing Warm, Neutral and Cool palettes, appearance modes, module accents and Serif option remain authoritative.

The later approved control-color refinement extends the shared theme tokens: selected options and primary actions use graphite in Neutral, bronze in Warm and slate blue in Cool. Light/Dark variants include hover, tinted surfaces and focus roles; module and semantic colors retain their independent meaning. This changes the universal purple interaction accent without adding another setting or altering theme persistence.

## Technical identity stays stable

| Retained identifier | Reason |
| --- | --- |
| Manifest `id`, `start_url` and `scope` = `/` | Existing installed applications retain the same origin and application identity. Only display branding and icon pixels change. |
| `window.yuvomi`, custom element names, browser events and module hooks | Internal callers and third-party modules continue to work. |
| `yuvomi-*` / `yuvomi:*` storage, cache, privacy, preference and session keys | Existing browser state stays available. The release cache version advances through the existing update mechanism. |
| Database, migration, source/provenance, token and cookie identifiers | Recipes, Cooking Maps, portions, notifications, Tasks and integrations retain their existing identities. |
| Historical `OIKOS_*` and `YUVOMI_*` environment keys | Existing installation and deployment configuration remains valid. |
| `C:\Yuvomi`, database paths, Docker names/volumes, backups, Caddy and HTTPS origin | No production or operational identity is renamed in this pass. |
| Package name, repository paths, Git remotes and upstream registry/catalog slugs | No new registry or catalog release is claimed. Repository renaming is separate work. |
| Existing external document folders and synchronization identities | Google Drive/WebDAV folders, calendar identifiers and protocol provenance must not be duplicated or disconnected by a cosmetic rename. |
| Authenticator issuer and explicit administrator-configured email sender names | Existing enrollment and email operator choices remain recognizable and usable. Application-controlled sender defaults use Ordoma. |

Following the user's additional decision, **App Name** is removed from Settings and the application identity is fixed to Ordoma. Historical `app_name` values remain stored but no longer control the visible product name. This does not affect household member names or configured email sender identities. The rebrand does not rewrite saved data or require a database migration; migration 10029 belongs exclusively to the approved Task skills/template refinement. Migration 10028 and Meal portion semantics remain baseline behavior.

## Attribution and documentation

Current product-facing descriptions identify Ordoma. Historical release reports, upstream changes, third-party notices and MIT attribution preserve the names that were true at the time. Instructions naming an upstream image or marketplace entry are labeled as upstream packaging references; they are not represented as a published Ordoma release. Existing upstream legal notices are labeled as such rather than claiming an upstream operator runs this independent fork.

## Audit and validation

`node scripts/audit-branding.mjs --json` inventories every remaining historical-name occurrence in versioned and pending source files. Each is categorized as compatibility, infrastructure, historical/upstream attribution, internal identifier, test fixture, or an unexplained user-facing remnant. The automated guard rejects unexplained remnants. The report is an aid to source review, not a demand to delete compatibility or attribution.

PWA branding is delivered through normal manifest revalidation, replacement icon assets and the existing service-worker release update. Installed-app operating systems choose when to refresh their displayed name and icon; the application does not create a second installation to force that refresh. No physical installed-device upgrade is claimed solely from manifest/static tests.

Final asset inventory, test counts and browser results are recorded with the complete pass in `tasks-refinement-report-20260908.md` and its retained local QA artifacts.

## Deliberately deferred

- Renaming infrastructure, repository/remotes, registry packages or upstream marketplace listings.
- Rewriting historical screenshots and release evidence as if they were produced by Ordoma.
- Changing synchronization, storage, enrollment or delivery identity for cosmetic consistency.
- A separate typography, layout or color-system redesign.
