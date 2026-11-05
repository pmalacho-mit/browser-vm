// Builds the playgrounds in playgrounds/ (see playgrounds/README.md): for each
// one, a root filesystem, then a booted, warmed-up snapshot of it.
//
//   npm run playgrounds                    all of them, for the 32-bit VM
//   npm run playgrounds -- python-3.12     one
//
// Output, in build/playgrounds/ (npm run build ships the ones that match its
// emulator and kernel):
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
import { target } from "./targets.mjs";
import { attachFetchNetwork, loadTLS, writeGuestFile } from "../extension/src/net.ts";
import { GUEST_CMDLINE } from "../extension/src/guest-config.ts";
import { installBlobCache } from "../extension/src/blob-cache.ts";
import { AgentClient, installAgent } from "../extension/src/agent-client.ts";

const root = path.resolve(import.meta.dirname, "..");
const fromRoot = (/** @type {string[]} */ ...p) => path.join(root, ...p);
const vm = target(root);
if (!vm.agent) throw new Error(`playgrounds need the Go guest agent, which the ${vm.arch} VM doesn't have yet (see scripts/targets.mjs)`);
const OUT = fromRoot("build/playgrounds");
const POOL = path.join(OUT, "rootfs");
const TOOLS = path.join(OUT, "tools");
const WORK = path.join(OUT, "work");
const MIRROR = "https://dl-cdn.alpinelinux.org/alpine";
const GUEST_APK_ARCH = { i686: "x86", x86_64: "x86_64" }[vm.arch];
const HOST_APK_ARCH = { x64: "x86_64", arm64: "aarch64", ia32: "x86", arm: "armv7" }[process.arch];
if (!GUEST_APK_ARCH || !HOST_APK_ARCH) throw new Error(`unsupported architecture (VM ${vm.arch}, host ${process.arch})`);

const log = (/** @type {string} */ s) => console.log(`[playgrounds] ${s}`);
const sha256 = (/** @type {Uint8Array} */ b) => crypto.createHash("sha256").update(b).digest("hex");
/** Short id of a file's contents: snapshots only restore on the same emulator and kernel. */
export const fileId = (/** @type {string} */ p) => sha256(fs.readFileSync(p)).slice(0, 16);

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
  // What guest/Dockerfile adds to every image, plus the playground's project.
  for (const f of ["vm-init", "vm-agent"]) {
    fs.copyFileSync(fromRoot("guest", f), path.join(rootDir, "sbin", f));
    fs.chmodSync(path.join(rootDir, "sbin", f), 0o755);
  }
  copyTree(fromRoot("guest/overlay"), rootDir);
  fs.rmSync(path.join(rootDir, "root/project"), { recursive: true, force: true });
  copyTree(fromRoot("playgrounds", id, "template"), path.join(rootDir, "root/project"));
  const tar = path.join(dir, "rootfs.tar");
  run("tar", ["-C", rootDir, "--owner=0", "--group=0", "--numeric-owner", "-cf", tar, ...fs.readdirSync(rootDir)]);
  return tar;
}

/** Step 2: index the tar into the shared blob pool. */
function index(/** @type {string} */ id, /** @type {string} */ tar) {
  fs.mkdirSync(path.join(OUT, id), { recursive: true });
  fs.mkdirSync(POOL, { recursive: true });
  run("python3", ["-I", fromRoot("tools/fs2json.py"), "--zstd", "--out", path.join(OUT, id, "fs.json"), tar]);
  run("python3", ["-I", fromRoot("tools/copy-to-sha256.py"), "--zstd", tar, POOL]);
}

/** Step 3: boot it, warm it up, and save it. */
async function snapshot(/** @type {string} */ id, /** @type {Manifest} */ m) {
  /** @type {{ V86: typeof import("v86").V86 }} */
  const { V86 } = await import(pathToFileURL(vm.lib).href);
  const tls = await loadTLS(pick("build/tls/tls.wasm", "tls/prebuilt/tls.wasm"), async (p) => new Response(fs.readFileSync(p)));
  const emulator = new V86({
    wasm_path: vm.wasm,
    bios: { url: fromRoot("vendor/seabios.bin") }, vga_bios: { url: fromRoot("vendor/vgabios.bin") },
    bzimage: { url: vm.kernel }, cmdline: GUEST_CMDLINE,
    filesystem: { basefs: path.join(OUT, id, "fs.json"), baseurl: POOL + "/" },
    // The browser restores it with these same devices (extension/src/vm.ts).
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
    await installAgent(emulator.fs9p, new Uint8Array(fs.readFileSync(/** @type {string} */ (vm.agent))));
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
  const versions = (await sh("apk info -v 2>/dev/null | sort")).text.trim().split("\n");
  // Leave nothing tab-specific behind; clear the consoles so a restored terminal starts clean.
  await sh("rm -rf /tmp/* /root/.ash_history; sync");
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
    state: "state.bin.zst", stateBytes: zst.length,
    emulator: fileId(vm.wasm), kernel: fileId(vm.kernel), agent: fileId(/** @type {string} */ (vm.agent)),
    warmupMs: warmMs, built: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(OUT, id, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
}

/** The first of these paths (relative to the repo) that exists. */
function pick(/** @type {string[]} */ ...c) {
  const found = c.map((p) => fromRoot(p)).find((p) => fs.existsSync(p));
  if (!found) throw new Error(`none of these exist: ${c.join(", ")}`);
  return found;
}

/**
 * @typedef {{ title: string, description: string, alpine: string, packages: string[],
 *             warmup?: string[], memoryMB: number, open?: string[] }} Manifest
 * @typedef {{ id: string, title: string, description: string, arch: string, alpine: string,
 *             packages: string[], memoryMB: number, open: string[], state: string, stateBytes: number,
 *             emulator: string, kernel: string, agent: string, warmupMs: number[], built: string }} PlaygroundManifest
 */

// ---- main ---------------------------------------------------------------------------
const all = fs.readdirSync(fromRoot("playgrounds")).filter((d) => fs.existsSync(fromRoot("playgrounds", d, "playground.json")));
const wanted = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const ids = wanted.length ? wanted : all;
for (const id of ids) if (!all.includes(id)) throw new Error(`no playground "${id}" (have: ${all.join(", ")})`);
log(`building ${ids.join(", ")} for ${vm.arch} (kernel ${path.relative(root, vm.kernel)})`);
for (const id of ids) {
  const t0 = Date.now();
  /** @type {Manifest} */
  const m = JSON.parse(fs.readFileSync(fromRoot("playgrounds", id, "playground.json"), "utf8"));
  const tar = await assemble(id, m);
  index(id, tar);
  fs.rmSync(path.join(WORK, id), { recursive: true, force: true });
  await snapshot(id, m);
  log(`${id}: done in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}
process.exit(0);
