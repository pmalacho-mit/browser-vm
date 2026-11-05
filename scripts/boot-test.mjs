// Headless smoke test of the guest image — no browser, no VS Code.
// Boots the same kernel + rootfs with v86 under Node and exercises the bridges
// the extension relies on: serial consoles, the shared 9p filesystem, the guest
// agent, the fetch() network (with a stub fetch, so it needs no internet), and
// a snapshot round trip (save, restore into a fresh emulator, refresh).
//   npm run test:boot   (npm run test:boot:x86_64 for the 64-bit VM)
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { attachFetchNetwork, loadTLS, writeGuestFile } from "../runtime/src/net.ts";
import { GUEST_CMDLINE } from "../runtime/src/guest-config.ts";
import { installBlobCache } from "../runtime/src/blob-cache.ts";
import { AgentClient, freshSeed, installAgent } from "../runtime/src/agent-client.ts";
import { target } from "./targets.mjs";

const root = path.resolve(import.meta.dirname, "..");
const vmTarget = target(root); // --arch= or $VM_ARCH: i686 (default) or x86_64
/** @type {{ V86: typeof import("v86").V86 }} */
const { V86 } = await import(pathToFileURL(vmTarget.lib).href);
console.log(`VM: ${vmTarget.arch}, ${vmTarget.description}`);
/** The first of these paths (relative to the repo) that exists, as an absolute path. */
const pick = (/** @type {string[]} */ ...c) => {
  const found = c.map((p) => path.join(root, p)).find((p) => fs.existsSync(p));
  if (!found) throw new Error(`none of these exist: ${c.join(", ")}`);
  return found;
};
const guest = vmTarget.guest;
const t0 = Date.now();
const elapsed = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const enc = new TextEncoder(), dec = new TextDecoder();
const MEMORY = 256 << 20;

/** Settings both emulators share (a restore needs the same devices and memory). */
const devices = {
  wasm_path: vmTarget.wasm,
  bios: { url: path.join(root, "vendor/seabios.bin") },
  vga_bios: { url: path.join(root, "vendor/vgabios.bin") },
  memory_size: MEMORY, uart1: true, uart2: true, uart3: true,
  net_device: { type: /** @type {const} */ ("virtio"), relay_url: "fetch" },
  autostart: false, disable_keyboard: true, disable_mouse: true, disable_speaker: true,
};

// Stand-in for the browser's fetch(): echoes the request, refuses one host like CORS would.
const fetched = [];
const stubFetch = async (url, init) => {
  fetched.push({ url, ...init });
  if (new URL(url).hostname === "no-cors.example") throw new TypeError("Failed to fetch");
  const body = init.body ? dec.decode(init.body) : "";
  return new Response(`${init.method} ${url} ${body}`.trim() + "\n", { status: 200, headers: { "content-type": "text/plain" } });
};
const loadTlsFile = () => loadTLS(pick("build/tls/tls.wasm", "tls/prebuilt/tls.wasm"), async (p) => new Response(fs.readFileSync(p)));

const until = (cond, what, ms = 120000) => /** @type {Promise<void>} */ (new Promise((res, rej) => {
  const s = Date.now(), iv = setInterval(() => {
    if (cond()) { clearInterval(iv); res(); }
    else if (Date.now() - s > ms) { clearInterval(iv); rej(new Error(`timeout: ${what}`)); }
  }, 50);
}));
const PROMPT = /\$ (\x1b\[6n)?$/;
const check = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); if (!ok) process.exitCode = 1; };

/** Wires an emulator's first console and agent channel; returns helpers for both. */
function wire(emulator) {
  const io = { out: "", agentReady: /** @type {any} */ (null) };
  emulator.add_listener("serial0-output-byte", (b) => (io.out += String.fromCharCode(b)));
  const agent = new AgentClient((line) => emulator.serial_send_bytes(1, enc.encode(line + "\n")));
  agent.onReady = (r) => (io.agentReady = r);
  emulator.add_listener("serial1-output-byte", (b) => agent.feed(Uint8Array.of(b)));
  /** Runs a shell command on ttyS0 and returns its output. */
  const sh = async (cmd) => {
    io.out = "";
    emulator.serial0_send(cmd + "\n");
    await until(() => PROMPT.test(io.out), cmd);
    return io.out.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").split("\r\n").slice(1, -1).join("\n");
  };
  return { io, agent, sh };
}

