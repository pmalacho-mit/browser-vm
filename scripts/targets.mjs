// Which emulator, kernel and guest image to use, per VM architecture.
// The one switch is the VM_ARCH environment variable, or an --arch=... argument
// (npm scripts use the argument, because env-var syntax isn't portable to Windows):
//
//   VM_ARCH=i686    (default) upstream v86 from npm, 32-bit kernel and image
//   VM_ARCH=x86_64  the v86_64 fork in vendor/v86_64 (experimental), 64-bit kernel and image
//
// Locally built pieces (build/...) win over the prebuilt ones in guest/prebuilt/.
// Used by build-site.mjs, dev.mjs, boot-test.mjs, boot-profile.mjs and compare-64.mjs.
import fs from "node:fs";
import path from "node:path";

/**
 * @typedef {object} ArchFiles
 * @property {string} description
 * @property {string} emulatorDir  holds libv86.mjs, v86.wasm, v86-fallback.wasm
 * @property {string[]} kernel     candidates, first existing wins
 * @property {string[]} guest      candidates (each holds fs.json + rootfs/), first existing wins
 */

/** @type {Record<string, ArchFiles>} */
export const ARCHES = {
  i686: {
    description: "32-bit x86 (upstream v86)",
    emulatorDir: "node_modules/v86/build",
    kernel: ["build/kernel/bzImage", "guest/prebuilt/bzImage"],
    guest: ["build/guest", "guest/prebuilt/guest"],
  },
  x86_64: {
    description: "64-bit x86 (v86_64 fork, experimental)",
    emulatorDir: "vendor/v86_64",
    kernel: ["build/kernel-x86_64/bzImage", "guest/prebuilt/x86_64/bzImage"],
    guest: ["build/guest-x86_64", "guest/prebuilt/x86_64/guest"],
  },
};

/**
 * @typedef {object} VmTarget
 * @property {string} arch          "i686" or "x86_64"
 * @property {string} description
 * @property {string} lib           JS side of the emulator (libv86.mjs)
 * @property {string} wasm          CPU + JIT
 * @property {string} wasmFallback  the same without SIMD/bulk memory
 * @property {string} kernel        bzImage
 * @property {string} guest         folder with fs.json + rootfs/
 */

/** The --arch= argument of this process, if any. */
export const argArch = () => process.argv.find((a) => a.startsWith("--arch="))?.slice("--arch=".length);

/**
 * Resolved absolute paths for one architecture. Default: --arch=, else $VM_ARCH, else i686.
 * @param {string} root  the repository root
 * @param {string} [arch]
 * @returns {VmTarget}
 */
export function target(root, arch = argArch() || process.env.VM_ARCH || "i686") {
  const t = ARCHES[arch];
  if (!t) throw new Error(`VM_ARCH must be one of ${Object.keys(ARCHES).join(", ")} (got "${arch}")`);
  const pick = (/** @type {string[]} */ candidates) => {
    const found = candidates.find((c) => fs.existsSync(path.join(root, c)));
    if (!found) throw new Error(`[${arch}] none of these exist: ${candidates.join(", ")}`);
    return path.join(root, found);
  };
  const emu = path.join(root, t.emulatorDir);
  return {
    arch,
    description: t.description,
    lib: path.join(emu, "libv86.mjs"),
    wasm: path.join(emu, "v86.wasm"),
    wasmFallback: path.join(emu, "v86-fallback.wasm"),
    kernel: pick(t.kernel),
    guest: pick(t.guest),
  };
}
