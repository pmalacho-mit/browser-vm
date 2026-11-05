// The host's part of an app build (see tools/lib/app.mjs):
//
//   runtime-frame/worker.ts, frame.ts → site/host/runtime/{worker,frame}.js + index.html
//   src/runtime-host.ts               → site/host/runtime-host.js
//   preview/{boot,client}.ts          → preview/__vm_preview__/{boot,client}.js + index.html
//   preview/sw.ts                     → preview/__vm_preview_sw.js (at the root: its scope is the whole origin)
//   preview/open.ts, open.html        → site/host/preview-open.{js,html}  (opens a preview on a fixed origin, PREVIEW_ORIGINS)
//
// The worker bundles the runtime with the app's machine: `import { V86 } from "v86"`
// resolves to that machine's emulator, and __VM_MACHINE__ says what it is.
// Types always come from the npm v86 package.
import fs from "node:fs";
import path from "node:path";
import { builtinModules } from "node:module";

const here = import.meta.dirname;

/** @returns {import("@browser-vm/tools/app").Part} */
export default function hostPart() {
  return {
    name: "host",
    bundles: (ctx) => /** @type {{ name: string, options: import("esbuild").BuildOptions }[]} */ ([
      {
        name: "runtime",
        options: {
          ...ctx.common,
          entryPoints: { worker: path.join(here, "runtime-frame/worker.ts"), frame: path.join(here, "runtime-frame/frame.ts") },
          outdir: path.join(ctx.out.site, "host/runtime"),
          format: "iife",
          // v86 also has Node code paths (guarded at runtime); leave those imports alone.
          external: ["node:*", ...builtinModules],
          alias: { v86: ctx.machine.lib },
          define: { __VM_MACHINE__: JSON.stringify({ arch: ctx.machine.arch, agent: ctx.machine.runsGo }) },
        },
      },
      {
        name: "runtime host",
        options: { ...ctx.common, entryPoints: { "runtime-host": path.join(here, "src/runtime-host.ts") }, outdir: path.join(ctx.out.site, "host"), format: "iife" },
      },
      ...(ctx.app.previews ? [{
        name: "preview",
        options: {
          ...ctx.common,
          entryPoints: {
            "__vm_preview__/boot": path.join(here, "preview/boot.ts"),
            "__vm_preview__/client": path.join(here, "preview/client.ts"),
            "__vm_preview_sw": path.join(here, "preview/sw.ts"),
          },
          outdir: ctx.out.preview,
          format: "iife",
        },
      }, {
        name: "preview opener",
        options: { ...ctx.common, entryPoints: { "preview-open": path.join(here, "preview/open.ts") }, outdir: path.join(ctx.out.site, "host"), format: "iife" },
      }] : []),
    ]),
    assemble(ctx) {
      fs.mkdirSync(path.join(ctx.out.site, "host/runtime"), { recursive: true });
      fs.copyFileSync(path.join(here, "runtime-frame/index.html"), path.join(ctx.out.site, "host/runtime/index.html"));
      if (ctx.app.previews) {
        fs.mkdirSync(path.join(ctx.out.preview, "__vm_preview__"), { recursive: true });
        fs.copyFileSync(path.join(here, "preview/index.html"), path.join(ctx.out.preview, "__vm_preview__/index.html"));
        fs.copyFileSync(path.join(here, "preview/open.html"), path.join(ctx.out.site, "host/preview-open.html"));
      }
    },
    watch: [path.join(here, "runtime-frame"), path.join(here, "preview")],
  };
}
