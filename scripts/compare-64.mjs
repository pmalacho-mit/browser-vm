// Boots one VM build on this project's stack (same vm-init/vm-agent, 9p root
// filesystem, fetch() network), checks the bridges, and runs CPU benchmarks.
// Run it once per architecture to compare 32-bit v86 with the 64-bit fork:
//
//   npm run compare:vm              # the 32-bit VM (scripts/targets.mjs)
//   npm run compare:vm:x86_64       # the 64-bit VM
//   node --experimental-strip-types scripts/compare-64.mjs <libv86.mjs> <v86.wasm> <bzImage> <guest dir> [label]
//                                   # any other emulator build, e.g. a newer v86_64 commit
//
// BINARY=/path/to/elf [BINARY_CMDS="tool --version;;tool --help"] also copies a
// prebuilt program into the guest and runs it, e.g. one that ships no 32-bit build.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { attachFetchNetwork, loadTLS, writeGuestFile } from "../runtime/src/net.ts";
import { GUEST_CMDLINE } from "../runtime/src/guest-config.ts";
import { target } from "./targets.mjs";

const root = path.resolve(import.meta.dirname, "..");
const positional = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const vmTarget = positional.length ? null : target(root);
const [lib, wasm, kernel, guest, label] = vmTarget
  ? [vmTarget.lib, vmTarget.wasm, vmTarget.kernel, vmTarget.guest, vmTarget.arch]
  : [...positional.slice(0, 4).map((p) => path.resolve(p)), positional[4] || "vm"];
if (!lib || !wasm || !kernel || !guest) throw new Error("usage: compare-64.mjs [--arch=…] | <libv86.mjs> <v86.wasm> <bzImage> <guest dir> [label]");
/** @type {{ V86: typeof import("v86").V86 }} */
const { V86 } = await import(pathToFileURL(lib).href);

const t0 = performance.now();
const vm = new V86({
  wasm_path: wasm,
  bios: { url: path.join(root, "vendor/seabios.bin") },
  vga_bios: { url: path.join(root, "vendor/vgabios.bin") },
  bzimage: { url: kernel },
  filesystem: { basefs: path.join(guest, "fs.json"), baseurl: path.join(guest, "rootfs") + "/" },
  cmdline: GUEST_CMDLINE,
  memory_size: 256 << 20, uart1: true, uart2: true, uart3: true,
  net_device: { type: "virtio", relay_url: "fetch" },
  autostart: false, disable_keyboard: true, disable_mouse: true, disable_speaker: true,
});
const tls = await loadTLS(path.join(root, "tls/prebuilt/tls.wasm"), async (p) => new Response(fs.readFileSync(p)));
const stub = async (/** @type {string} */ url, /** @type {{ method: string }} */ init) => new Response(`${init.method} ${url}\n`, { status: 200 });
vm.add_listener("emulator-loaded", async () => {
  await writeGuestFile(vm.fs9p, "/etc/ssl/certs/browser-vm-ca.pem", new TextEncoder().encode(tls.caPEM));
  attachFetchNetwork(vm, { tls, log: () => {}, fetchImpl: stub });
  vm.run();
});

let out = "", agent = "";
vm.add_listener("serial0-output-byte", (b) => (out += String.fromCharCode(b)));
vm.add_listener("serial1-output-byte", (b) => (agent += String.fromCharCode(b)));
const until = (/** @type {() => boolean} */ f, ms = 300000) => /** @type {Promise<void>} */ (new Promise((res, rej) => {
  const s = Date.now(), iv = setInterval(() => { if (f()) { clearInterval(iv); res(); } else if (Date.now() - s > ms) { clearInterval(iv); rej(new Error("timeout")); } }, 5);
}));
let n = 0;
/** Runs a command; returns its output and the host-measured time. */
const sh = async (/** @type {string} */ cmd) => {
  const tag = `D${++n}`;
  out = "";
  const s = performance.now();
  // The tag is split in the command so its echo isn't mistaken for the output.
  vm.serial0_send(`${cmd}; echo ${tag.slice(0, 1)}''${tag.slice(1)}\n`);
  await until(() => out.includes(`${tag}\r\n`));
  const ms = performance.now() - s;
  const lines = out.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").split("\r\n");
  return { ms, text: lines.slice(1, lines.indexOf(tag)).join("\n").trim() };
};

await until(() => agent.includes("0 ready"));
const boot = (performance.now() - t0) / 1000;
await until(() => /\$ (\x1b\[6n)?$/.test(out));
// A serial console is 80 columns wide; long commands would wrap and leak into the output.
await sh("stty cols 1000");
/** @type {Record<string, string>} */
const r = {};
r.boot = boot.toFixed(2) + " s";
r.arch = (await sh("uname -m; getconf LONG_BIT")).text.replace(/\n/g, " / ");
r.cpu = (await sh("grep -m1 'model name' /proc/cpuinfo | cut -d: -f2")).text;
r.lm = (await sh("grep -m1 flags /proc/cpuinfo | grep -ow 'lm\\|sse4_2\\|avx' | sort -u | tr '\\n' ' '; echo")).text || "(none of lm/sse4_2/avx)";
// bridges this project relies on
const id = vm.fs9p.SearchPath("/root/project/hello.sh").id, buf = new TextEncoder().encode("#!/bin/sh\necho js-write-ok\n");
await vm.fs9p.ChangeSize(id, buf.length); await vm.fs9p.Write(id, 0, buf.length, buf);
r.ninep = (await sh("/root/project/hello.sh")).text;
r.https = (await sh("wget -qO- https://example.com/check 2>&1")).text;
// CPU benchmarks (host-timed; the first run warms up the JIT)
const bench = async (/** @type {string} */ name, /** @type {string} */ cmd) => { await sh(cmd); const { ms } = await sh(cmd); r[name] = (ms / 1000).toFixed(2) + " s"; };
await bench("shell loop 20k", "i=0; while [ $i -lt 20000 ]; do i=$((i+1)); done");
await bench("sha256 8 MB", "head -c 8388608 /dev/zero | sha256sum >/dev/null");
await bench("gzip 8 MB", "head -c 8388608 /dev/urandom | gzip -1 | wc -c >/dev/null");
await bench("64-bit math", "awk 'BEGIN{x=0; for(i=0;i<300000;i++){x=(x*31+i)%1000000007}; print x}' >/dev/null");
// Optional: a prebuilt native binary to try, written straight into the guest's filesystem.
if (process.env.BINARY) {
  const bin = fs.readFileSync(process.env.BINARY);
  const dir = vm.fs9p.SearchPath("/usr/local/bin").id;
  const bid = vm.fs9p.CreateFile("tool", dir);
  await vm.fs9p.ChangeSize(bid, bin.length); await vm.fs9p.Write(bid, 0, bin.length, new Uint8Array(bin));
  vm.fs9p.GetInode(bid).mode = 0o100755;
  for (const cmd of (process.env.BINARY_CMDS || "tool --version").split(";;")) {
    const { ms, text } = await sh(`${cmd} 2>&1 | tail -3`);
    r[`$ ${cmd}`] = `${text.split("\n").filter((l) => !/D''|echo D/.test(l)).join(" | ")}  (${(ms / 1000).toFixed(1)} s)`;
  }
}
console.log(JSON.stringify({ label, ...r }, null, 1));
process.exit(0);
