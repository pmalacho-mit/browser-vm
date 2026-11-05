# Surfaces: what the user (or an agent) touches

A surface is a client of the runtime protocol. It never touches the emulator,
the gate or asset URLs: it connects to the runtime and calls its API
(`../runtime/README.md`). In a browser, the host (`../host/`) has already
started the runtime and named its channel.

| Surface | Package | What it is | Runs in |
|---|---|---|---|
| VS Code | `vscode/` | Code-OSS (web) and a thin extension (20 KB) that maps the runtime to VS Code's file system, terminal and search APIs | a page, plus VS Code's extension-host worker |
| Lite | `lite/` | one page: file tree, CodeMirror 6, xterm.js, a preview pane. About 1.7 MB unminified. The reference for bringing your own editor | a page |
| MCP | `mcp/` | an MCP server for AI agents | Node, as an MCP client's child process |

An app mounts browser surfaces at paths: `surfaces: { "/": "vscode", "/lite/": "lite" }`
(`../apps/`). Each one's `build.mjs` writes it under its path in the site, and
fills in `{{site}}` (the path back to the site root) and `{{title}}` in its HTML.

## Writing a surface

1. A page that includes the host's scripts (`../host/README.md`), then:

   ```ts
   import { channelEndpoint, connect } from "@browser-vm/runtime/rpc";
   import type { Runtime } from "@browser-vm/runtime";

   const rt = connect<Runtime>(channelEndpoint(new BroadcastChannel(window.__vmRuntimeChannel!)));
   const playground = new URLSearchParams(location.search).get("playground") ?? globalThis.SITE_CONFIG?.start ?? "";
   const result = await rt.api.boot({ playground });
   ```

   Import only `@browser-vm/runtime/rpc` and types, so the emulator stays out
   of your bundle.
2. A `build.mjs` exporting a part factory, `({ mount }) => Part`: the esbuild
   bundles and the files it copies (`../tools/README.md`). Copy `lite/build.mjs`.
3. A name for it in `SURFACES` (`../tools/lib/app.mjs`), so apps can mount it.

`lite/src/lite.ts` is the worked example: about 250 lines using every part of
the API (files and `fs` events, terminals, `exec`, ports, previews, gate notices).

## VS Code (`vscode/`)

```
vscode/
  page/        index.html, boot.ts (workbench options), amd-config.ts: the workbench page
  extension/   the linux-vm extension: package.json (its manifest), src/ (extension, fs-provider, terminal, search)
  build.mjs    copies node_modules/vscode-web/dist to <mount>/vscode/, locks down its extension host, bundles the rest
```

- **Workbench.** The prebuilt Code-OSS 1.91 web build from npm (`vscode-web`,
  MIT). `page/boot.ts` passes `IWorkbenchConstructionOptions` via
  `window.product`: open `vmfs:/root/project`, register the extension through
  `additionalBuiltinExtensions`, allow its proposed APIs, set the webview
  endpoint. Works from any path.
- **The extension** is a *web* extension (`"browser"` entry) in VS Code's
  extension-host worker: a `FileSystemProvider` for `vmfs:`, file and text
  search providers, pseudoterminals, the gate's notices, previews in the Simple
  Browser, and the playground picker (`runtime.playgrounds()`). Settings
  (`linuxVm.*`) are machine-scoped, so a workspace can't override them; the page
  sets the runtime channel, preview URL and playground through
  `configurationDefaults`.
- **The extension host's network is locked.** `build.mjs` rewrites its CSP to
  `connect-src 'self' https://open-vsx.org` and starts it from a blob, so every
  worker it spawns inherits that CSP. Upstream allows any `https:` origin.
- **Search.** In the desktop app, Ctrl+P and Find in Files are ripgrep on a
  Node server. In pure web, a custom scheme needs the *proposed*
  `fileSearchProvider`/`textSearchProvider` APIs, enabled through
  `productConfiguration.extensionEnabledApiProposals`.
- **Webviews** (Markdown preview, extension UIs) must run on
  `https://<hash>.<webview-host>/`, because the bootstrap page checks its own
  hostname. `*.localhost` resolves to loopback in browsers, so local dev works
  with no setup. Deployed, point a wildcard name at the app's site (for example
  `*.webview.example.com` with a wildcard TLS certificate) and set
  `WEBVIEW_HOST` in `page/boot.ts`; left `null`, webviews load from Microsoft's
  `*.vscode-cdn.net` copy, which works but is a third-party runtime dependency.
- **Extension gallery.** Off by default (`ENABLE_EXTENSION_GALLERY` in
  `page/boot.ts`): an editor extension can read every file in the VM and use the
  gate within its policy. Ship the extensions you need as built-ins.
- **Version.** `vscode-web` on npm is Code-OSS 1.91 (2024). For a current
  build, compile Code-OSS yourself (`npx gulp vscode-web-min`). Newer versions
  load as ES modules, so the script tags in `page/index.html` change, and the
  API proposal names may differ.

## Lite (`lite/`)

`src/index.html` and `src/lite.ts`. It takes `?playground=`, starts in the
app's `start` playground otherwise, shows gate notices in the terminal, and has
*preview :port* buttons and a preview pane. It links to the VS Code surface
when the app has one (`SITE_CONFIG.surfaces`).

## MCP (`mcp/`)

`server.ts` gives an agent its own VM over the
[Model Context Protocol](https://modelcontextprotocol.io) (stdio). Its tools
are `run_command`, `read_file`, `write_file`, `list_directory`, `search_text`
and `list_ports`. Unlike the browser surfaces it also *hosts* the runtime:
in-process under Node, with the node gate (`../gates/node/`), and the VM folder
of a built app (`dist/ide/site/vm`; `npm run build` first).

```
claude mcp add browser-vm -- node --experimental-strip-types /path/to/browser-vm/surfaces/mcp/server.ts --playground node-24
```

Options: `--playground <id>`, `--allow <host>` (repeatable), `--network off`,
`--memory-mb <n>`, `--assets <dir>`. The guest reaches package registries plus
`--allow` hosts, and never private addresses or IPs. There is no browser here,
so no CORS limits and no secret vault. Use `node` directly or `npm run -s mcp`:
without `-s`, npm prints a banner on stdout, which is the protocol channel.
`npm run test:mcp` drives it as an MCP client does.
