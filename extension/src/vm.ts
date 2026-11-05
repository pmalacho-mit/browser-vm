// Boots the guest with v86 and exposes its three channels:
//   - fs9p      : the guest's root filesystem, a JS object (virtio-9p server side)
//   - consoles  : ttyS0 / ttyS2 / ttyS3, byte streams for terminals
//   - agent     : line-based RPC with /sbin/vm-agent on ttyS1
import { V86, type V86Filesystem } from "v86";
import type { GateNotice } from "../../types/gate-protocol.ts";
import { attachFetchNetwork, loadTLS, writeGuestFile, type FetchLike, type GuestError } from "./net.ts";
import { GateClient } from "./gate-client.ts";

export const CONSOLE_PORTS = [0, 2, 3];
const AGENT_PORT = 1;

export type VmState = "starting" | "booting" | "running";

export interface LinuxVMOptions {
  /** URL of the folder holding v86.wasm, the BIOS, bzImage, fs.json, rootfs/ and tls.wasm. */
  assetBase: string;
  memoryMB: number;
  extraCmdline: string;
  log: (s: string) => void;
  network?: "fetch" | "off";
  /** BroadcastChannel name of the gate relay on the host page (web/gate-relay.ts). */
  gateChannel?: string;
  /** A request needed a secret while the gate was locked. */
  onRefused?: (host: string, code: "locked") => void;
  onNotice?: (n: GateNotice) => void;
}

/** A reply from the in-guest agent: `<id> ok|err [data]`. */
export interface RpcResult {
  ok: boolean;
  data: string;
}

type PortListener = (bytes: Uint8Array) => void;

export class LinuxVM {
  opts: LinuxVMOptions;
  emulator!: V86;
  fs!: V86Filesystem;
  gate?: GateClient;
  listeners = new Map<number, Set<PortListener>>();
  pending = new Map<string, (r: RpcResult) => void>(); // rpc id -> resolve
  nextId = 1;
  agentLine = "";
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
    const arch = typeof __VM_ARCH__ !== "undefined" ? __VM_ARCH__ : "i686"; // set by the build (scripts/targets.mjs)
    this.opts.log(`[vm] booting ${arch}: ${memoryMB} MiB RAM, network ${net ? "fetch()" : "off"}, assets from ${base}`);
    // The TLS terminator downloads in parallel with the rest of the VM.
    const tlsP = net ? loadTLS(`${base}/tls.wasm`).catch((e) => {
      this.opts.log(`[net] tls.wasm failed to load, HTTPS disabled: ${e.message}`);
      return null;
    }) : null;

    this.emulator = new V86({
      wasm_path: `${base}/v86.wasm`,
      bios: { url: `${base}/seabios.bin` },
      vga_bios: { url: `${base}/vgabios.bin` },
      bzimage: { url: `${base}/bzImage` },
      // The root filesystem: a JSON index + content-addressed (sha256) blobs
      // fetched lazily over HTTP the first time the guest reads each file.
      filesystem: { basefs: `${base}/fs.json`, baseurl: `${base}/rootfs/` },
      cmdline: [
        "console=ttyS0",
        "root=host9p rootfstype=9p rw",
        // cache=none: the guest page cache never goes stale when the editor
        // writes files from the JS side (measured: no slower than cache=loose).
        "rootflags=trans=virtio,cache=none",
        "init=/sbin/vm-init",
        "tsc=reliable quiet loglevel=3",
        extraCmdline,
      ].join(" "),
      memory_size: memoryMB * 1024 * 1024,
      vga_memory_size: 2 * 1024 * 1024,
      uart1: true, uart2: true, uart3: true,
      // A virtio NIC on v86's fake network stack (ARP/DNS/TCP in JS, no server).
      ...(net && { net_device: { type: "virtio", relay_url: "fetch" } }),
      // With networking, wait until the guest's CA certificate is in place.
      autostart: !net,
      disable_keyboard: true, disable_mouse: true, disable_speaker: true,
    });

