// The machines: which emulator, firmware and kernel make up each computer.
//
//   i686    (default) upstream v86 from npm, a 32-bit kernel
//   x86_64  the v86_64 fork (machines/x86_64/emulator/, experimental), a 64-bit kernel
//
// Pick one with --arch=… or $VM_ARCH (npm scripts use the argument, because
// env-var syntax isn't portable to Windows). Locally built kernels (build/,
// from `npm run kernel`) win over the prebuilt ones checked in here.
//
// Used by tools/ (the app build), images/ (image builders, boot tests) and anything
// else that needs to run a machine.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const here = import.meta.dirname;
const root = path.resolve(here, "..");
const v86Build = path.join(path.dirname(createRequire(import.meta.url).resolve("v86/package.json")), "build");

/**
 * @typedef {object} MachineSpec
 * @property {string} description
 * @property {string} emulatorDir  holds libv86.mjs, v86.wasm, v86-fallback.wasm
 * @property {string[]} kernel     candidates, first existing wins
 * @property {boolean} runsGo      whether Go programs (the guest agent) run on it
 */

/** @type {Record<string, MachineSpec>} */
export const MACHINES = {
  i686: {
    description: "32-bit x86 (upstream v86)",
    emulatorDir: v86Build,
    kernel: [path.join(root, "build/kernel/bzImage"), path.join(here, "i686/prebuilt/bzImage")],
    runsGo: true,
  },
  x86_64: {
    description: "64-bit x86 (v86_64 fork, experimental)",
    emulatorDir: path.join(here, "x86_64/emulator"),
    kernel: [path.join(root, "build/kernel-x86_64/bzImage"), path.join(here, "x86_64/prebuilt/bzImage")],
    // Go programs abort on the fork ("sysMemStat overflow": an emulation bug in
    // 64-bit XADD/CMPXCHG; x86_64/emulator/PROVENANCE.md), so this machine gets no
    // Go agent: the image's shell agent runs instead (no exec, ports or refresh).
    runsGo: false,
  },
};

/**
 * @typedef {object} Machine
 * @property {string} arch          "i686" or "x86_64"
 * @property {string} description
 * @property {boolean} runsGo
 * @property {string} lib           JS side of the emulator (libv86.mjs)
 * @property {string} wasm          CPU + JIT
 * @property {string} wasmFallback  the same without SIMD/bulk memory
 * @property {{ seabios: string, vgabios: string }} firmware
 * @property {string} kernel        bzImage
 */

/** The --arch= argument of this process, if any. */
export const argArch = () => process.argv.find((a) => a.startsWith("--arch="))?.slice("--arch=".length);

/**
 * Resolved absolute paths for one machine. Default: --arch=, else $VM_ARCH, else `fallback`.
 * @param {string} [arch]
 * @param {string} [fallback]  the default when neither is set (an app's `machine`)
 * @returns {Machine}
 */
export function machine(arch, fallback = "i686") {
  arch ??= argArch() || process.env.VM_ARCH || fallback;
  const machine = MACHINES[arch];
  if (!machine) throw new Error(`the machine must be one of ${Object.keys(MACHINES).join(", ")} (got "${arch}")`);
  const kernel = machine.kernel.find((c) => fs.existsSync(c));
  if (!kernel) throw new Error(`[${arch}] no kernel: none of ${machine.kernel.map((k) => path.relative(root, k)).join(", ")} (npm run kernel)`);
  return {
    arch,
    description: machine.description,
    runsGo: machine.runsGo,
    lib: path.join(machine.emulatorDir, "libv86.mjs"),
    wasm: path.join(machine.emulatorDir, "v86.wasm"),
    wasmFallback: path.join(machine.emulatorDir, "v86-fallback.wasm"),
    firmware: { seabios: path.join(here, "firmware/seabios.bin"), vgabios: path.join(here, "firmware/vgabios.bin") },
    kernel,
  };
}
