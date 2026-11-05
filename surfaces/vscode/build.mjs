// The VS Code surface's part of an app build (see tools/lib/app.mjs), at its
// mount path in the site (<m>, e.g. site/ for "/"):
//
//   page/index.html                 → <m>/index.html  ({{site}}, {{title}} filled in)
//   page/boot.ts, page/amd-config.ts → <m>/boot.js, <m>/amd-config.js   classic scripts
//   extension/src/extension.ts      → <m>/extensions/linux-vm/dist/extension.js   CommonJS, for VS Code's extension host
//   extension/package*.json         → <m>/extensions/linux-vm/
//   node_modules/vscode-web/dist    → <m>/vscode/   with the extension host's CSP locked down (below)
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

const here = import.meta.dirname;
const vscodeWeb = path.join(path.dirname(createRequire(import.meta.url).resolve("vscode-web/package.json")), "dist");

/** @param {{ mount: string }} o @returns {import("@browser-vm/tools/app").Part} */
export default function vscodePart({ mount }) {
  const dir = (/** @type {import("@browser-vm/tools/app").BuildContext} */ ctx) => path.join(ctx.out.site, mount);
  return {
    name: `vscode (${mount})`,
    bundles: (ctx) => [
      {
        name: "vscode page",
        options: {
          ...ctx.common,
          entryPoints: { boot: path.join(here, "page/boot.ts"), "amd-config": path.join(here, "page/amd-config.ts") },
          outdir: dir(ctx),
          format: "iife",
        },
      },
      {
        name: "vscode extension",
        options: {
          ...ctx.common,
          entryPoints: [path.join(here, "extension/src/extension.ts")],
          outfile: path.join(dir(ctx), "extensions/linux-vm/dist/extension.js"),
          format: "cjs",
          external: ["vscode"],
        },
      },
    ],
    assemble(ctx) {
      const out = dir(ctx);
      ctx.page(path.join(here, "page/index.html"), path.join(out, "index.html"));
      const ext = path.join(out, "extensions/linux-vm");
      fs.mkdirSync(ext, { recursive: true });
      for (const f of ["package.json", "package.nls.json"]) fs.copyFileSync(path.join(here, "extension", f), path.join(ext, f));
      // The workbench (~30 MB): copied once per dev session.
      if (!(ctx.dev && fs.existsSync(path.join(out, "vscode/out")))) {
        fs.cpSync(vscodeWeb, path.join(out, "vscode"), { recursive: true });
        lockExtensionHost(path.join(out, "vscode"));
      }
    },
    watch: [path.join(here, "page"), path.join(here, "extension")],
  };
}

/**
 * Locks down VS Code's extension host. Every web extension (ours, and any
 * installed from Open VSX) runs in a worker created by this iframe and inherits
 * its CSP. Upstream allows connect-src/script-src to ANY https: origin, so any
 * extension could send data anywhere and skip the network gate. Here they get
 * their own origin (plus Open VSX, where gallery extensions' code lives) and
 * nothing else; the VM's traffic goes through the gate instead.
 * @param {string} vscodeDir
 */
function lockExtensionHost(vscodeDir) {
  const f = path.join(vscodeDir, "out/vs/workbench/services/extensions/worker/webWorkerExtensionHostIframe.html");
  const html = fs.readFileSync(f, "utf8");
  // A worker started from a URL takes its CSP from HTTP headers (static hosts
  // often can't set any), not from this page. A worker started from a blob:
  // URL inherits this page's CSP, and so does every blob worker IT starts. So
  // start the extension host through a one-line blob that loads the real script.
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  if (!script) throw new Error("extension host iframe: no inline script found (vscode-web changed?)");
  const wrapped = script.replace("const worker = new Worker(workerUrl, { name });",
    "const workerAbs = new URL(workerUrl, location.href); " +
    // workerMain.js resolves modules against its own URL unless told otherwise; a blob has none.
    "const worker = new Worker(URL.createObjectURL(new Blob([`globalThis.MonacoEnvironment = { baseUrl: ${JSON.stringify(new URL('../../../', workerAbs).href)} }; importScripts(${JSON.stringify(workerAbs.href)});`], { type: 'text/javascript' })), { name }); // CSP-inheriting (surfaces/vscode/build.mjs)");
  if (wrapped === script) throw new Error("could not wrap the extension host worker (vscode-web changed?)");
  const hash = (/** @type {string} */ t) => `'sha256-${createHash("sha256").update(t).digest("base64")}'`;
  if (!html.includes(hash(script))) throw new Error("extension host iframe: inline script hash mismatch (vscode-web changed?)");
  const locked = html
    .replace(script, wrapped)
    .replace(hash(script), hash(wrapped))
    .replace(/connect-src [^;]*;/, "connect-src 'self' https://open-vsx.org;")
    // blob: lets the extension host start its workers; it adds no network reach (connect-src decides that).
    .replace(/(script-src [^;]*?) https:;/, "$1 blob: https://open-vsx.org;");
  if (/connect-src[^;]*https:;/.test(locked)) throw new Error("could not patch the extension host CSP (vscode-web changed?)");
  fs.writeFileSync(f, locked);
}
