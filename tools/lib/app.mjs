// Apps and parts: what tools/build.mjs and tools/dev.mjs share.
//
// An app (apps/<name>/app.config.mjs) picks a machine, images, surfaces and a
// gate. A part is what a package contributes to a build (its build.mjs): the
// esbuild bundles it needs and the files it copies or generates. The build
// runs the parts an app names and writes one folder per origin:
//
//   dist/<app>/site/       the app's origin: surfaces, host/, vm/ (machine + images)
//   dist/<app>/gate/       the gate's origin
//   dist/<app>/preview/    the preview origins (one per guest port, wildcard)
//   dist/<app>/bridge-extension/   optional Chrome extension for the gate (not deployed)
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { argArch, machine as resolveMachine } from "@browser-vm/machines";
import { baseImage, builtPlaygrounds } from "@browser-vm/images";
import { runtimeAssets } from "@browser-vm/runtime/assets";
import hostPart from "@browser-vm/host/build";
import gateWebPart from "@browser-vm/gate-web/build";

export const repo = path.resolve(import.meta.dirname, "../..");

/**
 * @typedef {object} AppConfig
 * @property {string} title
 * @property {string} [machine]                  default "i686"; --arch= / $VM_ARCH override it
 * @property {"base"} [image]                    the cold-boot image
 * @property {"all" | string[]} [playgrounds]    which built playgrounds to ship (default "all")
 * @property {string} [start]                    the playground to open when the URL names none
 * @property {Record<string, string>} surfaces   mount path ("/", "/lite/") → surface name
 * @property {"web" | "none"} [gate]             "none": the VM has no network (default "web")
 * @property {boolean} [previews]                previews of servers in the VM (default true)
 */

/**
 * @typedef {object} BuildContext
 * @property {string} name          the app's folder name in apps/
 * @property {Required<AppConfig>} app
 * @property {import("@browser-vm/machines").Machine} machine
 * @property {{ dist: string, site: string, gate: string, preview: string, extras: string }} out
 * @property {{ ide?: string, gate?: string, preview?: string, previewOrigins?: string[] }} origins  deployment URLs (IDE_URL, GATE_URL, PREVIEW_URL or PREVIEW_ORIGINS)
 * @property {import("esbuild").BuildOptions} common  esbuild options every bundle starts from
 * @property {boolean} dev          true under tools/dev.mjs (parts may skip unchanged heavy copies)
 * @property {(src: string, dest: string) => void} page  copies an HTML page, filling in {{site}} (path to the site root) and {{title}}
 */

/**
 * @typedef {object} Part
 * @property {string} name
 * @property {(ctx: BuildContext) => { name: string, options: import("esbuild").BuildOptions }[]} [bundles]
 * @property {(ctx: BuildContext) => void | Promise<void>} [assemble]  static and generated files
 * @property {string[]} [watch]  folders whose non-TypeScript files feed assemble() (dev mode)
 */

/** The surfaces this platform has: name → its package's part factory. */
const SURFACES = {
  vscode: () => import("@browser-vm/vscode/build"),
  lite: () => import("@browser-vm/lite/build"),
};

export const appNames = () => fs.readdirSync(path.join(repo, "apps")).filter((d) => fs.existsSync(path.join(repo, "apps", d, "app.config.mjs")));

/** @param {string} name @returns {Promise<Required<AppConfig>>} */
export async function loadApp(name) {
  const file = path.join(repo, "apps", name, "app.config.mjs");
  if (!fs.existsSync(file)) throw new Error(`no app "${name}" (apps/${name}/app.config.mjs); apps: ${appNames().join(", ")}`);
  /** @type {AppConfig} */
  const c = (await import(pathToFileURL(file).href)).default;
  const app = { machine: "i686", image: "base", playgrounds: "all", start: "", gate: "web", previews: true, ...c };
  for (const [mount, surface] of Object.entries(app.surfaces)) {
    if (!/^\/([a-z0-9-]+\/)*$/.test(mount)) throw new Error(`${name}: surface path "${mount}" must look like "/" or "/lite/"`);
    if (!(surface in SURFACES)) throw new Error(`${name}: no surface "${surface}" (surfaces: ${Object.keys(SURFACES).join(", ")})`);
  }
  if (!["web", "none"].includes(app.gate)) throw new Error(`${name}: gate must be "web" or "none"`);
  if (app.image !== "base") throw new Error(`${name}: the only cold-boot image is "base"`);
  return /** @type {Required<AppConfig>} */ (app);
}