// ---- cold boot -----------------------------------------------------------------
const vm = new V86({ ...devices, bzimage: { url: vmTarget.kernel }, cmdline: GUEST_CMDLINE,
  filesystem: { basefs: path.join(guest, "fs.json"), baseurl: path.join(guest, "rootfs") + "/" } });
const tls = await loadTlsFile();
/** Set when the emulator has loaded (before any check runs). @type {import("../runtime/src/blob-cache.ts").BlobCacheStats} */
let cache = /** @type {any} */ (null);
vm.add_listener("emulator-loaded", async () => {
  cache = installBlobCache(vm.fs9p, { maxBytes: 256 << 20 }); // as the extension does
  if (vmTarget.agent) await installAgent(vm.fs9p, new Uint8Array(fs.readFileSync(vmTarget.agent))); // likewise
  await writeGuestFile(vm.fs9p, "/etc/ssl/certs/browser-vm-ca.pem", enc.encode(tls.caPEM));
  attachFetchNetwork(vm, { tls, log: () => {}, fetchImpl: stubFetch });
  vm.run();
});
const { io, agent, sh } = wire(vm);

await until(() => io.agentReady, "agent ready");
const goAgent = Boolean(vmTarget.agent);
check(`boot + ${goAgent ? "Go" : "shell"} agent ready on ttyS1`, goAgent ? io.agentReady.protocol >= 2 : io.agentReady.protocol === 0,
  `${elapsed()}, protocol ${io.agentReady.protocol}, kernel ${io.agentReady.kernel}`);
await until(() => PROMPT.test(io.out), "shell prompt");
check("shell prompt on ttyS0", true, elapsed());
check(`kernel is ${vmTarget.arch}`, (await sh("uname -m")) === vmTarget.arch);
check("userland", /Alpine/.test(await sh("cat /etc/os-release")));

// editor -> guest: write into the existing inode, exactly like the FileSystemProvider
const fs9p = vm.fs9p, id = fs9p.SearchPath("/root/project/hello.sh").id;
const buf = enc.encode('#!/bin/sh\necho "written from JS"\n');
await fs9p.ChangeSize(id, buf.length); await fs9p.Write(id, 0, buf.length, buf);
check("JS write visible to guest", (await sh("./hello.sh")) === "written from JS");

// guest -> editor
await sh("echo from-guest > /root/project/g.txt");
const back = dec.decode(await vm.read_file("/root/project/g.txt")).trim();
check("guest write visible to JS", back === "from-guest");

// blob cache: v86 used to drop a file's contents when the guest closed it, so
// every read (and every run of a program) fetched it again.
const fetchesBefore = cache.fetches;
await sh("cat /lib/apk/db/installed > /dev/null; cat /lib/apk/db/installed > /dev/null");
check("file read twice is fetched once (blob cache)", cache.fetches - fetchesBefore === 1,
  `${cache.fetches - fetchesBefore} fetch(es); boot fetched ${cache.fetches - 1} files, ${(cache.memoryBytes / 1e6).toFixed(1)} MB cached`);

// control channel (guest/agent)
const resized = await agent.request({ cmd: "resize", tty: "ttyS0", rows: 33, cols: 101 });
check("resize via agent", resized.ok && (await sh("stty size")) === "33 101");
if (!goAgent) {
  console.log("SKIP  exec and ports — the shell agent doesn't have them (no Go agent for this VM)");
} else {
const ex = await agent.exec(["sh", "-c", "uname -m; echo oops >&2; exit 3"]);
check("exec: exit code, stdout and stderr kept apart", ex.code === 3 && dec.decode(ex.stdout).trim() === vmTarget.arch && dec.decode(ex.stderr).trim() === "oops",
  `code ${ex.code}, ${ex.ms} ms`);
await agent.exec(["sh", "-c", "nc -l -p 9123 >/dev/null 2>&1 &"]);
// exec returns when sh exits, which can be before nc is listening: poll briefly.
let ports = await agent.request({ cmd: "ports" });
for (let i = 0; i < 20 && !(/** @type {number[]} */ (ports.ports ?? []).includes(9123)); i++) {
  await new Promise((res) => setTimeout(res, 100));
  ports = await agent.request({ cmd: "ports" });
}
check("ports lists a listening server", ports.ok && /** @type {number[]} */ (ports.ports).includes(9123), JSON.stringify(ports.ports));
}

