# Vidamia Modules

Vidamia loads third-party modules from the repository-level `modules/` directory. Each module lives in its own folder and must include a `module.json` manifest. Modules are separate code: do not edit Vidamia core files to install one.

## Folder Layout

```text
modules/
  example-module/
    module.json
    index.js
    style.css
```

The folder name must match the manifest `id`.

## Manifest

```json
{
  "id": "example-module",
  "name": "Example Module",
  "version": "1.0.0",
  "description": "Adds a small page to Vidamia.",
  "entry": "index.js",
  "style": "style.css",
  "icon": "box",
  "accent": "#6366F1",
  "menu": {
    "show": true,
    "label": "Example",
    "icon": "box",
    "order": 100
  }
}
```

Required fields:

- `id`: lowercase letters, numbers and hyphens only. Must match the module folder.
- `entry`: a relative `.js` file exporting a `render(container, context)` function.

Optional fields:

- `style`: a relative `.css` file loaded only for this module page.
- `menu.show`: set to `false` if the module should not appear in the left menu.
- `menu.label`, `menu.icon`, `menu.order`: left-menu label, Lucide icon name, and order.
- `accent`: a `#RRGGBB` color. It is your module's **tone**: the app exposes it as
  `--active-module-accent` while your page is open, so your own content can use it, and it colors
  the browser/PWA status bar on your route. It also fills your module's mark wherever the app names
  your module next to others - the navigation, the settings module list - at full strength; a mark
  that names something carries its color rather than a tint of it (see the full-tone rule in
  `DESIGN.md`). Since v2.2.0 it no longer colors the app's chrome -
  the navigation, the action button and shared controls carry the app's own accent in every module
  (see the one-voice rule in `docs/SPEC.md`), so the frame does not change color when a visitor
  opens your page. Pick a tone that reads against both a light and a dark surface: the mark is
  filled with it and carries a light or dark glyph on top.

## Client Entry

