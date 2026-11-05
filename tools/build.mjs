// Builds an app (apps/<name>/app.config.mjs) into one folder per origin:
//
//   npm run build                    the "ide" app, on its machine (i686)
//   npm run build -- python          another app
//   npm run build:x86_64             the 64-bit machine instead (or --arch=x86_64, or VM_ARCH=x86_64)
//
//   dist/<app>/
//     site/        the app's origin: upload to any static host
//       site.js                      deployment config (generated)
//       host/                        runtime-host.js, gate-relay.js, runtime/ (the runtime frame and worker)
//       vm/                          the machine and images: v86.wasm, firmware, bzImage, tls.wasm,
//                                    vm-agent, fs.json, rootfs/, playgrounds/
//       <surfaces at their paths>    e.g. VS Code at /, lite at /lite/
//     gate/        the gate's origin (a second host name)
//     preview/     the preview origins (wildcard host names)
//     bridge-extension/   optional Chrome extension for the gate (load unpacked; not deployed)
//
// Deployment origins are build-time settings: IDE_URL and GATE_URL (both or
// neither), PREVIEW_URL. Without them the build is for local use: npm start
// serves all three folders from one port (tools/serve.mjs).
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { assembleVm, createContext, partsOf, repo, writeSiteConfig } from "./lib/app.mjs";

const name = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "ide";
const ctx = await createContext(name);
fs.rmSync(ctx.out.dist, { recursive: true, force: true });
fs.mkdirSync(ctx.out.site, { recursive: true });
fs.writeFileSync(path.join(ctx.out.site, ".nojekyll"), ""); // GitHub Pages: serve every file as is

const parts = await partsOf(ctx);
for (const part of parts) await part.assemble?.(ctx);
await Promise.all(parts.flatMap((p) => p.bundles?.(ctx) ?? []).map(({ options }) => build(options)));
const vm = assembleVm(ctx);
writeSiteConfig(ctx);

const rel = (/** @type {string} */ p) => path.relative(repo, p);
const size = (/** @type {string} */ dir) => !fs.existsSync(dir) ? 0 : fs.readdirSync(dir, { recursive: true, encoding: "utf8" }).reduce((n, f) => {
  const s = fs.statSync(path.join(dir, f)); return n + (s.isFile() ? s.size : 0);
}, 0);
const mb = (/** @type {string} */ dir) => `${(size(dir) / 1e6).toFixed(1)} MB`;
const { app, machine: m, origins: o } = ctx;
console.log(`app:      ${name} (${app.title}): ${Object.entries(app.surfaces).map(([p, s]) => `${s} at ${p}`).join(", ")}`);
console.log(`machine:  ${m.arch}, ${m.description}\n  emulator ${rel(path.dirname(m.wasm))}\n  kernel   ${rel(m.kernel)}`);
console.log(`image:    ${rel(vm.base)}\nagent:    ${vm.agent ? rel(vm.agent) : "(the image's shell agent)"}\ntls:      ${rel(vm.tls)}`);
console.log(`playgrounds: ${vm.playgrounds.join(", ") || "none (npm run playgrounds)"}${app.start ? `; starts in ${app.start}` : ""}`);
console.log(`gate:     ${app.gate === "web" ? `web${o.gate ? ` at ${o.gate} (embedded by ${o.ide})` : ""}` : "none (no network)"}`);
if (o.preview) console.log(`previews: ${o.preview}`);
if (o.previewOrigins) console.log(`previews: ${o.previewOrigins.length} fixed origins, ${o.previewOrigins.join(" ")}`);
console.log(`\n${rel(ctx.out.dist)}/`);
console.log(`  site/     ${mb(ctx.out.site)}  (vm/ ${mb(path.join(ctx.out.site, "vm"))})  → ${o.ide ?? "the app's origin"}`);
if (app.gate === "web") console.log(`  gate/     ${mb(ctx.out.gate)}  → ${o.gate ?? "the gate's origin"}`);
if (app.previews) console.log(`  preview/  ${mb(ctx.out.preview)}  → ${o.preview ?? o.previewOrigins?.join(", ") ?? "*.preview origins"}`);
console.log(`\nserve it locally:  node tools/serve.mjs ${rel(ctx.out.dist)}${name === "ide" ? "   (or npm start)" : ""}`);