// network: guest → fake TCP → (tls.wasm) → HTTP parser → fetch()
let r = await sh("wget -qO- http://example.com/plain");
check("HTTP via fetch()", r === "GET http://example.com/plain", r);
r = await sh("wget -qO- https://example.com/secure?x=1");
check("HTTPS via tls.wasm + fetch() (cert verified by guest)", r === "GET https://example.com/secure?x=1", r);
r = await sh("wget -qO- --post-data=hello https://api.example.com/post");
check("HTTPS POST body", r === "POST https://api.example.com/post hello", r);
r = await sh("wget -qO- https://no-cors.example/ 2>&1; echo rc=$?");
check("CORS-refused request → HTTP 502 in guest", /502/.test(r) && /rc=1/.test(r), r.split("\n")[0]);
check("cookies never sent", fetched.every((f) => f.credentials === "omit"));
r = await sh("(printf 'HTTP/1.0 200 OK\\r\\n\\r\\nserved inside the VM\\n' | nc -l -p 8000 >/dev/null &); sleep 1; wget -qO- http://localhost:8000/");
// (long commands wrap on the 80-column console, so only look at the last line)
r = r.split("\n").pop() ?? "";
check("server inside the VM reachable at localhost", r === "served inside the VM", r);
// Negative control: without this tab's CA in the bundle, the guest must reject the certificate.
r = await sh("awk '/BEGIN CERT/{b=\"\"} {b=b $0 \"\\n\"} /END CERT/{if(c++)printf \"%s\", p; p=b}' /etc/ssl/certs/ca-certificates.crt > /tmp/no-vm-ca.crt; " +
  "cp /etc/ssl/certs/ca-certificates.crt /tmp/full.crt; cp /tmp/no-vm-ca.crt /etc/ssl/certs/ca-certificates.crt; " +
  "wget -qO- https://example.com/ 2>&1; echo rc=$?; cp /tmp/full.crt /etc/ssl/certs/ca-certificates.crt");
r = r.split("\n").slice(-2).join(" | ");
check("guest rejects the cert without the tab's CA (it really verifies)", /rc=1$/.test(r), r);

// ---- snapshot round trip: save, restore into a new emulator (a "new tab"), refresh ----
if (vmTarget.arch === "x86_64") {
  console.log("SKIP  snapshot round trip — the v86_64 fork can't restore 64-bit state yet (docs/v86_64-fork)");
} else {
  await sh("sync");
  const state = await vm.save_state();
  await vm.stop();
  const tls2 = await loadTlsFile(); // a new tab makes a new CA
  const ahead = 3600_000; // set the restored clock an hour ahead, to see that refresh sets it
  const vm2 = new V86({ ...devices, initial_state: { buffer: state }, preserve_mac_from_state_image: true,
    filesystem: { baseurl: path.join(guest, "rootfs") + "/" } });
  vm2.add_listener("emulator-loaded", async () => {
    installBlobCache(vm2.fs9p, { maxBytes: 256 << 20 });
    await writeGuestFile(vm2.fs9p, "/etc/ssl/certs/browser-vm-ca.pem", enc.encode(tls2.caPEM));
    attachFetchNetwork(vm2, { tls: tls2, log: () => {}, fetchImpl: stubFetch });
    vm2.run();
  });
  const two = wire(vm2);
  await new Promise((res) => vm2.add_listener("emulator-loaded", res));
  two.agent.assume(2);
  const t1 = Date.now();
  const refreshed = await two.agent.request({ cmd: "refresh", seed: freshSeed(), timeMs: Date.now() + ahead });
  check("restore + agent refresh", refreshed.ok && refreshed.caReplaced === 1,
    `${Date.now() - t1} ms after load; ${refreshed.ok ? `CA replaced: ${refreshed.caReplaced}` : refreshed.error}`);
  const guestNow = Number(await two.sh("date +%s")) * 1000;
  check("refresh set the clock", Math.abs(guestNow - (Date.now() + ahead)) < 60_000, new Date(guestNow).toISOString());
  r = await two.sh("wget -qO- https://example.com/after-restore");
  check("HTTPS after restore (guest trusts the new tab's CA)", r === "GET https://example.com/after-restore", r);
  check("project files survive the snapshot", dec.decode(await vm2.read_file("/root/project/g.txt")).trim() === "from-guest");
  await vm2.stop();
}

console.log(`done in ${elapsed()}`);
process.exit();
