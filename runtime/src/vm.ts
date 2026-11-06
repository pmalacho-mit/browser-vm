// Boots the guest with v86 and exposes its three channels:
//   - fs9p      : the guest's root filesystem, a JS object (virtio-9p server side)
//   - consoles  : ttyS0 / ttyS2 / ttyS3, byte streams for terminals
//   - agent     : the control plane, /sbin/vm-agent on ttyS1 (agent-client.ts)
//
// It either boots the kernel (cold boot) or restores a snapshot, e.g. a
// playground (images/builder/), and then brings the restored VM up to date
// with this tab (agent "refresh": clock, randomness, CA).
//
// The guest's network goes through the Gate it is given (gate.ts), and nowhere else.
/// <reference path="../types/v86-internals.d.ts" />
/// <reference path="../types/build-defines.d.ts" />
import { V86, type V86Filesystem } from "v86";
import type { Gate, GateNotice, SecretPlaceholder } from "./gate.ts";
import { attachFetchNetwork, loadTLS, writeGuestFile, type FetchLike, type GuestError } from "./net.ts";
import { installBlobCache, type BlobCacheStats } from "./blob-cache.ts";
import { DEFAULT_FILE_CACHE_MB, GUEST_CMDLINE, QUIET_LOGLEVEL } from "./guest-config.ts";
import { AgentClient, freshSeed, installAgent, type AgentReply, type AgentRequest, type ExecResult } from "./agent-client.ts";

export const CONSOLE_PORTS = [0, 2, 3];
const AGENT_PORT = 1;

export type VmState = "starting" | "booting" | "running";

export interface LinuxVMOptions {
  /** URL of the VM folder: the machine (v86.wasm, BIOS, bzImage), the image (fs.json, rootfs/) and tls.wasm. */
  assetBase: string;
  memoryMB: number;
  extraCmdline: string;
  /** Memory budget for cached file contents, in MiB (default DEFAULT_FILE_CACHE_MB). */
  fileCacheMB?: number;
  log: (s: string) => void;
  network?: "fetch" | "off";
  /** The guest's only way out (gate.ts). None: the guest has no network. */
  gate?: Gate;
  /** A request needed a secret while the gate was locked. */
  onRefused?: (host: string, code: "locked") => void;
  onNotice?: (n: GateNotice) => void;
  /**
   * Restore this saved state instead of booting. `memoryMB` must be the size the
   * snapshot was taken with; the root filesystem comes from the state, and
   * unchanged files from `${assetBase}/rootfs/`.
   */
  snapshot?: { url: string };
}

type PortListener = (bytes: Uint8Array) => void;

export class LinuxVM {
  opts: LinuxVMOptions;
  emulator!: V86;
  fs!: V86Filesystem;
  /** File-content cache counters (see blob-cache.ts), once the emulator has loaded. */
  blobCache?: BlobCacheStats;
  listeners = new Map<number, Set<PortListener>>();
  agent: AgentClient;
  state: VmState = "starting";
  onState: (s: VmState) => void = () => {};
  /** Resolves when the guest agent reports ready (a shell can be used). */
  ready: Promise<void>;
  /** Resolves with the filesystem as soon as the image index is loaded, before boot. */
  fsReady: Promise<V86Filesystem>;
  _resolveReady!: () => void;
  _resolveFs!: (fs: V86Filesystem) => void;

  constructor(opts: LinuxVMOptions) {
    this.opts = opts;
    this.agent = new AgentClient((line) => this.send(AGENT_PORT, line + "\n"));
    this.ready = new Promise((res) => (this._resolveReady = res));
    this.fsReady = new Promise((res) => (this._resolveFs = res));
  }