/**
 * Deployment origins: IDE_URL and GATE_URL (both or neither), and for previews
 * either PREVIEW_URL (a wildcard template, one origin per port) or
 * PREVIEW_ORIGINS (a fixed list, separated by spaces or commas, handed out as
 * previews open: for forwarders that answer one exact host name per port).
 * Only these variables count, so where the build runs never changes its output.
 */
function origins() {
  const { IDE_URL: ide, GATE_URL: gate, PREVIEW_URL: preview } = process.env;
  const previewOrigins = (process.env.PREVIEW_ORIGINS ?? "").split(/[\s,]+/).filter(Boolean).map((o) => new URL(o).origin);
  if (!ide !== !gate) throw new Error("set both IDE_URL and GATE_URL, or neither");
  if (ide && gate && new URL(ide).origin === new URL(gate).origin) throw new Error("IDE_URL and GATE_URL must be different origins");
  if (preview && !/^https?:\/\/\{id\}\.[^/]+\/?$/.test(preview)) throw new Error("PREVIEW_URL must look like https://{id}.preview.example.com/");
  if (preview && previewOrigins.length) throw new Error("set PREVIEW_URL or PREVIEW_ORIGINS, not both");
  const taken = [ide, gate].filter(Boolean).map((u) => new URL(/** @type {string} */ (u)).origin);
  if (previewOrigins.some((o) => taken.includes(o))) throw new Error("PREVIEW_ORIGINS must differ from IDE_URL and GATE_URL");
  return {
    ...(ide && gate && { ide: new URL(ide).href, gate: new URL(gate).href }),
    ...(preview && { preview }),
    ...(previewOrigins.length && { previewOrigins }),
  };
}

/**
 * @param {string} name
 * @param {{ dev?: boolean }} [o]
 * @returns {Promise<BuildContext>}
 */
export async function createContext(name, { dev = false } = {}) {
  const app = await loadApp(name);
  const dist = path.join(repo, "dist", name);
  const out = { dist, site: path.join(dist, "site"), gate: path.join(dist, "gate"), preview: path.join(dist, "preview"), extras: dist };
  return {
    name, app, out, dev,
    machine: resolveMachine(argArch(), app.machine),
    origins: origins(),
    common: { bundle: true, platform: "browser", target: "es2022", minify: false, sourcemap: true, logLevel: "warning" },
    page(src, dest) {
      const site = path.relative(path.dirname(dest), out.site).split(path.sep).join("/");
      const html = fs.readFileSync(src, "utf8").replaceAll("{{site}}", site ? site + "/" : "").replaceAll("{{title}}", app.title);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, html);
    },
  };
}

/** The parts an app is made of: the host, the gate, and its surfaces at their paths. @param {BuildContext} ctx */
export async function partsOf(ctx) {
  /** @type {Part[]} */
  const parts = [hostPart(), gateWebPart()];
  for (const [mount, surface] of Object.entries(ctx.app.surfaces)) {
    const factory = (await SURFACES[/** @type {keyof typeof SURFACES} */ (surface)]()).default;
    parts.push(factory({ mount }));
  }
  return parts;
}

/**
 * The VM folder (site/vm/): the machine, the runtime's files for it, the base
 * image and the playgrounds that restore on this machine.
 * @param {BuildContext} ctx
 */
