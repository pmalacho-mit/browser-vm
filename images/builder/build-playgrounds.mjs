// Builds the playgrounds in images/playgrounds/ (see its README.md): for each
// one, a root filesystem, then a booted, warmed-up snapshot of it.
//
//   npm run playgrounds                    all of them, for the i686 machine
//   npm run playgrounds -- python-3.12     one
//
// Output, in build/playgrounds/ (an app build ships the ones that match its machine:
// emulator and kernel; tools/lib/app.mjs):
//   rootfs/<hash>.bin.zst     file contents, shared by every playground (and by
//                             the default image): content-addressed, so a file
//                             two playgrounds share is stored once
//   <id>/fs.json              the playground's file index
//   <id>/state.bin.zst        the snapshot: RAM, CPU, devices and the inode table
//   <id>/manifest.json        what the site needs to restore it
//
// The root filesystem is assembled without Docker and without running any x86
// code on the host: Alpine's minirootfs plus packages installed by Alpine's own
// static apk for the host's architecture (--no-scripts). The packages'
// install scripts then run inside the VM, during the warm-up. This works on any
// Linux host, including ARM (roadmap F3). Needs: tar, python3 with zstandard.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { bootTarget, fileId, PLAYGROUNDS_BUILD } from "../index.mjs";
import { guestFiles } from "@browser-vm/runtime/assets";
import { attachFetchNetwork, loadTLS, writeGuestFile } from "@browser-vm/runtime/internals/net";
import { GUEST_CMDLINE } from "@browser-vm/runtime/internals/guest-config";
import { installBlobCache } from "@browser-vm/runtime/internals/blob-cache";
import { AgentClient, installAgent } from "@browser-vm/runtime/internals/agent-client";
import { PreviewGateway } from "@browser-vm/runtime/internals/preview";

const images = path.resolve(import.meta.dirname, "..");
const vm = bootTarget(); // --arch= / $VM_ARCH: the machine, the base image and the runtime's files for it
const OUT = PLAYGROUNDS_BUILD;
const POOL = path.join(OUT, "rootfs");
const TOOLS = path.join(OUT, "tools");
const WORK = path.join(OUT, "work");
const MIRROR = "https://dl-cdn.alpinelinux.org/alpine";
const GUEST_APK_ARCH = { i686: "x86", x86_64: "x86_64" }[vm.arch];
const HOST_APK_ARCH = { x64: "x86_64", arm64: "aarch64", ia32: "x86", arm: "armv7" }[process.arch];
if (!GUEST_APK_ARCH || !HOST_APK_ARCH) throw new Error(`unsupported architecture (VM ${vm.arch}, host ${process.arch})`);

const log = (/** @type {string} */ s) => console.log(`[playgrounds] ${s}`);
const sha256 = (/** @type {Uint8Array} */ b) => crypto.createHash("sha256").update(b).digest("hex");

/** @param {string} cmd @param {string[]} args @param {import("node:child_process").SpawnSyncOptions} [o] */
function run(cmd, args, o = {}) {
  const r = spawnSync(cmd, args, { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 26, ...o });
  if (r.status !== 0) throw new Error(`${cmd} ${args.slice(0, 4).join(" ")} … failed (${r.status}): ${String(r.stderr).slice(-2000)}`);
  return String(r.stdout);
}

