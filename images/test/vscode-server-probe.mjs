// Feasibility probe for issue #5, option C: a real VS Code server (openvscode-server)
// with the Claude Code extension installed, running INSIDE the 64-bit VM, with the
// workbench in a browser outside it.
//
// Boots the x86_64 machine under Node with an image that has openvscode-server
// at /opt/openvscode-server and the extension preinstalled (see
// surfaces/vscode/CLAUDE-CODE.md for the Dockerfile), starts the server in the
// guest, measures time-to-listen and memory, fetches / through the same TCP
// path previews use, and then bridges a local TCP port to the guest's server so
// a real browser (headless Chromium, --browser) can load the workbench and
// start the extension host.
//
//   node --experimental-strip-types --disable-warning=ExperimentalWarning \
//     images/test/vscode-server-probe.mjs --image=build/guest-claude [--mem=1536] [--browser] [--keep] [--no-jit]
//
// If the emulator's JIT produces a WebAssembly module that fails to compile (a
// bug in the v86_64 fork), the module's bytes are written to build/probe/ as a
// repro before the error propagates. --no-jit runs the interpreter only.
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { attachFetchNetwork, loadTLS, writeGuestFile } from "@browser-vm/runtime/internals/net";
import { GUEST_CMDLINE } from "@browser-vm/runtime/internals/guest-config";
import { installBlobCache } from "@browser-vm/runtime/internals/blob-cache";
import { AgentClient, installAgent } from "@browser-vm/runtime/internals/agent-client";
import { PreviewGateway } from "@browser-vm/runtime/preview";
import { bootTarget } from "../index.mjs";

const args = process.argv.slice(2);
const opt = (name, dflt) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? dflt;
const flag = (name) => args.includes(`--${name}`);
const image = opt("image", "");
if (!image || !fs.existsSync(path.join(image, "fs.json"))) { console.error("usage: vscode-server-probe.mjs --image=<dir with fs.json + rootfs/> [--mem=MB] [--port=3000] [--listen=3000] [--browser] [--keep]"); process.exit(2); }
const memMB = Number(opt("mem", "1536")), guestPort = Number(opt("port", "3000")), listenPort = Number(opt("listen", "3000"));
const startTimeoutS = Number(opt("timeout", "900"));

const vmTarget = bootTarget("x86_64");
const { V86 } = await import(pathToFileURL(vmTarget.lib).href);
const t0 = Date.now();
const elapsed = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const enc = new TextEncoder(), dec = new TextDecoder();
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const until = (cond, what, ms) => /** @type {Promise<void>} */ (new Promise((res, rej) => {
  const s = Date.now(), iv = setInterval(() => {
    if (cond()) { clearInterval(iv); res(); }
    else if (Date.now() - s > ms) { clearInterval(iv); rej(new Error(`timeout: ${what}`)); }
  }, 100);
}));
const log = (/** @type {string} */ s) => console.log(`[${elapsed()}] ${s}`);

const vm = new V86({
  wasm_path: vmTarget.wasm, bios: { url: vmTarget.firmware.seabios }, vga_bios: { url: vmTarget.firmware.vgabios },
  memory_size: memMB * 1024 * 1024, uart1: true, uart2: true, uart3: true,
  net_device: { type: "virtio", relay_url: "fetch" },
  autostart: false, disable_keyboard: true, disable_mouse: true, disable_speaker: true, disable_jit: flag("no-jit"),
  bzimage: { url: vmTarget.kernel }, cmdline: GUEST_CMDLINE,
  filesystem: { basefs: path.join(image, "fs.json"), baseurl: path.join(image, "rootfs") + "/" },
});
const tls = await loadTLS(vmTarget.tls, async (p) => new Response(fs.readFileSync(p)));
const io = { ready: /** @type {any} */ (null), console: "" };
let cache = /** @type {import("@browser-vm/runtime/internals/blob-cache").BlobCacheStats} */ (/** @type {any} */ (null));
vm.add_listener("emulator-loaded", async () => {
  dumpFailedJitModules(/** @type {any} */ (vm).v86.cpu);
  cache = installBlobCache(vm.fs9p, { maxBytes: 512 << 20 });
  await installAgent(vm.fs9p, new Uint8Array(fs.readFileSync(/** @type {string} */ (vmTarget.agent))));
  await writeGuestFile(vm.fs9p, "/etc/ssl/certs/browser-vm-ca.pem", enc.encode(tls.caPEM));
  attachFetchNetwork(vm, { tls, log: (s) => log(s), fetchImpl: (url, init) => fetch(url, init) });
  vm.run();
});
const agent = new AgentClient((line) => vm.serial_send_bytes(1, enc.encode(line + "\n")));
agent.onReady = (r) => (io.ready = r);
vm.add_listener("serial1-output-byte", (b) => agent.feed(Uint8Array.of(b)));
vm.add_listener("serial0-output-byte", (b) => (io.console += String.fromCharCode(b)));

