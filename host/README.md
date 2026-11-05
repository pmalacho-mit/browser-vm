# Host: how a web page runs a VM

The host is the wiring between a page, the runtime and the network gate. A
surface that runs in a browser includes three scripts, in this order, and then
talks to the runtime over the protocol:

```html
<script src="{{site}}site.js"></script>              <!-- the app's config (tools/build.mjs) -->
<script src="{{site}}host/gate-relay.js"></script>   <!-- the web gate's page side (../gates/web/src/relay.ts) -->
<script src="{{site}}host/runtime-host.js"></script> <!-- this package: the runtime -->
```

```
host/
  src/runtime-host.ts     on the page (site/host/runtime-host.js): embeds the runtime frame, names the
                          runtime's BroadcastChannel (window.__vmRuntimeChannel), brokers preview connections
  runtime-frame/          the runtime's home (site/host/runtime/): index.html (its CSP), frame.ts, worker.ts
  preview/                the preview origins (dist/<app>/preview/): boot page, service worker, client.ts
  types/page-globals.d.ts SITE_CONFIG and the window properties these scripts share
  build.mjs               its part of an app build
```

## The runtime frame

`runtime-host.js` adds a hidden iframe (`runtime-frame/index.html`) whose CSP
allows connections to its own site only: `connect-src 'self'`. The frame starts
the runtime worker from a blob URL, so the worker inherits that CSP even on
static hosts that can't set HTTP headers. Whatever the guest does, its traffic
can only leave through the gate.

The worker (`runtime-frame/worker.ts`) is the runtime's host in the browser:

```ts
runtime = new Runtime({ gate: gate ? new WebGateClient(gate) : undefined, assets });
runtime.emit = serve(channelEndpoint(new BroadcastChannel(channel)), runtime);
```

The page passes it the runtime's channel and the gate relay's channel in the
frame's URL fragment; the VM folder is `site/vm/`, next to `host/`. An app
built with `gate: "none"` has no relay channel, so its runtime has no gate and
no network. The worker bundles the runtime with the app's machine (the
emulator, `__VM_MACHINE__`; see `build.mjs`).

Surfaces learn the runtime's channel from `window.__vmRuntimeChannel` (VS Code
gets it through the setting `linuxVm.runtimeChannel`).

## Previews: servers in the VM


A server listening on `0.0.0.0` in the guest opens in the browser. In VS Code,
use *Linux VM: Preview a Port…*, or the notice that appears when a new port
starts listening; it opens in the Simple Browser. In lite, use the
*preview :port* buttons. Playgrounds with a dev server open their preview
by themselves. A surface opens `window.__vmPreviewUrl` with the port filled in.

```
preview frame, origin 5173-<tab>.preview.<host>          app page (top)              runtime worker
  page ── fetch ─► service worker ── HTTP request ─┐
                                                    ├─ MessagePort (asked for with
  client.js ── WebSocket ─► raw TCP over the VM ────┘   postMessage to the top page) ─► PreviewGateway(5173)
                                                                                         └► v86 connect(5173)
                                                                                            → guest TCP
```

- **Each port gets its own origin**, `<port>-<tab>.preview.<host>`, separate
  from the app's, so a previewed app can't reach the app's pages, the runtime's
  BroadcastChannel or the gate. Its connection
  (`../runtime/src/preview.ts`) reaches that one guest port and nothing else.
- **A service worker** (`preview/sw.ts`) answers every request on
  that origin by making the same HTTP request to the guest, over v86's fake
  TCP stack. The guest sees it come from 192.168.86.1 with `Host: localhost`, so
  dev servers' host checks pass.
- **WebSockets** can't be intercepted by a service worker. A script injected
  into each HTML page (`preview/client.ts`) replaces `WebSocket` for that origin with
  one that runs the WebSocket protocol over a raw TCP connection into the VM.
  That's what hot reload uses.
- **The app's network stays in the VM.** Preview pages get the CSP
  `connect-src 'self'` (and `default-src 'self' …`), so they reach their own
  server and nothing else. Code in the VM still reaches the internet only
  through the gate. Images and scripts from CDNs don't load in a preview.
- **File watching polls.** The 9p root delivers no inotify events (uncached 9p
  doesn't share inodes between lookups, so a watch never sees a change). Dev
  servers must poll: the templates set `server.watch.usePolling` for Vite.
  Polling also notices files saved from the editor, which bypass the guest
  kernel. Other tools: `nodemon -L`, `CHOKIDAR_USEPOLLING=1`, webpack
  `watchOptions.poll`.

Locally, previews use `*.preview.localhost` on the same port (browsers resolve
`*.localhost` to your machine, and `tools/serve.mjs` answers them from the
app's `preview/` folder). Deployed, set `PREVIEW_URL` (see Deploying in the
top-level README). An app can turn previews off (`previews: false`).
Previews only work inside the page that runs the VM: the frame gets its
connection from that page.
