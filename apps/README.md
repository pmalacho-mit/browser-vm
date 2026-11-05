# Apps: browser VMs built from the platform

An app is one browser VM: a machine, images, the surfaces at their paths, a
gate, and whether it has previews. It's a config file and nothing else;
`npm run build -- <name>` turns it into deployable folders.

| App | What it is | Size of `site/` |
|---|---|---|
| `ide` | VS Code at `/`, lite at `/lite/`, every built playground, the web gate, previews. What this repo deploys. | ~445 MB (most of it the playground snapshots and VS Code) |
| `python` | lite alone at `/`, starting in the Python playground, the web gate, no previews | ~60 MB |

```js
// apps/python/app.config.mjs
/** @type {import("@browser-vm/tools/app").AppConfig} */
export default {
  title: "Python in a Browser VM",   // page titles
  machine: "i686",                   // machines/: "i686" or "x86_64"; --arch= / VM_ARCH override it
  image: "base",                     // images/: the cold-boot image
  playgrounds: ["python-3.12"],      // which built playgrounds to ship: "all", a list, or []
  start: "python-3.12",              // the playground to open when the URL names none
  surfaces: { "/": "lite" },         // path → surface (surfaces/): "vscode", "lite"
  gate: "web",                       // gates/: "web", or "none" (the VM has no network)
  previews: false,                   // previews of servers in the VM (host/preview/)
};
```

```
npm run playgrounds -- python-3.12     # the playgrounds it ships, once
npm run build -- python                # → dist/python/{site,gate}/
node tools/serve.mjs dist/python       # http://localhost:8080
npm run test:e2e:python                # its browser test
```

Deployment origins (`IDE_URL`, `GATE_URL`, `PREVIEW_URL`) are not part of an
app: the same app can be deployed anywhere. See Deploying in the top-level README.

## Making one

Copy a folder, edit `app.config.mjs`, build. To give it something no app has
yet, add to the layer below: a surface (`../surfaces/README.md`), a playground
(`../images/README.md`), a machine (`../machines/README.md`) or a gate
(`../gates/README.md`).

A browser test is a good second file: `ide/test/e2e-test.mjs` and
`python/test/e2e-test.mjs` serve the built app with `tools/serve.mjs` and drive
it with Playwright.