/**
 * Wraps the CPU's codegen_finalize (the JIT's "here is a compiled block" callback,
 * reached through the wasm imports) so a module WebAssembly refuses is saved
 * for a bug report, then rethrown.
 * @param {any} cpu
 */
function dumpFailedJitModules(cpu) {
  const orig = cpu.codegen_finalize;
  let n = 0;
  cpu.codegen_finalize = function (/** @type {number} */ index, /** @type {number} */ start, /** @type {number} */ stateFlags, /** @type {number} */ ptr, /** @type {number} */ len) {
    try { return orig.call(this, index, start, stateFlags, ptr, len); }
    catch (e) {
      const dir = path.resolve(import.meta.dirname, "../../build/probe");
      fs.mkdirSync(dir, { recursive: true });
      const f = path.join(dir, `jit-fail-${++n}.wasm`);
      fs.writeFileSync(f, new Uint8Array(this.wasm_memory.buffer, ptr >>> 0, len >>> 0));
      // The guest's code page the block was compiled from (start is a physical address), for disassembly.
      const page = (start >>> 0) & ~0xfff;
      if (this.mem8) fs.writeFileSync(f.replace(/\.wasm$/, `.page-${page.toString(16)}.bin`), this.mem8.subarray(page, page + 0x1000));
      fs.writeFileSync(f.replace(/\.wasm$/, ".txt"), `${e}\nindex=${index} start=0x${(start >>> 0).toString(16)} (physical; block entry at offset 0x${((start >>> 0) - page).toString(16)} of the page dump) stateFlags=0x${(stateFlags >>> 0).toString(16)} len=${len}\n`);
      log(`JIT module refused by WebAssembly; saved ${path.relative(process.cwd(), f)}: ${String(e).slice(0, 160)}`);
      throw e;
    }
  };
}

await until(() => io.ready, "agent ready", 180000);
log(`VM up: ${memMB} MiB, ${vmTarget.arch}, kernel ${io.ready.kernel}`);
const sh = async (/** @type {string} */ c, timeoutMs = 120000) => {
  const r = await agent.exec(["sh", "-c", c], { timeoutMs });
  return (dec.decode(r.stdout) + dec.decode(r.stderr)).trimEnd();
};
const show = async (/** @type {string} */ c) => { const out = await sh(c); console.log(`$ ${c}\n${out}`); return out; };
await show("cat /etc/os-release | head -1; uname -m; openvscode-server --version | head -1; ls /root/.openvscode-server/extensions");

// ---- start the server --------------------------------------------------------
// --disable-workspace-trust: the trust dialog would otherwise swallow the first keystrokes below.
// NODE_EXTRA_CA_CERTS: the server's own HTTPS (gallery checks) goes through the VM's per-tab CA.
const serverCmd = `env NODE_EXTRA_CA_CERTS=/etc/ssl/certs/browser-vm-ca.pem openvscode-server --host 0.0.0.0 --port ${guestPort} --without-connection-token --disable-telemetry --disable-workspace-trust --default-folder /root/project`;
log(`starting: ${serverCmd}`);
const tStart = Date.now();
await sh(`cd /root/project && setsid ${serverCmd} >/tmp/ovs.log 2>&1 </dev/null &`);
let listening = false;
for (let waited = 0; waited < startTimeoutS * 1000; waited += 2000) {
  const r = await agent.request({ cmd: "ports" });
  if (r.ok && /** @type {number[]} */ (r.ports).includes(guestPort)) { listening = true; break; }
  if (waited >= 10000 && !(await sh("pgrep -f server-main.js || true"))) { log("the server process is gone"); break; }
  await sleep(2000);
}
if (!listening) {
  log(`FAIL  the server did not listen on ${guestPort} within ${startTimeoutS}s`);
  await show("cat /tmp/ovs.log; ps -eo rss,etime,args --sort=-rss | head -8");
  process.exit(1);
}
log(`PASS  server listening on :${guestPort} after ${((Date.now() - tStart) / 1000).toFixed(1)} s; ${cache.fetches} files fetched, ${(cache.memoryBytes / 1e6).toFixed(0)} MB cached`);
await show("cat /tmp/ovs.log; free -m | sed -n 1,2p; ps -eo rss,etime,args --sort=-rss | head -6 | cut -c1-150");