    this.emulator.add_listener("emulator-loaded", async () => {
      this.opts.log(`[vm] emulator + filesystem index loaded (${Date.now() - t0} ms)`);
      this.fs = this.emulator.fs9p;
      this._resolveFs(this.fs);
      this._setState("booting");
      if (net) {
        const tls = await tlsP;
        if (tls) await writeGuestFile(this.fs, "/etc/ssl/certs/browser-vm-ca.pem", new TextEncoder().encode(tls.caPEM));
        attachFetchNetwork(this.emulator, { tls, log: this.opts.log, fetchImpl: this._gateFetch() });
        this.opts.log(`[net] fetch() network ready${tls ? " (HTTP + HTTPS)" : " (HTTP only)"} after ${Date.now() - t0} ms`);
        this.emulator.run();
      }
    });

    for (const port of [...CONSOLE_PORTS, AGENT_PORT]) {
      this.listeners.set(port, new Set());
      this._bufferPort(port);
    }

    this.onPort(AGENT_PORT, (bytes) => {
      this.agentLine += new TextDecoder().decode(bytes);
      let nl;
      while ((nl = this.agentLine.indexOf("\n")) >= 0) {
        const line = this.agentLine.slice(0, nl).replace(/\r$/, "");
        this.agentLine = this.agentLine.slice(nl + 1);
        this._onAgentLine(line, t0);
      }
    });
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

  _onAgentLine(line: string, t0: number) {
    const [id, status, ...rest] = line.split(" ");
    if (id === "0" && status === "ready") {
      this.opts.log(`[vm] guest agent ready, kernel ${rest.join(" ")} (boot took ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
      this._setState("running");
      this._resolveReady();
      return;
    }
    const resolve = this.pending.get(id);
    if (resolve) { this.pending.delete(id); resolve({ ok: status === "ok", data: rest.join(" ") }); }
  }

  /** All guest traffic goes through the network gate (web/gate/), which also owns the secrets. */
  _gateFetch(): FetchLike {
    if (!this.opts.gateChannel) return () => Promise.reject(Object.assign(new Error("no network gate"), { guestMessage: "This page has no network gate.\n" }));
    const gate = this.gate = new GateClient({
      channelName: this.opts.gateChannel,
      onNotice: (n) => this.opts.onNotice?.(n),
      // Secret NAMES only (never values): exported in the guest so code can use them.
      onSecrets: (list) => {
        const sh = "# Written by the IDE from the network gate's secret list. These are PLACEHOLDERS:\n" +
          "# the gate substitutes real values on the way out, only toward each secret's hosts.\n" +
          list.map(({ name, env }) => `export ${env}='${name}'`).join("\n") + "\n";
        writeGuestFile(this.fs, "/etc/profile.d/gate-secrets.sh", new TextEncoder().encode(sh))
          .then(() => this.opts.log(`[gate] secrets available in the VM: ${list.map((x) => "$" + x.env).join(" ") || "none"}`))
          .catch((e) => this.opts.log(`[gate] could not write secret placeholders: ${e.message}`));
      },
    });
    return async (url, init) => {
      try { return await gate.fetch(url, init); }
      catch (e) { if ((e as GuestError).code === "locked") this.opts.onRefused?.(new URL(url).hostname, "locked"); throw e; }
    };
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

  /** Call the in-guest agent: e.g. rpc("resize", "ttyS0", 40, 120) */
  async rpc(cmd: string, ...args: (string | number)[]): Promise<RpcResult> {
    await this.ready;
    const id = String(this.nextId++);
    const p = new Promise<RpcResult>((res) => this.pending.set(id, res));
    this.send(AGENT_PORT, `${id} ${cmd} ${args.join(" ")}\n`);
    return p;
  }

  async destroy() {
    try { await this.emulator.destroy(); } catch {}
  }
}
