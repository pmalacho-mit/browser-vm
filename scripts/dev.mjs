// npm run dev: build dist/ once, then rebuild on every change and serve it.
// npm run dev:x86_64 (or VM_ARCH=x86_64) does the same with the 64-bit VM.
//
//   TypeScript (extension/src, web/)   → recompiled by esbuild in watch mode
//   HTML / CSS / extension manifest    → copied again
//   dist/ served on :8080 (IDE) and :8081 (gate when a port forwarder needs it)
//
// After a change, reload the page (or run "Developer: Reload Window" in the IDE):
// the extension host only loads the extension at startup.
// Type errors don't stop a rebuild; run `npm run typecheck` (or watch your editor).
// Changes to the kernel, guest image, tls.wasm or build-site.mjs need a restart.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { context } from "esbuild";
import { copyStatic, esbuildTargets, isStaticSource } from "./esbuild.config.mjs";
import { target } from "./targets.mjs";

const root = path.resolve(import.meta.dirname, "..");
const dist = path.join(root, "dist");
const time = () => new Date().toLocaleTimeString();

// 1. A full build: workbench, VM assets, site.js (IDE_URL/GATE_URL apply as usual).
const vm = target(root);
const first = spawnSync(process.execPath, [path.join(root, "scripts/build-site.mjs"), `--arch=${vm.arch}`], { stdio: "inherit", env: process.env });
if (first.status !== 0) process.exit(first.status ?? 1);

// 2. Watch the TypeScript entry points.
for (const { name, options } of esbuildTargets(dist, vm)) {
  const ctx = await context({
    ...options,
    plugins: [{
      name: "report",
      setup(build) {
        let firstBuild = true;
        build.onEnd((result) => {
          if (firstBuild) { firstBuild = false; return; } // build-site.mjs just built it
          const errors = result.errors.length;
          console.log(`[${time()}] ${name}: ${errors ? `${errors} error(s), see above` : "rebuilt, reload the page"}`);
        });
      },
    }],
  });
  await ctx.watch();
}

// 3. Copy static files again when they change.
let pending = /** @type {ReturnType<typeof setTimeout> | undefined} */ (undefined);
for (const dir of ["web", "extension"]) {
  fs.watch(path.join(root, dir), { recursive: true }, (_event, file) => {
    if (!file || !isStaticSource(`${dir}/${file.split(path.sep).join("/")}`)) return;
    clearTimeout(pending);
    pending = setTimeout(() => {
      try { copyStatic(dist); console.log(`[${time()}] copied HTML/CSS/manifest, reload the page`); }
      catch (e) { console.error(`[${time()}] copy failed: ${/** @type {Error} */ (e).message}`); }
    }, 50);
  });
}

// 4. Serve.
const server = spawn(process.execPath, [path.join(root, "scripts/serve.mjs"), dist, "8080", "8081"], { stdio: "inherit" });
console.log("\nwatching extension/src and web/ (Ctrl+C to stop). Open http://localhost:8080 (not 127.0.0.1).\n");
const stop = () => { server.kill(); process.exit(0); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
