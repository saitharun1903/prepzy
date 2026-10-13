# Extension

The full guide lives next to the code: [apps/extension/README.md](../apps/extension/README.md). It covers build and install for Chrome and Edge, why each permission is needed, the adapter/supported-page matrix, recovery behaviour, packaging, and the store-submission checklist.

## Summary
* Manifest V3; permissions: `activeTab`, `scripting`, `storage`, `alarms`, `sidePanel`; one host permission (the API origin); no static content scripts; `externally_connectable` limited to the dashboard origin. The dev ID `bjhbbpnbmichlooillmiaeofcioofkni` is pinned by the public key in `apps/extension/manifest-key.json`; the private key `dev-key.pem` is gitignored.
* Sign-in: open the dashboard → Settings → *Connect browser extension* (`/extension/connect`). The page hands an extension-scoped refresh token to the extension via `chrome.runtime.sendMessage`; the service worker rotates it on every refresh.
* Capture runs only when you click it, and only in the active tab. It prefers JSON-LD `JobPosting`, then site adapters, then readable text. Listing pages with several jobs ask you to select one or paste text. Password, hidden and form-field values are never read.
* Builds: `npm run build -w apps/extension` → `apps/extension/dist` (load unpacked). `npm run build:release` + `npm run package` → `apps/extension/release/elevate-extension-<version>.zip`. For release, set `ELEVATE_EXT_API_URL` / `ELEVATE_EXT_WEB_URL` to https origins.

## Verification status
| Check | Result |
|---|---|
| typecheck, 101 unit/flow tests (happy-dom, mocked `chrome.*`), build, manifest/bundle validation, release zip | **passed** (re-run independently) |
| Load unpacked in Chrome 154 / Edge 155 on this machine | **not run**. Requires enabling Developer Mode in the browser; a manual step for the user |
| Live connect handshake, executeScript on real pages, badges/alarms after SW restart | not run (depends on the above) |
| Load unpacked in Chrome + account connect | **done by the user** (2026-10-13): loaded, connected, popup works |
| LinkedIn live job page (2026-10-13) | First attempt **failed** (35 chars). Causes: the description sits inside `display: contents` wrappers that `checkVisibility()` reports as invisible, and the page has no `<h1>`. Fixed: visibility now uses each element's own computed style; a description-heading strategy ("About the job") picks the section; LinkedIn title/company come from the tab title. Changed logic verified on the live page (3,384 chars, correct title/company); regression fixture `linkedin-2026-contents.html`. Full re-test through the popup pending reload. Note: LinkedIn renders the description lazily, so it must be visible on screen before capture |
| Indeed / Naukri / Greenhouse / Lever on live pages | not verified |
