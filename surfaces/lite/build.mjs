// The lite surface's part of an app build (see tools/lib/app.mjs), at its mount
// path in the site (<m>, e.g. site/lite/ for "/lite/"):
//
//   src/index.html → <m>/index.html  ({{site}}, {{title}} filled in)
//   src/lite.ts    → <m>/lite.js + lite.css (xterm.js's styles)
import path from "node:path";

const here = import.meta.dirname;

/** @param {{ mount: string }} o @returns {import("@browser-vm/tools/app").Part} */
export default function litePart({ mount }) {
  const dir = (/** @type {import("@browser-vm/tools/app").BuildContext} */ ctx) => path.join(ctx.out.site, mount);
  return {
    name: `lite (${mount})`,
    bundles: (ctx) => [{
      name: "lite",
      options: { ...ctx.common, entryPoints: [path.join(here, "src/lite.ts")], outdir: dir(ctx), format: "iife", loader: { ".css": "css" } },
    }],
    assemble(ctx) {
      ctx.page(path.join(here, "src/index.html"), path.join(dir(ctx), "index.html"));
    },
    watch: [path.join(here, "src")],
  };
}
