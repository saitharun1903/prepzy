# Elevate browser extension (Chrome / Edge, Manifest V3)

Captures a job posting from the current tab **only when you click**, sends it to your Elevate
account (`POST /api/v1/jobs/capture`), tracks the server-side analysis, and lets you save the job,
add notes and reminders, and set an application status. Plain TypeScript + a tiny DOM helper,
bundled with esbuild — no framework, no remote code.

```
src/
  config.ts                 build-time API / web URLs (esbuild define)
  background/sw.ts          service worker: message routing, extraction, capture, applications
  background/api.ts         the ONLY code that calls the API: auth, refresh rotation, retries
  background/captures.ts    capture records, restart recovery, polling, badge, alarms
  background/storage.ts     storage layout, access level, account-data wipe
  shared/extract.ts         injected extraction function + result validator
  shared/state.ts           capture state machine (pure)
  shared/messages.ts        typed, versioned messages + validators (pure)
  shared/jobview.ts         validated views of API responses (pure)
  shared/url.ts             URL normalisation / page classification (pure)
  ui/                       popup + side panel (same app), CSS, HTML
scripts/                    build, validate, package, PNG icon encoder
test/                       vitest suites + authored fictional HTML fixtures
```

## Build

From the repository root (npm workspaces):

```bash
npm install
npm run typecheck -w apps/extension   # src (chrome types) + tests (chrome + node types)
npm run test -w apps/extension        # vitest (node + happy-dom)
npm run build -w apps/extension       # dev build -> apps/extension/dist
npm run validate -w apps/extension    # manifest / permission / bundle checks (dist, and dist-release if built)
npm run build:release -w apps/extension
npm run package -w apps/extension     # -> apps/extension/release/elevate-extension-<version>.zip
```

| Build | Output | Manifest `key` | API / web URLs |
|---|---|---|---|
| `build` (dev) | `dist/` | yes — public key from `manifest-key.json`, so the ID is `bjhbbpnbmichlooillmiaeofcioofkni` | `http://127.0.0.1:8000`, `http://localhost:3000` |
| `build:release` | `dist-release/` | **no** (the store assigns the ID) | `ELEVATE_EXT_API_URL`, `ELEVATE_EXT_WEB_URL` (origins only); optional extra connect origins in `ELEVATE_EXT_CONNECT_ORIGINS` (comma-separated). Falls back to the dev URLs with a warning if unset. |

The version comes from `package.json`. `dev-key.pem` (the private key) is never read by the build,
never bundled, and the validator fails if any key material appears in an output directory.

The API must allow the extension origin for CORS only if you call it from pages; the service worker
is exempt through `host_permissions`. For the dev ID, set `ELEVATE_EXTENSION_IDS=bjhbbpnbmichlooillmiaeofcioofkni`
in the API environment as documented in `.env.example`.

## Install (unpacked, development)

**Chrome:** open `chrome://extensions` → enable **Developer mode** → **Load unpacked** → choose
`apps/extension/dist`. The ID shown must be `bjhbbpnbmichlooillmiaeofcioofkni`.

**Edge:** open `edge://extensions` → enable **Developer mode** → **Load unpacked** → choose
`apps/extension/dist`. Edge uses the same `key`, so the ID is the same.

After rebuilding, press the reload button on the extension card.

### Connecting your account

1. Run the API (`http://127.0.0.1:8000`) and the web app (`http://localhost:3000`).
2. Click the Elevate toolbar button → **Open the connect page** (opens `http://localhost:3000/extension/connect`).
3. Sign in on the web app and approve. The page calls
   `chrome.runtime.sendMessage("<extension id>", { type: "elevate.connect.v1", refresh_token })`.
4. The extension accepts this **only** from `http://localhost:3000` (exact origin; release builds use
   the configured web origin), validates the token shape (string, 20–200 URL-safe chars), exchanges it
   with `POST /api/v1/auth/refresh`, stores the **rotated** refresh token, and answers `{ ok: true, email }`.

## Permissions

| Permission | Why |
|---|---|
| `activeTab` | Read the current tab only after you click the toolbar button. No access to other tabs or sites. |
| `scripting` | Inject the extraction function into that tab (`chrome.scripting.executeScript({ func })`, main frame only). No content scripts are declared. |
| `storage` | Refresh token and capture records (`storage.local`), access token and per-session state (`storage.session`). |
| `alarms` | Resume tracking an analysis after the service worker or browser restarts (every 30 s, the MV3 minimum, only while something is running). |
| `sidePanel` | Optional side-panel view of the same UI. |
| host permission `<API origin>/*` | The service worker calls the Elevate API. No other host is reachable. |
| `externally_connectable` (`http://localhost:3000/*`) | Lets the Elevate web app hand over a session on the connect page. Nothing else is accepted externally. |