  start() {
    const { assetBase: base, memoryMB, extraCmdline } = this.opts;

    // Workaround: v86 schedules itself with a tiny blob: Worker and revokes the
    // blob URL right after `new Worker(url)`. Inside VS Code's extension host,
    // Worker is wrapped (the nested worker does importScripts(url) later), so
    // the URL must outlive the constructor call. Defer revocation.
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = (url) => { setTimeout(() => revoke(url), 60_000); };

    const t0 = Date.now();
    const net = (this.opts.network ?? "fetch") === "fetch";
    const snapshot = this.opts.snapshot;
    // Set by the build (tools/, from machines/index.mjs); unbundled (Node), the default machine.
    const machine = typeof __VM_MACHINE__ !== "undefined" ? __VM_MACHINE__ : { arch: "i686" };
    const arch = machine.arch;
    this.opts.log(`[vm] ${snapshot ? `restoring ${snapshot.url}` : "booting"} (${arch}): ${memoryMB} MiB RAM, network ${net ? "fetch()" : "off"}, assets from ${base}`);
    // The Go agent (runtime/guest/agent), written into the guest before a cold boot.
    // A snapshot already has its agent running, so it isn't needed then.
    const agentP = snapshot ? null : fetch(`${base}/vm-agent`)
      .then(async (r) => (r.ok ? new Uint8Array(await r.arrayBuffer()) : null))
      .catch(() => null);
    // The TLS terminator downloads in parallel with the rest of the VM.
    const tlsP = net ? loadTLS(`${base}/tls.wasm`).catch((e) => {
      this.opts.log(`[net] tls.wasm failed to load, HTTPS disabled: ${e.message}`);
      return null;
    }) : null;

    this.emulator = new V86({
      wasm_path: `${base}/v86.wasm`,
      bios: { url: `${base}/seabios.bin` },
      vga_bios: { url: `${base}/vgabios.bin` },
      ...(snapshot
        ? {
          // RAM, CPU, devices and the filesystem's inode table come from the
          // state; unchanged files are still fetched from rootfs/ by hash.
          initial_state: { url: snapshot.url },
          filesystem: { baseurl: `${base}/rootfs/` },
          // Keep the guest's NIC address: its network config was made for it.
          preserve_mac_from_state_image: true,
        }
        : {
          bzimage: { url: `${base}/bzImage` },
          // The root filesystem: a JSON index + content-addressed (sha256) blobs
          // fetched lazily over HTTP the first time the guest reads each file.
          filesystem: { basefs: `${base}/fs.json`, baseurl: `${base}/rootfs/` },
          // See guest-config.ts (9p root with cache=mmap).
          cmdline: [GUEST_CMDLINE, QUIET_LOGLEVEL, extraCmdline].join(" "),
        }),
      memory_size: memoryMB * 1024 * 1024,
      vga_memory_size: 2 * 1024 * 1024,
      uart1: true, uart2: true, uart3: true,
      // A virtio NIC on v86's fake network stack (ARP/DNS/TCP in JS, no server).
      // A snapshot has a NIC in its device state, so a restore needs one too:
      // with the network off, it stays unplugged (no relay).
      ...((net || snapshot) && { net_device: { type: "virtio", ...(net && { relay_url: "fetch" }) } }),
      // Started below, once the agent and the CA certificate are in place.
      autostart: false,
      disable_keyboard: true, disable_mouse: true, disable_speaker: true,
    });

    this.emulator.add_listener("emulator-loaded", async () => {
      this.opts.log(`[vm] emulator + filesystem index loaded (${Date.now() - t0} ms)`);
      this.fs = this.emulator.fs9p;
      // Keep file contents cached after the guest closes them, and keep the
      // downloaded blobs across visits (Cache Storage; blob names are hashes).
      this.blobCache = installBlobCache(this.fs, {
        maxBytes: (this.opts.fileCacheMB ?? DEFAULT_FILE_CACHE_MB) * 1024 * 1024,
        persistentCache: "linux-vm-blobs",
        log: this.opts.log,
      });
      this._resolveFs(this.fs);
      this._setState("booting");
      const agent = await agentP;
      if (agent && await installAgent(this.fs, agent)) this.opts.log(`[vm] guest agent installed (${(agent.length / 1e6).toFixed(1)} MB)`);
      if (net) {
        const tls = await tlsP;
        if (tls) await writeGuestFile(this.fs, "/etc/ssl/certs/browser-vm-ca.pem", new TextEncoder().encode(tls.caPEM));
        attachFetchNetwork(this.emulator, { tls, log: this.opts.log, fetchImpl: this._guestFetch() });
        this.opts.log(`[net] fetch() network ready${tls ? " (HTTP + HTTPS)" : " (HTTP only)"} after ${Date.now() - t0} ms`);
      }
      this.emulator.run();
      if (snapshot) this._afterRestore(t0);
    });

    for (const port of [...CONSOLE_PORTS, AGENT_PORT]) {
      this.listeners.set(port, new Set());
      this._bufferPort(port);
    }

    this.onPort(AGENT_PORT, (bytes) => this.agent.feed(bytes));
    this.agent.onReady = ({ kernel, protocol }) => {
      this.opts.log(`[vm] guest agent ready (${protocol ? `protocol ${protocol}` : "shell fallback"}), kernel ${kernel} (boot took ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
      this._markRunning();
    };
  }

  /**
   * A restored VM is a copy of one that ran elsewhere: same clock, same entropy
   * pool, and the CA of the tab that built it. The agent fixes all three.
   */
  async _afterRestore(t0: number) {
    this.agent.assume(2); // snapshots are built with the Go agent (images/builder/build-playgrounds.mjs)
    const r = await Promise.race([
      this.agent.request({ cmd: "refresh", seed: freshSeed(), timeMs: Date.now() }),
      new Promise<AgentReply>((res) => setTimeout(() => res({ ok: false, error: "no answer in 10 s" }), 10_000)),
    ]);
    if (r.ok) this.opts.log(`[vm] restored in ${((Date.now() - t0) / 1000).toFixed(1)} s; clock ${r.clock}, CA replaced: ${r.caReplaced}`);
    else this.opts.log(`[vm] restored, but the agent couldn't refresh it: ${r.error}`);
    this._markRunning();
  }

  _markRunning() {
    if (this.state === "running") return;
    this._setState("running");
    this._resolveReady();
  }

  // v86 emits one event per byte; coalesce into chunks so the terminal
  // renderer isn't called thousands of times per second.
  _bufferPort(port: number) {
    let chunk: number[] = [], scheduled = false;
    const event = `serial${port}-output-byte` as "serial0-output-byte"; // ports 0-3 all exist
    this.emulator.add_listener(event, (byte) => {
      chunk.push(byte);
      if (!scheduled) {
        scheduled = true;
        setTimeout(() => {
          const bytes = Uint8Array.from(chunk);
          chunk = []; scheduled = false;
          for (const l of this.listeners.get(port) ?? []) l(bytes);
        }, 4);
      }
    });
  }

  /** Every guest request goes to the gate (gate.ts); without one, each is refused. */
  _guestFetch(): FetchLike {
    const gate = this.opts.gate;
    if (!gate) return () => Promise.reject(Object.assign(new Error("no network gate"), { guestMessage: "This VM has no network gate, so it has no network.\n" }));
    gate.connect?.({
      notice: (n) => this.opts.onNotice?.(n),
      secrets: (list) => this._writeSecretPlaceholders(list),
    });
    return async (url, init) => {
      try { return await gate.fetch(url, init); }
      catch (e) { if ((e as GuestError).code === "locked") this.opts.onRefused?.(new URL(url).hostname, "locked"); throw e; }
    };
  }

  /** Secret NAMES only (never values): exported in the guest's shells so code can use them. */
  _writeSecretPlaceholders(list: SecretPlaceholder[]) {
    const sh = "# Written by the runtime from the network gate's secret list. These are PLACEHOLDERS:\n" +
      "# the gate substitutes real values on the way out, only toward each secret's hosts.\n" +
      list.map(({ name, env }) => `export ${env}='${name}'`).join("\n") + "\n";
    writeGuestFile(this.fs, "/etc/profile.d/gate-secrets.sh", new TextEncoder().encode(sh))
      .then(() => this.opts.log(`[gate] secrets available in the VM: ${list.map((x) => "$" + x.env).join(" ") || "none"}`))
      .catch((e) => this.opts.log(`[gate] could not write secret placeholders: ${e.message}`));
  }

  _setState(s: VmState) { this.state = s; this.onState(s); }

  onPort(port: number, fn: PortListener) {
    const set = this.listeners.get(port);
    if (!set) throw new Error(`no such serial port: ${port}`);
    set.add(fn);
    return { dispose: () => { set.delete(fn); } };
  }

  send(port: number, data: string | Uint8Array) {
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    this.emulator.serial_send_bytes(port, bytes);
  }

  /** Calls the guest agent once it's ready, e.g. rpc({ cmd: "resize", tty: "ttyS0", rows: 40, cols: 120 }). */
  async rpc(req: AgentRequest): Promise<AgentReply> {
    await this.ready;
    return this.agent.request(req);
  }

  /** Runs a program in the guest and waits for it (see AgentClient.exec). */
  async exec(argv: string[], o?: Parameters<AgentClient["exec"]>[1]): Promise<ExecResult> {
    await this.ready;
    return this.agent.exec(argv, o);
  }

  async destroy() {
    this.agent.close("the VM stopped");
    try { await this.emulator.destroy(); } catch {}
  }
}
