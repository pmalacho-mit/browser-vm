// What gets compiled, and how. Shared by scripts/build-site.mjs (one build) and
// scripts/dev.mjs (watch mode), so both produce the same dist/.
//
//   extension/src/extension.ts  → dist/extensions/linux-vm/dist/extension.js   CommonJS, for VS Code's extension host
//   web/gate-relay.ts            → dist/gate-relay.js                           classic scripts for index.html,
//   web/boot.ts                  → dist/boot.js                                 loaded in a fixed order
//   web/amd-config.ts            → dist/amd-config.js
//   web/gate/gate.ts             → dist/gate/gate.js (+ chunks/ for manage.ts)  ES module; the gate's CSP is script-src 'self'
//
// The extension's `import { V86 } from "v86"` resolves to the emulator of the
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
      name: "extension",
      options: {
        ...common,
        entryPoints: [fromRoot("extension/src/extension.ts")],
        outfile: path.join(dist, "extensions/linux-vm/dist/extension.js"),
        format: "cjs",
        // v86 also has Node code paths (guarded at runtime); leave those imports alone.
        external: ["vscode", "node:*", ...builtinModules],
        alias: { v86: vm.lib },
        define: { __VM_ARCH__: JSON.stringify(vm.arch) },
      },
    },
    {
      name: "host page",
      options: {
        ...common,
        entryPoints: {
          "gate-relay": fromRoot("web/gate-relay.ts"),
          boot: fromRoot("web/boot.ts"),
          "amd-config": fromRoot("web/amd-config.ts"),
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
  fs.mkdirSync(path.join(dist, "gate"), { recursive: true });
  fs.copyFileSync(fromRoot("web/index.html"), path.join(dist, "index.html"));
  for (const f of fs.readdirSync(fromRoot("web/gate"))) {
    if (STATIC.test(f)) fs.copyFileSync(fromRoot("web/gate", f), path.join(dist, "gate", f));
  }
  const ext = path.join(dist, "extensions/linux-vm");
  fs.mkdirSync(ext, { recursive: true });
  for (const f of ["package.json", "package.nls.json"]) fs.copyFileSync(fromRoot("extension", f), path.join(ext, f));
}

/** True for a changed file that copyStatic() handles (paths relative to the repo root). */
export const isStaticSource = (/** @type {string} */ rel) =>
  (rel.startsWith("web/") && STATIC.test(rel)) || /^extension\/package(\.nls)?\.json$/.test(rel);