// ---- HTTP into the guest, the way previews do -----------------------------------
const gw = new PreviewGateway(/** @type {any} */ ({ emulator: vm }), guestPort);
const tHttp = Date.now();
const res = await gw.http({ method: "GET", path: "/", headers: [] });
log(`${res.status >= 200 && res.status < 400 ? "PASS" : "FAIL"}  GET / → ${res.status} ${res.statusText}, ${res.body.length} bytes, ${Date.now() - tHttp} ms` +
  `, workbench html: ${/workbench/.test(dec.decode(res.body)) ? "yes" : "no"}`);

// ---- a local TCP port bridged into the guest (what a browser would use) ---------
const server = net.createServer((client) => {
  const g = vm.network_adapter.connect(guestPort);
  let connected = false; /** @type {Buffer[]} */ const pending = [];
  g.on("connect", () => { connected = true; for (const b of pending) g.write(new Uint8Array(b)); pending.length = 0; });
  g.on("data", (d) => client.write(Buffer.from(d.slice())));
  g.on("shutdown", () => client.end());
  g.on("close", () => client.destroy());
  client.on("data", (b) => (connected ? g.write(new Uint8Array(b)) : pending.push(b)));
  client.on("close", () => g.close());
  client.on("error", () => g.close());
});
await new Promise((res) => server.listen(listenPort, "127.0.0.1", () => res(undefined)));
log(`local bridge: http://localhost:${listenPort}/?folder=/root/project  →  guest :${guestPort}`);

if (flag("browser")) {
  const { chromium } = await import("playwright");
  const outDir = path.resolve(import.meta.dirname, "../../build/probe");
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on("console", (m) => { if (m.type() === "error") log(`browser: ${m.text().slice(0, 200)}`); });
  const tPage = Date.now();
  await page.goto(`http://localhost:${listenPort}/?folder=/root/project`, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForSelector(".monaco-workbench", { timeout: 300000 });
  log(`workbench shell in ${((Date.now() - tPage) / 1000).toFixed(1)} s`);
  // The Explorer shows the guest's folder once the remote connection is up.
  await page.waitForSelector(".explorer-folders-view .monaco-list-row", { timeout: 600000 });
  log(`PASS  explorer lists /root/project after ${((Date.now() - tPage) / 1000).toFixed(1)} s`);
  await page.screenshot({ path: path.join(outDir, "1-workbench.png") });
  // Extension host: a process in the guest, and the Claude icon in the activity/secondary bar.
  const tExt = Date.now();
  let extHost = "";
  for (let i = 0; i < 150 && !extHost; i++) { extHost = await sh("ps -eo rss,etime,args | grep -v grep | grep -E 'extensionHost|extension-host' | head -2 | cut -c1-140"); if (!extHost) await sleep(2000); }
  log(`${extHost ? "PASS" : "FAIL"}  extension host process in the guest (${((Date.now() - tExt) / 1000).toFixed(0)} s)\n${extHost}`);
  // The extension's static contributions (its editor-title button) appear once the
  // extension host has scanned it; activation itself is only shown by its command
  // working and the claude process below.
  const tAct = Date.now();
  const contributed = await page.waitForSelector('[aria-label*="Claude"], [title*="Claude"]', { timeout: 600000 }).then(() => true, () => false);
  log(`${contributed ? "PASS" : "FAIL"}  Claude Code extension's contributions are in the workbench after ${((Date.now() - tAct) / 1000).toFixed(0)} s`);
  await page.screenshot({ path: path.join(outDir, "2-contributed.png") });
  // Open the Claude Code panel through the command palette.
  await page.keyboard.press("F1");
  await page.keyboard.type("Claude Code: Open in Side Bar");
  await sleep(3000);
  await page.keyboard.press("Enter");
  let claudeProc = "";
  for (let i = 0; i < 300 && !claudeProc; i++) { claudeProc = await sh("ps -eo rss,etime,args | grep -v grep | grep -E 'native-binary/claude|bin/claude' | head -2 | cut -c1-140"); if (!claudeProc) await sleep(2000); }
  log(`${claudeProc ? "PASS" : "FAIL"}  claude binary started by the extension (if the screenshot shows "command not found", the extension had not activated yet)\n${claudeProc}`);
  await sleep(15000);
  await page.screenshot({ path: path.join(outDir, "3-claude-panel.png") });
  log(`screenshots in ${path.relative(process.cwd(), outDir)}/`);
  await show("free -m | sed -n 1,2p; ps -eo rss,etime,args --sort=-rss | head -8 | cut -c1-150; tail -20 /tmp/ovs.log");
  if (!flag("keep")) await browser.close();
}

if (flag("keep")) { log("keeping the VM and the bridge up (Ctrl+C to stop)"); await new Promise(() => {}); }
process.exit(0);
