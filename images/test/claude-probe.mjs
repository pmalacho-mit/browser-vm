// Feasibility probe: can Claude Code's native binary run on the 64-bit machine?
//
// The Claude Code VS Code extension is a Node extension that spawns a ~320 MB
// native executable (a Bun-compiled `claude`). This boots the x86_64 machine
// under Node, copies that executable into the guest and runs it, so we know
// what the VM can do before building anything on top. See
// apps/claude-playground/README.md.
//
//   node --experimental-strip-types --disable-warning=ExperimentalWarning \
//     images/test/claude-probe.mjs <path to claude (linux-x64-musl)> [--mem=2048] [--cmd="claude --version"]
//
// Get the binary: npm pack @anthropic-ai/claude-code-linux-x64-musl, untar, package/claude.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { attachFetchNetwork, loadTLS, writeGuestFile } from "@browser-vm/runtime/internals/net";
import { GUEST_CMDLINE } from "@browser-vm/runtime/internals/guest-config";
import { installBlobCache } from "@browser-vm/runtime/internals/blob-cache";
import { AgentClient, installAgent } from "@browser-vm/runtime/internals/agent-client";
import { bootTarget } from "../index.mjs";

const args = process.argv.slice(2);
const opt = (name, dflt) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? dflt;
const binary = args.find((a) => !a.startsWith("--")) ?? null;
const image = opt("image", ""); // an image folder (fs.json + rootfs/) instead of the base image; then the binary is optional
if (!binary && !image) { console.error("usage: claude-probe.mjs [<claude binary>] [--image=<dir>] [--mem=MB] [--cmd=...] [--timeout=s]"); process.exit(2); }
const memMB = Number(opt("mem", "2048")), cmd = opt("cmd", "claude --version"), timeoutS = Number(opt("timeout", "600"));

const vmTarget = bootTarget("x86_64");
const { V86 } = await import(pathToFileURL(vmTarget.lib).href);
const t0 = Date.now();
const elapsed = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const enc = new TextEncoder();
const until = (cond, what, ms) => /** @type {Promise<void>} */ (new Promise((res, rej) => {
  const s = Date.now(), iv = setInterval(() => {
    if (cond()) { clearInterval(iv); res(); }
    else if (Date.now() - s > ms) { clearInterval(iv); rej(new Error(`timeout: ${what}`)); }
  }, 100);
}));

const vm = new V86({
  wasm_path: vmTarget.wasm, bios: { url: vmTarget.firmware.seabios }, vga_bios: { url: vmTarget.firmware.vgabios },
  memory_size: memMB * 1024 * 1024, uart1: true, uart2: true, uart3: true,
  net_device: { type: "virtio", relay_url: "fetch" },
  autostart: false, disable_keyboard: true, disable_mouse: true, disable_speaker: true,
  bzimage: { url: vmTarget.kernel }, cmdline: GUEST_CMDLINE,
  filesystem: { basefs: path.join(image || vmTarget.guest, "fs.json"), baseurl: path.join(image || vmTarget.guest, "rootfs") + "/" },
});
const tls = await loadTLS(vmTarget.tls, async (p) => new Response(fs.readFileSync(p)));
const io = { out: "", ready: /** @type {any} */ (null) };
vm.add_listener("emulator-loaded", async () => {
  installBlobCache(vm.fs9p, { maxBytes: 256 << 20 });
  await installAgent(vm.fs9p, new Uint8Array(fs.readFileSync(/** @type {string} */ (vmTarget.agent))));
  await writeGuestFile(vm.fs9p, "/etc/ssl/certs/browser-vm-ca.pem", enc.encode(tls.caPEM));
  attachFetchNetwork(vm, { tls, log: () => {}, fetchImpl: (url, init) => fetch(url, init) });
  if (binary) {
    const t = Date.now();
    await writeGuestFile(vm.fs9p, "/usr/local/bin/claude", new Uint8Array(fs.readFileSync(binary)));
    console.log(`binary copied into the guest in ${Date.now() - t} ms`);
  }
  vm.run();
});
const agent = new AgentClient((line) => vm.serial_send_bytes(1, enc.encode(line + "\n")));
agent.onReady = (r) => (io.ready = r);
vm.add_listener("serial1-output-byte", (b) => agent.feed(Uint8Array.of(b)));
vm.add_listener("serial0-output-byte", (b) => (io.out += String.fromCharCode(b)));

await until(() => io.ready, "agent ready", 120000);
console.log(`VM up (${memMB} MiB, ${vmTarget.arch}) at ${elapsed()}`);
const sh = (c) => agent.exec(["sh", "-c", c]);
for (const c of ["chmod +x /usr/local/bin/claude; ls -lL /usr/local/bin/claude; free -m | head -2", "ls /lib/ld-musl-x86_64.so.1 /lib64/ld-linux-x86-64.so.2 2>&1; grep -o -m1 -w 'avx2\\|avx\\|sse4_2\\|bmi2' /proc/cpuinfo | sort -u | tr '\\n' ' '"]) {
  const r = await sh(c);
  console.log(`$ ${c}\n${new TextDecoder().decode(r.stdout)}${new TextDecoder().decode(r.stderr)}`);
}
console.log(`$ ${cmd}   (timeout ${timeoutS}s)`);
const ts = Date.now();
const done = Promise.race([
  agent.exec(["sh", "-c", `HOME=/root ${cmd} 2>&1`]),
  new Promise((res) => setTimeout(() => res(null), timeoutS * 1000)),
]);
const r = await done;
if (!r) { console.log(`TIMEOUT after ${timeoutS}s`); process.exitCode = 1; }
else {
  console.log(new TextDecoder().decode(r.stdout).slice(0, 4000));
  console.log(`exit code ${r.code} in ${((Date.now() - ts) / 1000).toFixed(1)} s`);
  process.exitCode = r.code === 0 ? 0 : 1;
}
if (args.includes("--console")) console.log("---- guest console ----\n" + io.out.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").slice(-6000));
process.exit(process.exitCode ?? 0);