async function download(/** @type {string} */ url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

/** Reads one file out of a (gzip-compressed) tar archive in memory. */
function tarEntry(/** @type {Uint8Array} */ tgz, /** @type {string} */ name) {
  const tar = zlib.gunzipSync(tgz);
  for (let off = 0; off + 512 <= tar.length;) {
    const header = tar.subarray(off, off + 512);
    const entry = new TextDecoder().decode(header.subarray(0, 100)).replace(/\0.*$/s, "");
    if (!entry) break;
    const size = parseInt(new TextDecoder().decode(header.subarray(124, 136)).replace(/\0.*$/s, "").trim() || "0", 8);
    if (entry === name) return tar.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error(`${name} not found in archive`);
}

/** Package → version, from a repository's APKINDEX. */
async function apkIndex(/** @type {string} */ release, /** @type {string} */ repo, /** @type {string} */ arch) {
  const text = new TextDecoder().decode(tarEntry(await download(`${MIRROR}/v${release}/${repo}/${arch}/APKINDEX.tar.gz`), "APKINDEX"));
  /** @type {Map<string, string>} */
  const versions = new Map();
  for (const block of text.split("\n\n")) {
    const p = block.match(/^P:(.+)$/m)?.[1], v = block.match(/^V:(.+)$/m)?.[1];
    if (p && v) versions.set(p, v);
  }
  return versions;
}

/** Alpine's static apk for this host, cached in build/playgrounds/tools. */
async function apkStatic(/** @type {string} */ release) {
  const dir = path.join(TOOLS, `apk-tools-static-${release}-${HOST_APK_ARCH}`);
  const bin = path.join(dir, "sbin/apk.static");
  if (fs.existsSync(bin)) return bin;
  const version = (await apkIndex(release, "main", HOST_APK_ARCH)).get("apk-tools-static");
  if (!version) throw new Error(`no apk-tools-static in Alpine ${release} for ${HOST_APK_ARCH}`);
  const file = path.join(TOOLS, `apk-tools-static-${version}-${HOST_APK_ARCH}.apk`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, await download(`${MIRROR}/v${release}/main/${HOST_APK_ARCH}/apk-tools-static-${version}.apk`));
  // An .apk is concatenated gzip streams (signature, control, data); tar reads through them.
  spawnSync("tar", ["-xzf", file, "-C", dir], { stdio: "ignore" });
  if (!fs.existsSync(bin)) throw new Error(`could not unpack ${file}`);
  log(`apk.static ${version} (${HOST_APK_ARCH})`);
  return bin;
}

/** Alpine's minirootfs for the guest, checked against the release's published SHA-256. */
async function minirootfs(/** @type {string} */ release) {
  const yaml = new TextDecoder().decode(await download(`${MIRROR}/v${release}/releases/${GUEST_APK_ARCH}/latest-releases.yaml`));
  const block = yaml.split(/\n-\s*\n/).find((b) => /flavor:\s*alpine-minirootfs/.test(b));
  const file = block?.match(/file:\s*(\S+)/)?.[1], expected = block?.match(/sha256:\s*([0-9a-f]{64})/)?.[1];
  if (!file || !expected) throw new Error(`no minirootfs in Alpine ${release} for ${GUEST_APK_ARCH}`);
  const cached = path.join(TOOLS, file);
  if (!fs.existsSync(cached)) {
    const bytes = await download(`${MIRROR}/v${release}/releases/${GUEST_APK_ARCH}/${file}`);
    if (sha256(bytes) !== expected) throw new Error(`${file}: SHA-256 mismatch`);
    fs.mkdirSync(TOOLS, { recursive: true });
    fs.writeFileSync(cached, bytes);
  }
  return cached;
}

/** Copies a directory tree, as cp -r does. */
const copyTree = (/** @type {string} */ from, /** @type {string} */ to) => fs.cpSync(from, to, { recursive: true });

/** Step 1: the root filesystem, as a tar (no "./" prefixes: fs2json would nest everything under "."). */
async function assemble(/** @type {string} */ id, /** @type {Manifest} */ m) {
  const dir = path.join(WORK, id), rootDir = path.join(dir, "root");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(rootDir, { recursive: true });
  run("tar", ["-xzf", await minirootfs(m.alpine), "-C", rootDir]);
  const repos = path.join(rootDir, "etc/apk/repositories");
  fs.writeFileSync(repos, ["main", "community"].map((r) => `${MIRROR}/v${m.alpine}/${r}`).join("\n") + "\n");
  run(await apkStatic(m.alpine), ["--root", rootDir, "--arch", GUEST_APK_ARCH, "--usermode", "--no-scripts", "--no-cache",
    "--keys-dir", path.join(rootDir, "etc/apk/keys"), "--repositories-file", repos, "add", ...m.packages]);
  fs.rmSync(path.join(rootDir, "var/cache/apk"), { recursive: true, force: true });
  // What the base image's Dockerfile adds to every image (the runtime's guest
  // half, the shell profile and CA settings), plus the playground's project.
  for (const [f, from] of [["vm-init", guestFiles.init], ["vm-agent", guestFiles.shellAgent]]) {
    fs.copyFileSync(from, path.join(rootDir, "sbin", f));
    fs.chmodSync(path.join(rootDir, "sbin", f), 0o755);
  }
  copyTree(path.join(images, "base/overlay"), rootDir);
  fs.rmSync(path.join(rootDir, "root/project"), { recursive: true, force: true });
  copyTree(path.join(images, "playgrounds", id, "template"), path.join(rootDir, "root/project"));
  if (m.npm) {
    // npm packages for the guest's platform, installed on the host: much faster
    // than npm in the emulator, and it needs no x86 code here. Install scripts
    // are skipped (they would run for the host); the packages that matter for
    // a playground pick their platform binaries at run time.
    const cpu = { i686: "ia32", x86_64: "x64" }[vm.arch];
    run("npm", ["ci", "--os=linux", `--cpu=${cpu}`, "--libc=musl", "--ignore-scripts", "--no-audit", "--no-fund"],
      { cwd: path.join(rootDir, "root/project") });
    log(`${id}: npm ci for linux-${cpu}-musl`);
  }
  const tar = path.join(dir, "rootfs.tar");
  run("tar", ["-C", rootDir, "--owner=0", "--group=0", "--numeric-owner", "-cf", tar, ...fs.readdirSync(rootDir)]);
  return tar;
}

/** Step 2: index the tar into the shared blob pool. */
function index(/** @type {string} */ id, /** @type {string} */ tar) {
  fs.mkdirSync(path.join(OUT, id), { recursive: true });
  fs.mkdirSync(POOL, { recursive: true });
  run("python3", ["-I", path.join(images, "builder/fs2json.py"), "--zstd", "--out", path.join(OUT, id, "fs.json"), tar]);
  run("python3", ["-I", path.join(images, "builder/copy-to-sha256.py"), "--zstd", tar, POOL]);
}

/** Step 3: boot it, warm it up, and save it. */
async function snapshot(/** @type {string} */ id, /** @type {Manifest} */ m) {
  /** @type {{ V86: typeof import("v86").V86 }} */
  const { V86 } = await import(pathToFileURL(vm.lib).href);
  const tls = await loadTLS(vm.tls, async (p) => new Response(fs.readFileSync(p)));
  const emulator = new V86({
    wasm_path: vm.wasm,
    bios: { url: vm.firmware.seabios }, vga_bios: { url: vm.firmware.vgabios },
    bzimage: { url: vm.kernel }, cmdline: GUEST_CMDLINE,
    filesystem: { basefs: path.join(OUT, id, "fs.json"), baseurl: POOL + "/" },
    // The browser restores it with these same devices (runtime/src/vm.ts).
    memory_size: m.memoryMB << 20, vga_memory_size: 2 << 20, uart1: true, uart2: true, uart3: true,
    net_device: { type: "virtio", relay_url: "fetch" },
    autostart: false, disable_keyboard: true, disable_mouse: true, disable_speaker: true,
  });
  const enc = new TextEncoder();
  const agent = new AgentClient((line) => emulator.serial_send_bytes(1, enc.encode(line + "\n")));
  emulator.add_listener("serial1-output-byte", (b) => agent.feed(Uint8Array.of(b)));
  const ready = new Promise((res) => (agent.onReady = res));
  emulator.add_listener("emulator-loaded", async () => {
    installBlobCache(emulator.fs9p, { maxBytes: 512 << 20 });
    await installAgent(emulator.fs9p, new Uint8Array(fs.readFileSync(vm.agent)));
    await writeGuestFile(emulator.fs9p, "/etc/ssl/certs/browser-vm-ca.pem", enc.encode(tls.caPEM));
    // At build time the guest reaches the network directly (no gate: no user secrets here).
    attachFetchNetwork(emulator, { tls, log: () => {}, fetchImpl: (url, init) => fetch(url, init) });
    emulator.run();
  });
  const t0 = Date.now();
  await Promise.race([ready, new Promise((_, rej) => setTimeout(() => rej(new Error("the guest agent didn't start")), 120_000))]);
  log(`${id}: booted in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

  const sh = async (/** @type {string} */ cmd, timeoutMs = 600_000) => {
    const r = await agent.exec(["sh", "-lc", cmd], { cwd: "/root/project", timeoutMs });
    const text = new TextDecoder().decode(r.stdout) + new TextDecoder().decode(r.stderr);
    if (r.code !== 0) throw new Error(`${id}: "${cmd}" exited with ${r.code}${r.timedOut ? " (timed out)" : ""}:\n${text.slice(-3000)}`);
    return { text, ms: r.ms };
  };
  // The install scripts apk skipped on the host (--no-scripts): busybox links,
  // the CA bundle, and whatever the packages need.
  await sh("set -e; d=$(mktemp -d); tar -xzf /lib/apk/db/scripts.tar.gz -C \"$d\" 2>/dev/null || true; " +
    "for f in \"$d\"/*.post-install; do [ -e \"$f\" ] && sh \"$f\" >/dev/null 2>&1 || true; done; " +
    "command -v update-ca-certificates >/dev/null && update-ca-certificates >/dev/null 2>&1 || true; rm -rf \"$d\"");
  const warmMs = [];
  for (const cmd of m.warmup ?? []) {
    const r = await sh(cmd);
    warmMs.push(r.ms);
    log(`${id}: ${cmd}  (${(r.ms / 1000).toFixed(1)} s)  ${r.text.trim().split("\n").pop()?.slice(0, 100) ?? ""}`);
  }
  if (m.server) {
    // Start the dev server and let it do its slow first work (dependency
    // scanning, first transforms) now, so the snapshot has it ready.
    const { command, port, warm = ["/"] } = m.server;
    await sh(`setsid sh -c ${JSON.stringify(`cd /root/project && exec ${command}`)} > /var/log/dev-server.log 2>&1 < /dev/null &`);
    const t = Date.now();
    for (;;) {
      const r = await agent.request({ cmd: "ports" });
      if (r.ok && (/** @type {number[]} */ (r.ports)).includes(port)) break;
      if (Date.now() - t > 600_000) throw new Error(`${id}: the server didn't listen on ${port}:\n${(await sh("tail -30 /var/log/dev-server.log")).text}`);
      await new Promise((res) => setTimeout(res, 500));
    }
    log(`${id}: ${command} listening on ${port} (${((Date.now() - t) / 1000).toFixed(1)} s)`);
    // Fetch what a browser would: the pages, then every module their code
    // imports, as the dev server rewrote them (so the URLs match exactly). Each
    // first request makes the server transform that file; the snapshot keeps
    // the results. Requests come in over the fake network, as previews do.
    const gw = new PreviewGateway(/** @type {any} */ ({ emulator }), port);
    const queue = [...warm], seen = new Set(queue), tries = new Map();
    const tc = Date.now();
    let bytes = 0;
    while (queue.length && seen.size < 2000) {
      const p = /** @type {string} */ (queue.shift());
      const t1 = Date.now();
      const r = await gw.http({ method: "GET", path: p, headers: [["accept", "*/*"]] }).catch((e) => ({ status: 0, headers: [], body: new Uint8Array(), error: e.message }));
      bytes += r.body.length;
      if (Date.now() - t1 > 3000) log(`${id}: GET ${p}  ${r.status} (${((Date.now() - t1) / 1000).toFixed(1)} s)`);
      // A first server render can outlast the gateway's timeout; the server
      // finishes it anyway, and the next try is quick.
      if (r.status === 0 && (tries.get(p) ?? 0) < 2) { tries.set(p, (tries.get(p) ?? 0) + 1); queue.push(p); continue; }
      const type = r.headers.find(([k]) => k === "content-type")?.[1] ?? "";
      if (r.status !== 200 || !/javascript|html/.test(type)) continue;
      const text = new TextDecoder().decode(r.body);
      const found = [...text.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*|<script[^>]*\bsrc=|<link[^>]*\bhref=)["'](\/[^"'\s]+)["']/g)].map((m) => m[1]);
      for (const f of found) if (!seen.has(f) && !f.startsWith("//")) { seen.add(f); queue.push(f); }
    }
    warmMs.push(Date.now() - tc);
    log(`${id}: warmed ${seen.size} URLs, ${(bytes / 1e6).toFixed(1)} MB (${((Date.now() - tc) / 1000).toFixed(1)} s)`);
  }
  const versions = (await sh("apk info -v 2>/dev/null | sort")).text.trim().split("\n");
  // Leave nothing tab-specific behind; clear the consoles so a restored terminal starts clean.
  await sh("rm -rf /tmp/* /root/.ash_history; sync");
  // Smaller snapshots: drop caches nothing is using, then overwrite free RAM with
  // zeros (which compress to nothing). Freed pages otherwise keep whatever they
  // held, and the snapshot stores all of RAM. Running programs keep their pages.
  const zeroed = await sh("echo 3 > /proc/sys/vm/drop_caches; " +
    "mb=$(( $(awk '/MemFree/ {print $2}' /proc/meminfo) / 1024 - 32 )); [ $mb -gt 0 ] || exit 0; " +
    "mkdir -p /run/zero && mount -t tmpfs -o size=${mb}m tmpfs /run/zero && " +
    "dd if=/dev/zero of=/run/zero/z bs=1M count=$mb 2>/dev/null; rm -f /run/zero/z; umount /run/zero; rmdir /run/zero; echo $mb");
  log(`${id}: zeroed ${zeroed.text.trim() || 0} MB of free RAM (${(zeroed.ms / 1000).toFixed(1)} s)`);
  for (const port of [0, 2, 3]) emulator.serial_send_bytes(port, enc.encode("clear\n"));
  await new Promise((res) => setTimeout(res, 1500));

  const raw = new Uint8Array(await emulator.save_state());
  await emulator.stop();
  agent.close("snapshot taken");
  const zst = zlib.zstdCompressSync(raw, { params: { [zlib.constants.ZSTD_c_compressionLevel]: 19 } });
  fs.writeFileSync(path.join(OUT, id, "state.bin.zst"), zst);
  log(`${id}: snapshot ${(raw.length / 1e6).toFixed(1)} MB → ${(zst.length / 1e6).toFixed(1)} MB (zstd -19)`);

  /** @type {PlaygroundManifest} */
  const manifest = {
    id, title: m.title, description: m.description, arch: vm.arch, alpine: m.alpine,
    packages: versions.filter((v) => m.packages.some((p) => v.startsWith(p + "-"))),
    memoryMB: m.memoryMB, open: m.open ?? [],
    ...(m.server && { server: { port: m.server.port, log: "/var/log/dev-server.log" } }),
    state: "state.bin.zst", stateBytes: zst.length,
    emulator: fileId(vm.wasm), kernel: fileId(vm.kernel), agent: fileId(vm.agent),
    warmupMs: warmMs, built: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(OUT, id, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
}

/**
 * @typedef {{ title: string, description: string, alpine: string, packages: string[],
 *             warmup?: string[], memoryMB: number, open?: string[], npm?: boolean,
 *             server?: { command: string, port: number, warm?: string[] } }} Manifest
 * @typedef {{ id: string, title: string, description: string, arch: string, alpine: string,
 *             packages: string[], memoryMB: number, open: string[], state: string, stateBytes: number,
 *             emulator: string, kernel: string, agent: string, warmupMs: number[], built: string,
 *             server?: { port: number, log: string } }} PlaygroundManifest
 */

// ---- main ---------------------------------------------------------------------------
const all = fs.readdirSync(path.join(images, "playgrounds")).filter((d) => fs.existsSync(path.join(images, "playgrounds", d, "playground.json")));
const wanted = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const ids = wanted.length ? wanted : all;
for (const id of ids) if (!all.includes(id)) throw new Error(`no playground "${id}" (have: ${all.join(", ")})`);
log(`building ${ids.join(", ")} for ${vm.arch} (kernel ${path.relative(process.cwd(), vm.kernel)})`);
for (const id of ids) {
  const t0 = Date.now();
  /** @type {Manifest} */
  const m = JSON.parse(fs.readFileSync(path.join(images, "playgrounds", id, "playground.json"), "utf8"));
  const tar = await assemble(id, m);
  index(id, tar);
  fs.rmSync(path.join(WORK, id), { recursive: true, force: true });
  await snapshot(id, m);
  log(`${id}: done in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}
process.exit(0);
