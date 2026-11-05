// What gets compiled, and how. Shared by scripts/build-site.mjs (one build) and
// scripts/dev.mjs (watch mode), so both produce the same dist/.
//
//   runtime/src/worker.ts        → dist/runtime/worker.js                       the VM runtime (a worker; classic script)
//   web/runtime/frame.ts         → dist/runtime/frame.js                        starts it, in web/runtime/index.html
//   extension/src/extension.ts  → dist/extensions/linux-vm/dist/extension.js   CommonJS, for VS Code's extension host
//   web/gate-relay.ts            → dist/gate-relay.js                           classic scripts for index.html,
//   web/runtime-host.ts          → dist/runtime-host.js                         loaded in a fixed order
//   web/boot.ts                  → dist/boot.js
//   web/amd-config.ts            → dist/amd-config.js
//   web/lite/lite.ts             → dist/lite/lite.js                            the lightweight frontend
//   web/__vm_preview__/*.ts      → dist/__vm_preview__/{boot,client}.js         preview origins (classic scripts)
//                                   dist/__vm_preview_sw.js                      and their service worker (scope "/")
//   web/gate/gate.ts             → dist/gate/gate.js (+ chunks/ for manage.ts)  ES module; the gate's CSP is script-src 'self'
//
// The runtime's `import { V86 } from "v86"` resolves to the emulator of the
// selected VM architecture (scripts/targets.mjs): upstream v86 for i686, the
// v86_64 fork for x86_64. Types always come from the npm v86 package.
//
// esbuild only strips types. Type errors are caught by `npm run typecheck`.
import fs from "node:fs";
import path from "node:path";
import { builtinModules } from "node:module";

const root = path.resolve(import.meta.dirname, "..");
const fromRoot = (/** @type {string[]} */ ...p) => path.join(root, ...p);

/** @type {import("esbuild").BuildOptions} */
const common = {
  bundle: true,
  platform: "browser",
  target: "es2022",
  minify: false,
  sourcemap: true,
  logLevel: "warning",
};

/**
 * One entry per output, each with a short name for log messages.
 * @param {string} dist
 * @param {import("./targets.mjs").VmTarget} vm  the emulator to bundle into the extension
 * @returns {{ name: string, options: import("esbuild").BuildOptions }[]}
 */
export function esbuildTargets(dist, vm) {
  return [
    {
      name: "runtime",
      options: {
        ...common,
        entryPoints: {
          worker: fromRoot("runtime/src/worker.ts"),
          frame: fromRoot("web/runtime/frame.ts"),
        },
        outdir: path.join(dist, "runtime"),
        format: "iife",
        // v86 also has Node code paths (guarded at runtime); leave those imports alone.
        external: ["node:*", ...builtinModules],
        alias: { v86: vm.lib },
        define: { __VM_ARCH__: JSON.stringify(vm.arch) },
      },
    },
    {
      name: "extension",
      options: {
        ...common,
        entryPoints: [fromRoot("extension/src/extension.ts")],
        outfile: path.join(dist, "extensions/linux-vm/dist/extension.js"),
        format: "cjs",
        external: ["vscode"],
      },
    },
    {
      name: "host page",
      options: {
        ...common,
        entryPoints: {
          "gate-relay": fromRoot("web/gate-relay.ts"),
          "runtime-host": fromRoot("web/runtime-host.ts"),
          boot: fromRoot("web/boot.ts"),
          "amd-config": fromRoot("web/amd-config.ts"),
        },
        outdir: dist,
        format: "iife",
      },
    },
    {
      name: "lite",
      options: {
        ...common,
        entryPoints: [fromRoot("web/lite/lite.ts")],
        outdir: path.join(dist, "lite"),
        format: "iife",
        loader: { ".css": "css" },
      },
    },
    {
      name: "preview",
      options: {
        ...common,
        entryPoints: {
          "__vm_preview__/boot": fromRoot("web/__vm_preview__/boot.ts"),
          "__vm_preview__/client": fromRoot("web/__vm_preview__/client.ts"),
          // At the root, so its scope can be the whole preview origin.
          "__vm_preview_sw": fromRoot("web/__vm_preview__/sw.ts"),
        },
        outdir: dist,
        format: "iife",
      },
    },
    {
      name: "gate",
      options: {
        ...common,
        entryPoints: [fromRoot("web/gate/gate.ts")],
        outdir: path.join(dist, "gate"),
        format: "esm",
        // The settings popup (manage.ts) is loaded on demand, as its own file.
        splitting: true,
        chunkNames: "chunks/[name]-[hash]",
      },
    },
  ];
}

/** Files copied as they are: page markup and styles, and the extension manifest. */
const STATIC = /\.(html|css|svg|png|ico)$/;

/** @param {string} dist */
export function copyStatic(dist) {
  // web/**/*.html etc. → dist/**, keeping the layout (index.html, gate/, runtime/, lite/).
  for (const rel of fs.readdirSync(fromRoot("web"), { recursive: true, encoding: "utf8" })) {
    if (!STATIC.test(rel)) continue;
    fs.mkdirSync(path.dirname(path.join(dist, rel)), { recursive: true });
    fs.copyFileSync(fromRoot("web", rel), path.join(dist, rel));
  }
  const ext = path.join(dist, "extensions/linux-vm");
  fs.mkdirSync(ext, { recursive: true });
  for (const f of ["package.json", "package.nls.json"]) fs.copyFileSync(fromRoot("extension", f), path.join(ext, f));
}

/** True for a changed file that copyStatic() handles (paths relative to the repo root). */
export const isStaticSource = (/** @type {string} */ rel) =>
  (rel.startsWith("web/") && STATIC.test(rel)) || /^extension\/package(\.nls)?\.json$/.test(rel);
