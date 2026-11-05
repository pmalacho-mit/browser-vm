# Browser VM Network Bridge

An optional Chrome extension (Manifest V3) that lets the VM reach sites that
refuse browser requests (no CORS headers), such as `git clone` from github.com.
The user approves each site. Without the extension, the VM can still reach every
site that allows CORS, which covers most package registries.

The main README has the security model under "Optional: the network bridge
extension". This file covers the code.

## How it fits in

The extension never talks to the VM or the IDE. Only the network gate
(`web/gate/`) uses it, and only after the gate has applied its own network
policy and substituted secrets:

```
gate (web/gate/gate.ts): fetch() fails with a CORS error, method is GET or HEAD
  → window.postMessage  ─► content.js   (injected by Chrome only into the gate's origin)
  → runtime port "vm-net" ─► background.js (service worker)
  → policy.js refuse() + "is this host approved?" (chrome.permissions)
  → fetch(url, { credentials: "omit" }) with the extension's host permission
  ← { head } { chunk (base64) }… { end } or { error: { code, message } }, back the same way
```

| File | Role |
|---|---|
| `manifest.json` | No host permissions at install. `https://*/*` is *optional*, granted one site at a time. `content_scripts.matches` names the gate's origin. |
| `content.js` | Relays `window.postMessage` ↔ the background worker. Ignores messages from other windows and origins. |
| `background.js` | Does the fetch for approved hosts. Checks the sender's origin, refuses local and non-HTTPS URLs, and discards a response that redirected to an unapproved host. Unapproved hosts go on a "waiting" list (badge count). |
| `policy.js` | `APP_ORIGINS` (who may connect) and `refuse()`: no IPs, `localhost`, local-network names, non-443 ports or `http:`. Shared by the background worker and the popup. |
| `popup.html`, `popup.js` | The toolbar popup: lists waiting and allowed sites. *Allow* calls `chrome.permissions.request()`, which shows Chrome's own dialog and needs a click in the extension's UI, so a web page can't grant itself access. *Revoke* removes the permission. |

## Load it for development

1. `chrome://extensions` → turn on *Developer mode* → *Load unpacked* → pick this folder.
2. Start the IDE (`npm run dev` or `npm start`) and open it at `http://localhost:8080`.
3. In the VM, request a site that refuses CORS. The extension's badge shows a
   count; open its popup and click *Allow*.

After editing a file here, click the reload icon on the extension's card in
`chrome://extensions`. Chrome doesn't pick up changes on its own.

## Configure it for a deployment

The gate's origin is hardcoded in **two places that must agree**. Both currently
say `gate.localhost` (local development):

- `APP_ORIGINS` in `policy.js`: the exact origin, including the port
  (`http://gate.localhost:8080`, or `https://gate.example.com`).
- `content_scripts[0].matches` in `manifest.json`: a match pattern
  (`http://gate.localhost/*`, or `https://gate.example.com/*`).

If they don't match the gate's real origin, the gate never sees the extension
(nothing is injected), or the background worker disconnects it (origin check).
Either way, non-CORS sites keep failing with the usual CORS error in the VM.

## Why it's still JavaScript

The rest of the browser code is TypeScript, compiled by esbuild. This folder
isn't, for one practical reason: Chrome loads an unpacked extension straight
from its folder and can't run `.ts` files. Converting means adding a build step,
loading the build output instead of this folder, and remembering to rebuild.
At about 240 lines, that wasn't worth it when the rest was converted.

There are good reasons to convert it later:

- **It's security code.** `policy.js` decides which sites may be fetched, and
  `background.js` checks who's asking. Type checking helps most here.
- **It speaks the same message format as the gate** (`head` / `chunk` / `end` /
  `error`; see `bridge` in `web/gate/gate.ts`). Nothing currently checks that the
  two sides agree. With a shared type, a mismatch becomes a compile error.
- **The build setup already exists.** It would be one more entry in
  `scripts/esbuild.config.mjs`.

### Option 1: convert to TypeScript (the fuller fix)

- Rename the scripts to `.ts`, add `@types/chrome` as a dev dependency, and add
  a `bridge-extension/tsconfig.json` extending `../tsconfig.base.json`.
- Add an esbuild target that writes `dist/bridge-extension/` (scripts as ES
  modules, plus `manifest.json` and `popup.html` copied as they are).
  `npm run dev` then rebuilds it on change.
- *Load unpacked* points at `dist/bridge-extension/` instead of this folder.
- Move the bridge message types into `types/` next to `gate-protocol.ts`, and
  use them in both `background.ts` and the gate.
- With a build step, the gate origin no longer needs editing by hand: generate
  `APP_ORIGINS` and `matches` from `GATE_URL` (falling back to `gate.localhost`),
  the same way `scripts/build-site.mjs` generates `site.js`.

### Option 2: type-check in place (no build step)

Keep the `.js` files and add a `bridge-extension/tsconfig.json` with `checkJs`
and `@types/chrome`, plus `tsc -p bridge-extension` in `npm run typecheck`.
You'd get type checking, and shared message types through JSDoc
(`@typedef {import("../types/…").…}`), while still loading this folder directly.
The gate origin would still be edited by hand.