export function assembleVm(ctx) {
  const { machine: m, app } = ctx;
  const vm = path.join(ctx.out.site, "vm");
  fs.mkdirSync(vm, { recursive: true });
  const copy = (/** @type {string} */ from, /** @type {string} */ to) => fs.copyFileSync(from, path.join(vm, to));
  copy(m.wasm, "v86.wasm");
  copy(m.wasmFallback, "v86-fallback.wasm");
  copy(m.firmware.seabios, "seabios.bin");
  copy(m.firmware.vgabios, "vgabios.bin");
  copy(m.kernel, "bzImage");
  const rt = runtimeAssets(m.arch, { agent: m.runsGo });
  copy(rt.tls, "tls.wasm");
  if (rt.agent) copy(rt.agent, "vm-agent");
  const base = baseImage(m.arch);
  copy(path.join(base, "fs.json"), "fs.json");
  fs.cpSync(path.join(base, "rootfs"), path.join(vm, "rootfs"), { recursive: true });

  // Playgrounds: each one's files, plus the blobs its index references (from the shared pool).
  const wanted = (/** @type {string} */ id) => app.playgrounds === "all" || app.playgrounds.includes(id);
  const shipped = [];
  for (const pg of builtPlaygrounds(m)) {
    if (!wanted(pg.id)) continue;
    if (pg.unusable) { console.warn(`playground ${pg.id}: skipped (${pg.unusable}; rebuild with npm run playgrounds)`); continue; }
    const out = path.join(vm, "playgrounds", pg.id);
    fs.mkdirSync(out, { recursive: true });
    for (const f of ["manifest.json", pg.manifest.state]) fs.copyFileSync(path.join(pg.dir, f), path.join(out, f));
    /** @type {(entries: any[]) => void} */
    const walk = (entries) => {
      for (const e of entries) {
        const [, , , mode, , , target] = e;
        if ((mode & 0xf000) === 0x4000) walk(target);
        else if ((mode & 0xf000) === 0x8000 && typeof target === "string") {
          const to = path.join(vm, "rootfs", target);
          if (!fs.existsSync(to)) fs.copyFileSync(path.join(pg.dir, "..", "rootfs", target), to);
        }
      }
    };
    walk(JSON.parse(fs.readFileSync(path.join(pg.dir, "fs.json"), "utf8")).fsroot);
    const { title, description, memoryMB, packages } = pg.manifest;
    shipped.push({ id: pg.id, title, description, memoryMB, packages });
  }
  if (app.playgrounds !== "all") {
    for (const id of app.playgrounds) if (!shipped.some((p) => p.id === id)) console.warn(`playground ${id}: not built for ${m.arch} (npm run playgrounds -- ${id})`);
  }
  fs.mkdirSync(path.join(vm, "playgrounds"), { recursive: true });
  fs.writeFileSync(path.join(vm, "playgrounds", "index.json"), JSON.stringify(shipped, null, 2) + "\n");
  return { base, agent: rt.agent, tls: rt.tls, playgrounds: shipped.map((p) => p.id) };
}

/**
 * site.js for the site and the gate: the deployment config pages read as SITE_CONFIG.
 * @param {BuildContext} ctx
 */
export function writeSiteConfig(ctx) {
  const { app, origins: o } = ctx;
  const surfaces = Object.fromEntries(Object.entries(app.surfaces).map(([mount, s]) => [mount.slice(1), s]));
  const site = {
    ...(o.ide && { ideUrl: o.ide, gateUrl: o.gate }),
    ...(o.preview && { previewUrl: o.preview }),
    ...(o.previewOrigins && { previewOrigins: o.previewOrigins }),
    ...(app.gate === "none" && { gate: false }),
    ...(!app.previews && { previews: false }),
    ...(app.start && { start: app.start }),
    surfaces,
  };
  const js = (/** @type {object} */ config) => `// Generated by tools/build.mjs: this app's deployment config.\n` +
    `self.SITE_CONFIG = ${JSON.stringify(config)};\n` +
    // The site root: where this file is (pages at any path load it from there).
    `if (self.document?.currentScript) self.SITE_CONFIG.root = new URL(".", document.currentScript.src).href;\n`;
  fs.mkdirSync(ctx.out.site, { recursive: true });
  fs.writeFileSync(path.join(ctx.out.site, "site.js"), js(site));
  if (app.gate === "web") {
    fs.mkdirSync(ctx.out.gate, { recursive: true });
    fs.writeFileSync(path.join(ctx.out.gate, "site.js"), js(o.ide ? { ideUrl: o.ide, gateUrl: o.gate } : {}));
  }
}
