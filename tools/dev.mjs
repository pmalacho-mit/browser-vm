// npm run dev [-- <app>]: build the app once, then rebuild on every change and serve it.
// npm run dev:x86_64 (or VM_ARCH=x86_64) does the same on the 64-bit machine.
//
//   TypeScript (every part's bundles)   → recompiled by esbuild in watch mode
//   HTML, CSS, manifests (part folders) → the part's assemble() runs again
//   dist/<app>/ served on :8080 (site, gate.localhost, *.preview.localhost) and :8081 (the gate alone)
//
// After a change, reload the page (or run "Developer: Reload Window" in VS Code):
// the extension host only loads extensions at startup.
// Type errors don't stop a rebuild; run `npm run typecheck` (or watch your editor).
// Changes to the kernel, an image, tls.wasm, the agent or tools/ need a restart.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { context } from "esbuild";
import { createContext, partsOf, repo } from "./lib/app.mjs";

const name = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "ide";
const time = () => new Date().toLocaleTimeString();

// 1. A full build (deployment origins apply as usual).
const first = spawnSync(process.execPath, [path.join(repo, "tools/build.mjs"), ...process.argv.slice(2)], { stdio: "inherit", env: process.env });
if (first.status !== 0) process.exit(first.status ?? 1);

const ctx = await createContext(name, { dev: true });
const parts = await partsOf(ctx);

// 2. Watch every part's TypeScript.
for (const part of parts) {
  for (const { name: bundle, options } of part.bundles?.(ctx) ?? []) {
    const esb = await context({
      ...options,
      plugins: [{
        name: "report",
        setup(build) {
          let firstBuild = true;
          build.onEnd((result) => {
            if (firstBuild) { firstBuild = false; return; } // build.mjs just built it
            const errors = result.errors.length;
            console.log(`[${time()}] ${bundle}: ${errors ? `${errors} error(s), see above` : "rebuilt, reload the page"}`);
          });
        },
      }],
    });
    await esb.watch();
  }
}

// 3. Run a part's assemble() again when its static files change.
for (const part of parts) {
  let pending = /** @type {ReturnType<typeof setTimeout> | undefined} */ (undefined);
  for (const dir of part.watch ?? []) {
    fs.watch(dir, { recursive: true }, (_event, file) => {
      if (!file || /\.ts$/.test(file)) return; // esbuild has those
      clearTimeout(pending);
      pending = setTimeout(async () => {
        try { await part.assemble?.(ctx); console.log(`[${time()}] ${part.name}: files copied, reload the page`); }
        catch (e) { console.error(`[${time()}] ${part.name}: ${/** @type {Error} */ (e).message}`); }
      }, 50);
    });
  }
}

// 4. Serve.
const server = spawn(process.execPath, [path.join(repo, "tools/serve.mjs"), ctx.out.dist, "8080", "--gate-port=8081"], { stdio: "inherit" });
console.log(`\nwatching ${parts.map((p) => p.name).join(", ")} (Ctrl+C to stop). Open http://localhost:8080 (not 127.0.0.1).\n`);
const stop = () => { server.kill(); process.exit(0); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
