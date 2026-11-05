// The images: what's on the computer's disk when it starts.
//
//   base         the default image, cold-booted: images/base/ (a Dockerfile)
//   playgrounds  snapshots of booted, warmed-up VMs: images/playgrounds/<id>/,
//                built by images/builder/ into build/playgrounds/
//
// An image is a root filesystem in v86's 9p format: fs.json (the file index)
// plus rootfs/<sha256>.bin(.zst) blobs. A playground adds state.bin.zst (RAM,
// CPU, devices) and manifest.json; it restores only on the machine (emulator +
// kernel) it was built on.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { machine as resolveMachine } from "@browser-vm/machines";
import { runtimeAssets } from "@browser-vm/runtime/assets";

const here = import.meta.dirname;
const repo = path.resolve(here, "..");

/** Where `npm run playgrounds` puts its output: one folder per playground, plus the shared blob pool rootfs/. */
export const PLAYGROUNDS_BUILD = path.join(repo, "build/playgrounds");

/**
 * The base image for a machine: a folder holding fs.json and rootfs/. A locally
 * built one (build/guest…, from `npm run image`) wins over the prebuilt one.
 * @param {string} arch
 */
export function baseImage(arch) {
  const candidates = [path.join(repo, arch === "i686" ? "build/guest" : `build/guest-${arch}`), path.join(here, "base/prebuilt", arch)];
  const found = candidates.find((c) => fs.existsSync(path.join(c, "fs.json")));
  if (!found) throw new Error(`[${arch}] no base image: none of ${candidates.map((c) => path.relative(repo, c)).join(", ")} (npm run image)`);
  return found;
}

/** Short id of a file's contents: snapshots record the emulator and kernel they were made with. */
export const fileId = (/** @type {string} */ p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex").slice(0, 16);

/**
 * @typedef {object} BuiltPlayground
 * @property {string} id
 * @property {string} dir       build/playgrounds/<id>
 * @property {Record<string, any>} manifest
 * @property {string | null} unusable  why it can't ship with this machine, if it can't
 */

/**
 * The playgrounds built in build/playgrounds, and whether each one restores on `m`.
 * @param {import("@browser-vm/machines").Machine} m
 * @returns {BuiltPlayground[]}
 */
export function builtPlaygrounds(m) {
  if (!fs.existsSync(PLAYGROUNDS_BUILD)) return [];
  const emulator = fileId(m.wasm), kernel = fileId(m.kernel);
  return fs.readdirSync(PLAYGROUNDS_BUILD)
    .filter((d) => fs.existsSync(path.join(PLAYGROUNDS_BUILD, d, "manifest.json")))
    .map((id) => {
      const dir = path.join(PLAYGROUNDS_BUILD, id);
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
      const unusable = manifest.arch !== m.arch ? `built for ${manifest.arch}`
        : manifest.emulator !== emulator ? "built with another emulator"
        : manifest.kernel !== kernel ? "built with another kernel" : null;
      return { id, dir, manifest, unusable };
    });
}

/** The playground definitions in images/playgrounds/ (what `npm run playgrounds` can build). */
export const playgroundSources = () => fs.readdirSync(path.join(here, "playgrounds"))
  .filter((d) => fs.existsSync(path.join(here, "playgrounds", d, "playground.json")));

/**
 * Everything needed to boot the base image on a machine outside the browser
 * (boot tests, profiling, comparing machines): the machine, the image folder,
 * and the runtime's files for it.
 * @param {string} [arch]  default: --arch= / $VM_ARCH / i686
 */
export function bootTarget(arch) {
  const m = resolveMachine(arch);
  const { tls, agent } = runtimeAssets(m.arch, { agent: m.runsGo });
  return { ...m, guest: baseImage(m.arch), tls, agent };
}
