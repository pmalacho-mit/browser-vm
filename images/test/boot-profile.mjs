// Where does boot time go? And how fast is resuming from a snapshot instead?
//   node images/test/boot-profile.mjs [memoryMB] [kernel] [--arch=x86_64]   (npm run profile:boot)
// Prints a phase timeline for a cold boot, then saves a snapshot of the
// booted VM, measures its size (raw and compressed) and how long a restore
// takes until a shell answers.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import zlib from "node:zlib";
import { bootTarget } from "../index.mjs";
import { GUEST_CMDLINE } from "@browser-vm/runtime/internals/guest-config";

const root = path.resolve(import.meta.dirname, "../..");
const vmTarget = bootTarget(); // --arch= or $VM_ARCH: i686 (default) or x86_64
/** @type {{ V86: typeof import("v86").V86 }} */
const { V86 } = await import(pathToFileURL(vmTarget.lib).href);
console.log(`VM: ${vmTarget.arch}, ${vmTarget.description}`);
const guest = vmTarget.guest;
const positional = process.argv.slice(2).filter((a) => !a.startsWith("--")); // [memoryMB] [kernel]
const memMB = parseInt(positional[0] || "512", 10);
const kernel = positional[1] || vmTarget.kernel;

const base = (extra) => ({
  wasm_path: vmTarget.wasm,
  bios: { url: vmTarget.firmware.seabios },
  vga_bios: { url: vmTarget.firmware.vgabios },
  filesystem: { basefs: path.join(guest, "fs.json"), baseurl: path.join(guest, "rootfs") + "/" },
  memory_size: memMB << 20, uart1: true, uart2: true, uart3: true,
  disable_keyboard: true, disable_mouse: true, disable_speaker: true,
  ...extra,
});

const until = (cond, ms = 120000) => /** @type {Promise<void>} */ (new Promise((res, rej) => {
  const s = Date.now(), iv = setInterval(() => { if (cond()) { clearInterval(iv); res(); } else if (Date.now() - s > ms) { clearInterval(iv); rej(new Error("timeout")); } }, 5);
}));

// ---- cold boot, verbose kernel, every serial line timestamped
let t0 = performance.now();
const marks = [];
const mark = (what) => marks.push([((performance.now() - t0) / 1000).toFixed(2), what]);
const vm = new V86(base({
  bzimage: { url: kernel },
  // printk.time gives the kernel's own clock; no "quiet", so we see the milestones
  cmdline: GUEST_CMDLINE.replace(" quiet", "") + " printk.time=1 loglevel=6",
  autostart: true,
}));
let line = "", agent = "", out = "";
/** @type {[RegExp, string][]} */
const wanted = [
  [/Decompressing Linux|Booting the kernel/, "decompressor"],
  [/Linux version/, "kernel started"],
  [/Calibrating delay|tsc: /, "timers/calibration"],
  [/virtio_net|virtio-pci/, "virtio devices"],
  [/9p|VFS: Mounted root/, "root fs mounted"],
  [/Run \/sbin\/vm-init|Freeing unused kernel/, "handing over to init"],
];
const seenLines = new Set();
vm.add_listener("emulator-loaded", () => mark("emulator + fs index loaded"));
vm.add_listener("serial0-output-byte", (b) => {
  const c = String.fromCharCode(b); out += c;
  if (c !== "\n") { line += c; return; }
  for (const [re, what] of wanted) if (re.test(line) && !seenLines.has(what)) { seenLines.add(what); mark(`${what}   «${line.trim().slice(0, 70)}»`); }
  line = "";
});
vm.add_listener("serial1-output-byte", (b) => (agent += String.fromCharCode(b)));
await until(() => agent.includes("0 ready"));
mark("agent ready (vm-init ran)");
await until(() => /\$ (\x1b\[6n)?$/.test(out));
mark("shell prompt");
const coldTotal = (performance.now() - t0) / 1000;
console.log(`\n== cold boot (${memMB} MiB RAM, ${path.basename(kernel)})`);
for (const [t, w] of marks) console.log(`  ${t.padStart(6)} s  ${w}`);

// ---- snapshot
await new Promise((r) => setTimeout(r, 500));
let ts = performance.now();
const state = new Uint8Array(await vm.save_state());
const saveMs = performance.now() - ts;
vm.stop();
ts = performance.now(); const gz = zlib.gzipSync(state, { level: 6 }); const gzMs = performance.now() - ts;
ts = performance.now(); const zs = zlib.zstdCompressSync(state, { params: { [zlib.constants.ZSTD_c_compressionLevel]: 19 } }); const zsMs = performance.now() - ts;
ts = performance.now(); zlib.zstdDecompressSync(zs); const unzsMs = performance.now() - ts;
const MB = (n) => (n / 1e6).toFixed(1) + " MB";
console.log(`\n== snapshot of the booted VM`);
console.log(`  raw ${MB(state.length)} (saved in ${saveMs.toFixed(0)} ms)`);
console.log(`  gzip -6  ${MB(gz.length)}  (${gzMs.toFixed(0)} ms)`);
console.log(`  zstd -19 ${MB(zs.length)}  (${zsMs.toFixed(0)} ms; decompress ${unzsMs.toFixed(0)} ms)`);
fs.writeFileSync(path.join(root, `build-state-${memMB}.bin.zst`), zs);

// ---- restore and time until a shell answers
t0 = performance.now();
const vm2 = new V86(base({ bzimage: { url: kernel }, initial_state: { buffer: zlib.zstdDecompressSync(zs).buffer }, autostart: true }));
let out2 = "";
vm2.add_listener("serial0-output-byte", (b) => (out2 += String.fromCharCode(b)));
await new Promise((r) => vm2.add_listener("emulator-loaded", r));
const loadedMs = performance.now() - t0;
vm2.serial0_send("echo restored-ok\n");
await until(() => out2.includes("restored-ok\r\n"));
const restoreTotal = (performance.now() - t0) / 1000;
console.log(`\n== restore from snapshot`);
console.log(`  emulator loaded with state: ${(loadedMs / 1000).toFixed(2)} s`);
console.log(`  shell answered:             ${restoreTotal.toFixed(2)} s   (cold boot: ${coldTotal.toFixed(2)} s)`);
vm2.stop();
process.exit(0);
