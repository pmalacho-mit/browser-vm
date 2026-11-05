# Tools: from an app to deployable folders

```
tools/
  build.mjs      npm run build [-- <app>]      build an app (default: ide)
  dev.mjs        npm run dev [-- <app>]        build, serve, rebuild on change
  serve.mjs      npm start                     serve a built app locally
  lib/app.mjs    loading apps, the build context, the VM folder, site.js (and the AppConfig / Part types)
```

## What a build makes

One folder per origin, because the app, its gate and its previews must be
different origins for the browser to keep them apart:

```
dist/<app>/
  site/                       the app's origin
    site.js                   SITE_CONFIG: origins, gate, previews, start playground, surfaces (generated)
    host/                     runtime-host.js, gate-relay.js, runtime/ (frame + worker)    ← host, gates/web
    vm/                       v86.wasm, firmware, bzImage, tls.wasm, vm-agent,            ← machines, runtime,
                              fs.json, rootfs/, playgrounds/                                images
    <surfaces at their paths> e.g. index.html, vscode/, extensions/ at /; lite/ at /lite/  ← surfaces/*
  gate/                       the gate's origin: index.html, gate.js, chunks/, site.js     ← gates/web
  preview/                    the preview origins: __vm_preview__/, __vm_preview_sw.js     ← host
  bridge-extension/           optional Chrome extension for the gate (load unpacked)       ← gates/web
```

Everything is plain static files. No special headers are needed (v86 doesn't
need `SharedArrayBuffer`, so no COOP/COEP); `site/` includes a `.nojekyll` for
GitHub Pages.

## Parts

Each buildable package exports a part from its `build.mjs`. The build loads
the app, makes a `BuildContext` (the app, its machine, the output folders,
the deployment origins, shared esbuild options, and `page()` for templated
HTML), then runs every part:

```js
/** @type {Part} */
{
  name: "lite (/lite/)",
  bundles: (ctx) => [{ name: "lite", options: { ...ctx.common, entryPoints: [...], outdir: ... } }],
  assemble: (ctx) => ctx.page("src/index.html", path.join(ctx.out.site, "lite/index.html")),
  watch: ["src"],   // dev mode: their non-TypeScript files re-run assemble()
}
```

| Part | From |
|---|---|
| the host | `host/build.mjs` |
| the web gate | `gates/web/build.mjs` |
| each surface, at its path | `surfaces/<name>/build.mjs` |
| the VM folder | `assembleVm()` in `lib/app.mjs`, from `machines/`, `images/` and `runtime/assets.mjs` |

esbuild only strips types; `npm run typecheck` checks them.

## Serving locally

`node tools/serve.mjs dist/<app> [port] [--gate-port=N] [--preview-ports=A,B,…]`
serves the three folders from one port, by host name, as they're laid out deployed:

| Host name | Folder |
|---|---|
| `localhost` | `site/` |
| `gate.localhost` | `gate/` |
| `*.preview.localhost` | `preview/` |
| anything else (e.g. VS Code's webview origins, `<uuid>.localhost`) | `site/` |

Browsers resolve `*.localhost` to your machine, so this needs no setup. Use
`localhost`, not `127.0.0.1`. For port forwarders that give each port one exact
host name, `--gate-port` also serves `gate/` alone on a second port, and
`--preview-ports` serves `preview/` alone on each listed port (the fixed preview
origins of `PREVIEW_ORIGINS`; see `../host/README.md`). `npm start` and
`npm run dev` use 8081 for the gate and 8082–8085 for previews; a port that's
taken is skipped with a warning.

## Dev mode

`npm run dev` builds once, then runs every part's bundles in esbuild's watch
mode and re-runs a part's `assemble()` when its static files change. Reload the
page after a change (*Developer: Reload Window* reloads VS Code's extension,
but not the runtime worker). Changes to a kernel, an image, `tls.wasm`, the
agent or `tools/` need their own build and a restart.