CSP for extension pages: `script-src 'self'; object-src 'self'`. No `eval`, no remote scripts or
styles, no `innerHTML` (all text is set with `textContent`); `npm run validate` checks this.

## Security model

* **Single API client.** Only the service worker talks to the API. Popup/side panel send typed,
  versioned messages (`{ v: 1, type, ... }`) that are validated field-by-field (types, lengths, UUIDs,
  dates). Messages are accepted only when `sender.id === chrome.runtime.id` and `sender.url` is one of
  this extension's pages — messages from content scripts or web pages are dropped.
* **Backend host is build-time configuration.** Paths are composed in the worker from validated ids;
  pages cannot pick hosts or headers. Requests use `credentials: "omit"` and `redirect: "error"`.
* **Tokens.** Refresh token in `storage.local`, access token + expiry in `storage.session`.
  `setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })` is applied defensively to both areas.
  *Residual risk:* `storage.local` is readable by content scripts of this extension; the only content
  script is our own injected function (it never touches storage), but a compromised renderer process
  for a page you explicitly granted could in principle reach it. The refresh token is
  scoped to the extension client and revocable from the dashboard ("log out everywhere").
* **Refresh rotation.** Every refresh returns a new refresh token, which is persisted before use.
  Refreshes are single-flight (concurrent callers share one request). If the worker dies mid-refresh
  and a consumed token is presented later, the server answers `refresh_reused` (and revokes the
  family); the extension then signs out cleanly and asks you to reconnect. A `401 token_expired`
  (or `invalid_token`) on any call triggers one refresh and one retry.
* **Logout** calls `POST /api/v1/auth/logout` (best effort when offline) and then clears **all**
  account-bound data: tokens, capture records and their mirror, cached lookups, page extractions,
  drafts, badges and the polling alarm. Connecting a different account does the same.
* **Never in URLs.** "Open in dashboard" opens `<web>/jobs/<uuid>` — no tokens or page data in URLs.

## Extraction

Injected on click into the active tab (frame 0) as a self-contained function (a test rebuilds it from
its source text and from an esbuild-minified bundle to prove it has no closures).

1. Records `location.href`, `document.title`, `readyState`, timestamp. At submit time the worker
   checks the tab's **current** URL (normalised) still equals the extracted page's URL.
2. JSON-LD `<script type="application/ld+json">` is parsed (`@graph`, arrays, `ItemList`,
   `mainEntity`); `JobPosting` objects are counted. Exactly one → its description (HTML stripped,
   inert `DOMParser`, scripts removed) is preferred and a **whitelisted subset** is sent as
   `structured` (untrusted claims). More than one → *multiple jobs*: whole-page analysis is blocked;
   select one job's text on the page (then **Read again**) or paste it.
3. Site adapters (best effort), then generic readable text (`main`/`article`/`[role=main]`, else the
   largest paragraph/list block), excluding `nav/header/footer/aside/script/style/form`, inputs,
   textareas, selects, buttons, password/hidden fields, `[hidden]`, `aria-hidden`, invisible
   elements, contenteditable regions and cookie/consent banners.
4. Text is bounded to 60,000 characters; under 200 characters → "needs manual text".
5. A page selection longer than 200 characters is offered as **Selected text** (serialised with the
   same safe walker, so form values never leak through a selection).
6. Up to 3 attempts, 700 ms apart, while the text is still too short (SPA loading).
7. Never read: input/textarea/select values, password or hidden fields, cookies,
   `localStorage`/`sessionStorage`. The worker validates the result's shape and sizes before use.

Restricted pages (`chrome://`, `edge://`, `about:`, other extensions, the Chrome Web Store / Edge
Add-ons, local files, PDFs in the built-in viewer) show a clear message with a **Paste job text** fallback.

### Supported-page matrix

| Source | Status |
|---|---|
| Any page with one JSON-LD `JobPosting` (incl. `@graph`) | Fixture-tested (`test/fixtures/jsonld-posting.html`) |
| Listing page with several `JobPosting`s → selection required | Fixture-tested (`listing-two-postings.html`) |
| Plain article/blog-style posting (generic text) | Fixture-tested (`article-posting.html`) |
| Page with forms, password/hidden inputs, hidden/editable content | Fixture-tested: nothing sensitive captured (`sensitive-form.html`) |
| SPA content appearing after load (retry) | Unit-tested in happy-dom |
| LinkedIn job view (`.jobs-description`, `.job-details-jobs-unified-top-card…`) | Adapter unit-tested on synthetic markup; **unverified live** |
| Indeed (`#jobDescriptionText`) | **Unverified live** |
| Naukri (`.styles_JDC__dang-inner-html`, `.job-desc`) | **Unverified live** |
| Greenhouse (`#content`, `.job__description`) | **Unverified live** |
| Lever (`.posting-page`, `[data-qa=job-description]`) | **Unverified live** |

