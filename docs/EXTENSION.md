# Extension

The full guide lives next to the code: [apps/extension/README.md](../apps/extension/README.md). It covers build and install for Chrome and Edge, why each permission is needed, the adapter/supported-page matrix, recovery behaviour, packaging, and the store-submission checklist.

## Summary
* Manifest V3; permissions: `activeTab`, `scripting`, `storage`, `alarms`, `sidePanel`; one host permission (the API origin); no static content scripts; `externally_connectable` limited to the dashboard origin. The dev ID `bjhbbpnbmichlooillmiaeofcioofkni` is pinned by the public key in `apps/extension/manifest-key.json`; the private key `dev-key.pem` is gitignored.
* Sign-in: open the dashboard → Settings → *Connect browser extension* (`/extension/connect`). The page hands an extension-scoped refresh token to the extension via `chrome.runtime.sendMessage`; the service worker rotates it on every refresh.
* Capture runs only when you click it, and only in the active tab. It prefers JSON-LD `JobPosting`, then site adapters, then readable text. Listing pages with several jobs ask you to select one or paste text. Password, hidden and form-field values are never read.
* Builds: `npm run build -w apps/extension` → `apps/extension/dist` (load unpacked). `npm run build:release` + `npm run package` → `apps/extension/release/elevate-extension-<version>.zip`. For release, set `ELEVATE_EXT_API_URL` / `ELEVATE_EXT_WEB_URL` to https origins.

## Using it
* **One click:** on a job page press **Analyze this job** (or **Alt+Shift+E** to open Elevate). A clean single-job page is sent straight for analysis; pages that need attention (several jobs, too little text, a text selection) open the review screen. **Review text first** always shows it.
* **Result:** job summary, a **How you fit** card against your default resume (must-have / nice-to-have coverage, gaps to work on), every requirement tagged *On your resume / Partly shown / Not on your resume / Check yourself*, and next steps (full report, interview practice, prep plan, save, application status).
* **Design:** Geist (SIL OFL 1.1) is bundled in the package as `fonts/geist.woff2`; no remote fonts or scripts are loaded. Visual preview without Chrome: build, serve `apps/extension` over HTTP and open `test/harness/preview.html` (`?screen=main`, `?resume=0`).

## Verification status
| Check | Result |
|---|---|
| typecheck, 103 unit/flow tests (happy-dom, mocked `chrome.*`; includes one-click and review paths), build, manifest/bundle validation, release zip | **passed** |
| Edge runtime; badges/alarms after service-worker restart | not yet verified |
| Load unpacked in Chrome + account connect | **done by the user** (2026-10-13): loaded, connected, popup works |
| LinkedIn live job page (2026-10-13) | First attempt **failed** (35 chars). Causes: the description sits inside `display: contents` wrappers that `checkVisibility()` reports as invisible, and the page has no `<h1>`. Fixed: visibility now uses each element's own computed style; a description-heading strategy ("About the job") picks the section; LinkedIn title/company come from the tab title. Changed logic verified on the live page (3,384 chars, correct title/company); regression fixture `linkedin-2026-contents.html`. Full re-test through the popup pending reload. Note: LinkedIn renders the description lazily, so it must be visible on screen before capture |
| Indeed / Naukri / Greenhouse / Lever on live pages | not verified |

## Downloadable build for the hosted site

The dashboard's **Browser extension** page offers `apps/web/public/downloads/elevate-extension.zip`:
a build that talks to the hosted API but keeps the public dev `key`, so an unpacked install has the
fixed ID `bjhbbpnbmichlooillmiaeofcioofkni` that the dashboard connects to. Rebuild it whenever the
extension or the hosted URLs change, then commit the zip:

```bash
ELEVATE_EXT_API_URL=https://elevate-api-zwoc.onrender.com ELEVATE_EXT_WEB_URL=https://elevate-web-2z8t.onrender.com \
  npm run build:hosted -w apps/extension
npm run package:hosted -w apps/extension
```

The API must list that ID in `ELEVATE_EXTENSION_IDS`.
