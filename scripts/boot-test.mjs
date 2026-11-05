// Headless smoke test of the guest image — no browser, no VS Code.
// Boots the same kernel + rootfs with v86 under Node and exercises the bridges
// the extension relies on: serial consoles, the shared 9p filesystem and the
// fetch() network (with a stub fetch, so it needs no internet).
//   npm run test:boot   (npm run test:boot:x86_64 for the 64-bit VM)
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { attachFetchNetwork, loadTLS, writeGuestFile } from "../extension/src/net.ts";
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

const vm = new V86({
  wasm_path: vmTarget.wasm,
  bios: { url: path.join(root, "vendor/seabios.bin") },
  vga_bios: { url: path.join(root, "vendor/vgabios.bin") },
  bzimage: { url: vmTarget.kernel },
  filesystem: { basefs: path.join(guest, "fs.json"), baseurl: path.join(guest, "rootfs") + "/" },
  cmdline: "console=ttyS0 root=host9p rootfstype=9p rw rootflags=trans=virtio,cache=none init=/sbin/vm-init tsc=reliable quiet",
  memory_size: 256 << 20, uart1: true, uart2: true, uart3: true,
  net_device: { type: "virtio", relay_url: "fetch" },
  autostart: false, disable_keyboard: true, disable_mouse: true, disable_speaker: true,
});

// Stand-in for the browser's fetch(): echoes the request, refuses one host like CORS would.
const fetched = [];
const stubFetch = async (url, init) => {
  fetched.push({ url, ...init });
  if (new URL(url).hostname === "no-cors.example") throw new TypeError("Failed to fetch");
  const body = init.body ? new TextDecoder().decode(init.body) : "";
  return new Response(`${init.method} ${url} ${body}`.trim() + "\n", { status: 200, headers: { "content-type": "text/plain" } });
};
const netLog = [];
const tls = await loadTLS(pick("build/tls/tls.wasm", "tls/prebuilt/tls.wasm"),
  async (p) => new Response(fs.readFileSync(p)));
vm.add_listener("emulator-loaded", async () => {
  await writeGuestFile(vm.fs9p, "/etc/ssl/certs/browser-vm-ca.pem", new TextEncoder().encode(tls.caPEM));
  attachFetchNetwork(vm, { tls, log: (s) => netLog.push(s), fetchImpl: stubFetch });
  vm.run();
});

let out = "", agent = "";
vm.add_listener("serial0-output-byte", (b) => (out += String.fromCharCode(b)));
vm.add_listener("serial1-output-byte", (b) => (agent += String.fromCharCode(b)));
const until = (cond, what, ms = 120000) => /** @type {Promise<void>} */ (new Promise((res, rej) => {
  const s = Date.now(), iv = setInterval(() => {
    if (cond()) { clearInterval(iv); res(); }
    else if (Date.now() - s > ms) { clearInterval(iv); rej(new Error(`timeout: ${what}`)); }
  }, 50);
}));
const PROMPT = /\$ (\x1b\[6n)?$/;
const sh = async (cmd) => { out = ""; vm.serial0_send(cmd + "\n"); await until(() => PROMPT.test(out), cmd); return out.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").split("\r\n").slice(1, -1).join("\n"); };
const check = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); if (!ok) process.exitCode = 1; };

await until(() => agent.includes("0 ready"), "agent ready");
check("boot + agent ready on ttyS1", true, elapsed());
await until(() => PROMPT.test(out), "shell prompt");
check("shell prompt on ttyS0", true, elapsed());
check(`kernel is ${vmTarget.arch}`, (await sh("uname -m")) === vmTarget.arch);
check("userland", /Alpine/.test(await sh("cat /etc/os-release")));

// editor -> guest: write into the existing inode, exactly like the FileSystemProvider
const fs9p = vm.fs9p, id = fs9p.SearchPath("/root/project/hello.sh").id;
const buf = new TextEncoder().encode('#!/bin/sh\necho "written from JS"\n');
await fs9p.ChangeSize(id, buf.length); await fs9p.Write(id, 0, buf.length, buf);
check("JS write visible to guest", (await sh("./hello.sh")) === "written from JS");

// guest -> editor
await sh("echo from-guest > /root/project/g.txt");
const back = new TextDecoder().decode(await vm.read_file("/root/project/g.txt")).trim();
check("guest write visible to JS", back === "from-guest");

// control channel
vm.serial_send_bytes(1, new TextEncoder().encode("9 resize ttyS0 33 101\n"));
await until(() => agent.includes("9 ok"), "resize");
check("resize via agent", (await sh("stty size")) === "33 101");

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

console.log(`done in ${elapsed()}`);
vm.destroy();
process.exit();