Site markup changes often; when an adapter misses, the generic fallback or selection/paste still works.

## Capture lifecycle and recovery

States (pure module `shared/state.ts`, transitions unit-tested): `idle → extracting → validating`
(editable preview) `→ queued → analyzing → partial-result | completed | failed | timed-out`, plus
`cancellation-requested → cancelled` (the server may still finish; that is shown honestly) and
`failed | timed-out → queued` (server-side retry). Only real backend `state`/`stage` values are shown —
no invented percentages.

* **Records** `{captureId, operationId, jobId, tabId, url, accountId, state, stage, startedAt, updatedAt, …}`
  live in `storage.session`, with a minimal mirror in `storage.local` for browser restarts. After a
  restart (session storage empty) records are restored from the mirror **without a tab id** (tab ids
  are not stable) and appear only under "Recent captures", never as the current page's result.
* **Current page only.** The popup/side panel shows a record only if tab id **and** normalised URL
  **and** account match. Switching tabs or navigating reloads the view.
* **Stale responses.** Every poll is stamped with a strictly increasing issue time; a response older
  than the last applied one, for another operation, or implying an illegal transition (e.g. a late
  `running` after `succeeded`) is ignored. The UI also discards replies for an older tab context.
* **Polling.** The open UI polls with 1 → 2 → 4 → 5 s backoff; `chrome.alarms` polls every 30 s in the
  worker so tracking survives the worker being stopped or the browser restarting. Concurrent polls of
  the same capture are deduplicated. The toolbar badge on the originating tab shows `…` while running,
  `✓` when done, `!` on failure/timeout/cancel.
* **Connection loss ≠ failure.** A network error marks the record "Connection lost — still processing
  on the server?" with a **Check again** button; the state is unchanged.
* **Idempotency.** Each capture has a UUID used as the `Idempotency-Key`; resubmitting the same
  capture does not create a second operation. A `200 reused_analysis` response completes immediately.

## UI

Popup (380×560) and side panel share one app. Screens: signed-out (connect explanation + button),
current page (lookup "Already in your jobs", Analyze, Paste text), preview/edit (title, company,
location, adapter, JSON-LD found, first 600 characters + count, page/selection/manual source, save
checkbox), progress (server stage, attempt, cancel, connection-lost refresh), result (title / company /
location with "Not stated", required vs preferred vs unstated requirements with alternatives as
"A or B", warnings, partial/stale notices, model + prompt/schema version, analysis history link) and
actions (save/unsave, open dashboard, note, reminder with date/time pickers, application status
Planned/Applied, retry on failure). Errors show the message and `request_id`.
Light/dark via `prefers-color-scheme`, visible focus rings, an `aria-live` status region, keyboard
operable controls, `prefers-reduced-motion` respected.

## Verification status

Automated (this repo): typecheck, 100+ vitest tests (pure modules, extraction against fixtures in
happy-dom, service worker against mocked `chrome.*`/`fetch`, popup flow against a scripted worker),
build, validate, release build and package (zip self-verified and readable by `tar`/Python).

**Not verified by automation:** loading the unpacked extension in real Chrome/Edge, the connect
handshake with the running web app, `executeScript`/`activeTab` behaviour (including the side panel,
which needs the toolbar button to be clicked on a tab to grant access), badges/alarms in a real
browser, and every site adapter on live sites.

## Store submission checklist (preparation only)

- [ ] Set `ELEVATE_EXT_API_URL` / `ELEVATE_EXT_WEB_URL` to the production **https** origins; rebuild with `npm run build:release`; `npm run validate` must show no warnings.
- [ ] Add the store-assigned extension ID to the API's `ELEVATE_EXTENSION_IDS` and to the web app's connect page configuration.
- [ ] Bump `version` in `package.json`; `npm run package` → upload `release/elevate-extension-<version>.zip`.
- [ ] Privacy disclosures: data collected only on user action (page text, URL, title, JSON-LD JobPosting subset); sent only to the Elevate API; no sale/transfer; no remote code.
- [ ] Permission justifications: copy the table above.
- [ ] Single-purpose description: "Capture job postings you choose and analyse them in your Elevate account."
- [ ] Screenshots (1280×800) of popup states, 128×128 icon (generated), promo tile if required.
- [ ] Test the packaged build unpacked in Chrome and Edge against staging before submitting.
- [ ] Edge Add-ons: same zip; complete Partner Center listing and privacy policy URL.