```js
import { api } from '/api.js';
import { esc } from '/utils/html.js';

export async function render(container, context) {
  const me = await api.get('/auth/me');
  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <div class="page">
      <div class="page__header">
        <h1 class="page__title">Example Module</h1>
      </div>
      <section class="settings-card">
        <p>Hello, ${esc(me.user.display_name)}</p>
      </section>
    </div>
  `);
}
```

Modules may import public Vidamia browser libraries such as `/api.js`, `/i18n.js`, and utilities under `/utils/`. For calls to Vidamia's built-in REST API, prefer `import { api } from '/api.js'`: it prefixes requests with `/api/v1`, sends the current session credentials, handles CSRF tokens, and uses non-cached fetches for user data.

If a module calls a separate backend service through a reverse proxy, expose that service on a same-origin `/api/...` path whenever the response is dynamic. Vidamia's service worker deliberately bypasses `/api/` requests, while other same-origin GET requests may be handled by the app-shell caching strategy. A dynamic proxy path such as `/ext/myservice/...` can therefore return stale cached responses unless you also change the service-worker strategy.

Modules must follow the same frontend security rules as core Vidamia:

- Use `replaceChildren()` and `insertAdjacentHTML()`.
- Escape untrusted values before inserting HTML.
- Do not use external CDNs.
- Do not use `innerHTML`.
- Do not bypass authentication, authorization, CSRF, or CSP.

## Modules With A Backend Service

A module page is browser code with no server of its own. When a module needs stored state, scheduled work, or a third-party credential, run that as a separate service beside Vidamia rather than as a patch to core, and leave Vidamia on its official image. What follows is what such a module needs in order to survive a Vidamia upgrade.

Serve the service from the same origin under an `/api/` path; `/api/extensions/<module-id>/` is a reasonable convention. Browser requests then carry the Vidamia session cookie, and the service worker leaves them alone. The stale-cache trap described above applies to any dynamic path outside `/api/`.

Do not open `yuvomi.db`. It is core's private storage: the schema changes between releases without notice, and a second writer breaks Vidamia's own migrations. Read and write through `/api/v1` instead. If the data a module needs is not reachable through the API, that is a missing endpoint worth an issue, not a reason to reach for the file.

Re-check identity on the server for every request. Forward the incoming Vidamia session cookie to `GET /api/v1/auth/me` over the internal Vidamia URL, and trust only that response for the user id, role, and permissions. The browser half of a module is not a trusted caller: never accept a user id or role from a request body.

Cache that answer briefly rather than resolving it on every call. Vidamia rate-limits `/api/` to 300 requests per minute per IP, and a service that does not forward the caller's address spends that budget from its own container IP for all of its users at once - the first symptom is a `429` for everyone. A few seconds of cache keyed on the session cookie is enough, and short enough that a logout still takes effect.

Vidamia's CSRF token protects Vidamia's endpoints, not a module's. State-changing routes on the service should independently require:

- a valid Vidamia session, verified as above;
- an `Origin` matching the public host;
- the service's own double-submit CSRF cookie and header pair;
- an endpoint-specific role or ownership check.

Scheduled jobs have no session. Issue an API token under Settings -> Admin -> API Access (admin-only, so a module that needs one has to ask the household's admin for it) with only the scopes the module needs - `budget:read` and `budget:write`, for example - and keep it in the service's secrets, never in the module folder, a Compose file, or browser storage. Keep the service's own state in the service's own database, and treat stored secrets as write-only: expose `has_api_token: true`, never a fragment of the token itself.

## Loading And Failure Behavior

Vidamia scans `modules/` and validates each `module.json`. Invalid modules are shown as errored in Settings and are not loaded. Disabled modules are not served to the browser and do not appear in navigation. If a module page fails while rendering, Vidamia shows an error for that page without changing core application code.

Admins enable and disable modules in Settings -> Modules -> Active modules. Ordering is a separate, personal matter and lives in Settings -> Personal -> Navigation, where every member also decides which modules they want in their own navigation - hiding one there removes it from that member's sidebar and mobile favourites without taking it from the household. Copying a new folder into `modules/` makes it appear in both places automatically.

## Compatibility Across Vidamia Releases

`module.json` records the module's own version, not the Vidamia version it was written against, and Vidamia does not gate loading on a compatibility range. A module that calls an endpoint a later release renamed or moved therefore keeps loading and fails at the point of use, in front of the user.

Two endpoints help, though they answer at different times:

- `GET /api/v1/version` returns the running Vidamia version to any caller holding a session or an API token. Without a credential the response still describes the instance, but omits the version.
- `GET /api/v1/openapi.json` describes the operations that version actually serves. It is admin-only, so treat it as a check you run while developing and against a new release before shipping, not as something every module instance can call at startup.

Compare the operations the module requires - method, path, and the response fields it reads - against that document while building, and again when a Vidamia release moves. At runtime, where the document is usually out of reach, watch the version instead and read the failure: a `404` or `405` on an endpoint that worked before means the operation moved, and that is the point to degrade rather than retry. Three outcomes cover the realistic cases: run normally; keep stored data, review and export readable while blocking writes; or show a dependency error with a retry control. Refusing a write is better than issuing it against an endpoint whose meaning has changed.

Third-party modules should build on `/api/v1` and the public browser libraries described above; breaking changes to those are called out in the CHANGELOG. Direct database access, private helpers under `server/`, and undocumented response fields sit outside that line and may change in any release without notice.

## Docker / Podman

The default `docker-compose.yml` mounts `${MODULES_DIR:-./modules}` to `/app/modules`. To keep modules outside the Vidamia checkout, set `MODULES_DIR=/absolute/path/to/yuvomi-modules` in `.env` and restart the compose service. New or changed module folders are scanned at runtime; rebuilding the image is not required.

On Podman (RHEL/Fedora/CentOS Stream) use `podman-compose.yml` instead — it mounts the same `/app/modules` path with the SELinux `:Z` relabel so the rootless container can read your modules.

On Portainer the stack mounts a named volume (`oikos_modules`) at `/app/modules`, since a Portainer deployment has no repository checkout to bind-mount from. Copy module folders into that volume (for example via `docker cp` into the running container, or a temporary container mounting the volume); a bind mount to a host path works too if you edit the stack.
