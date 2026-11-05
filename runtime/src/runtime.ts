// The VM runtime: one Linux VM and everything an editor needs from it, behind
// one API that works the same in-process (Node, tests) and over the protocol
// in rpc.ts (a surface talking to the runtime worker, host/runtime-frame/).
//
//   const rt = new Runtime({ gate, assets });   // or connect<Runtime>(endpoint).api
//   await rt.boot({ playground: "python-3.12" });
//   await rt.write("/root/project/x.py", bytes);
//   const t = await rt.openTerminal({ rows: 24, cols: 80 });  // data arrives as "term-data" events
//   const r = await rt.exec(["python3", "x.py"]);
//
// Events (emitted to every frontend): "state" VmState, "log" string,
// "fs" FsChange[], "term-data" { id, data }, "notice" GateNotice,
// "refused" { host }, "booted" BootResult.
import type { Gate, GateNotice } from "./gate.ts";
import { LinuxVM, CONSOLE_PORTS, type VmState } from "./vm.ts";
import { VmFs, type DirEntry, type FsChange, type SearchScope, type TextMatch, type TextQuery, type VmStat } from "./vmfs.ts";
import type { AgentReply, AgentRequest, ExecResult } from "./agent-client.ts";
import { PreviewGateway } from "./preview.ts";
import { portEndpoint, serve } from "./rpc.ts";

export interface BootOptions {
  /** URL (or, under Node, path) of the VM folder. Default: the one the Runtime was made with. */
  assetBase?: string;
  memoryMB?: number;
  extraCmdline?: string;
  fileCacheMB?: number;
  network?: "fetch" | "off";
  /** Restore this playground (assetBase/playgrounds/<id>/) instead of booting the default image. */
  playground?: string;
}

/** What boot() did. */
export interface BootResult {
  /** The playground restored, if any (an unknown id boots the default image instead). */
  playground?: {
    id: string; title: string; open: string[];
    /** A server the snapshot has running (a dev server), to open a preview of. */
    server?: { port: number; log: string };
  };
  /** Set when a playground was asked for but this site doesn't have it. */
  missingPlayground?: string;
}

export interface TerminalInfo {
  id: string;
  /** The guest's console device, e.g. "ttyS0". */
  tty: string;
}

/** A playground this build has (vm/playgrounds/index.json, written by tools/build.mjs). */
export interface PlaygroundInfo {
  id: string;
  title: string;
  description?: string;
  memoryMB: number;
  packages?: string[];
}

/** A playground's manifest.json (see images/builder/build-playgrounds.mjs). */
interface PlaygroundManifest {
  title: string;
  memoryMB: number;
  state: string;
  open?: string[];
  server?: { port: number; log: string };
}

export class Runtime {
  private vm?: LinuxVM;
  private vfs?: VmFs;
  private booted?: Promise<BootResult>;
  // Frontends may ask for files before their boot() call arrives (VS Code opens
  // the workspace folder right away): those calls wait for it.
  private bootCalled!: () => void;
  private bootStarted = new Promise<void>((res) => (this.bootCalled = res));
  private terminals = new Map<string, { port: number; dispose(): void }>();
  private nextTerminal = 1;
  /** Set by serve() (or by an in-process user) to send events. */
  emit: (topic: string, data: unknown) => void = () => {};
  private gate?: Gate;
  private assets?: string;

  /**
   * Set by whoever hosts the runtime (it can't cross the protocol):
   * `gate`, the guest's only way out (gate.ts; none: no network), and
   * `assets`, the VM folder (machine + images) when boot() names none.
   * In a browser that's the runtime frame (host/runtime-frame/worker.ts);
   * in Node, e.g. the MCP server (surfaces/mcp).
   */
  constructor(o: { gate?: Gate; assets?: string } = {}) {
    this.gate = o.gate;
    this.assets = o.assets?.replace(/\/+$/, "");
  }

  // ---- lifecycle -----------------------------------------------------------

  /** Starts the VM. Calls after the first return the first call's result. */
  boot(o: BootOptions): Promise<BootResult> {
    this.booted ??= this._boot(o);
    this.bootCalled();
    return this.booted;
  }

  private async _boot(o: BootOptions): Promise<BootResult> {
    const assetBase = o.assetBase?.replace(/\/+$/, "") ?? this.assets;
    if (!assetBase) throw new Error("boot(): no assetBase, and the runtime was made without one");
    const result: BootResult = {};
    let snapshot: { url: string } | undefined, memoryMB = o.memoryMB ?? 512;
    if (o.playground) {
      const base = `${assetBase}/playgrounds/${encodeURIComponent(o.playground)}`;
      const m = await fetch(`${base}/manifest.json`).then((r) => (r.ok ? r.json() as Promise<PlaygroundManifest> : undefined), () => undefined);
      if (m?.state) {
        snapshot = { url: `${base}/${m.state}` };
        memoryMB = m.memoryMB; // a snapshot restores only with the memory it was taken with
        result.playground = { id: o.playground, title: m.title, open: m.open ?? [], ...(m.server && { server: m.server }) };
      } else {
        result.missingPlayground = o.playground;
      }
    }
    const vm = this.vm = new LinuxVM({
      assetBase,
      memoryMB,
      extraCmdline: o.extraCmdline ?? "",
      fileCacheMB: o.fileCacheMB,
      network: o.network,
      gate: this.gate,
      snapshot,
      log: (s) => this.emit("log", s),
      onNotice: (n: GateNotice) => this.emit("notice", n),
      onRefused: (host) => this.emit("refused", { host }),
    });
    vm.onState = (s) => this.emit("state", s);
    this.vfs = new VmFs(vm.fsReady);
    this.vfs.watch((changes: FsChange[]) => this.emit("fs", changes));
    vm.start(); // (creates the console listeners)
    for (const port of CONSOLE_PORTS) this.consoleFor(port);
    this.emit("booted", result);
    return result;
  }

  private need(): { vm: LinuxVM; vfs: VmFs } {
    if (!this.vm || !this.vfs) throw new Error("call boot() first");
    return { vm: this.vm, vfs: this.vfs };
  }

  /** Waits for boot() to have been called and to have created the VM. */
  private async started(): Promise<{ vm: LinuxVM; vfs: VmFs }> {
    await this.bootStarted;
    await this.booted;
    return this.need();
  }

  state(): VmState | "stopped" { return this.vm?.state ?? "stopped"; }

  /** Resolves when the guest is up (agent ready, or a restored snapshot refreshed). */
  async whenReady(): Promise<void> { await (await this.started()).vm.ready; }

  /** Resolves when the filesystem can be used (before the guest finishes booting). */
  async whenFilesReady(): Promise<void> { await (await this.started()).vfs.fsReady; }

  // ---- files ---------------------------------------------------------------

  async stat(path: string): Promise<VmStat> { return (await this.started()).vfs.stat(path); }
  async readdir(path: string): Promise<DirEntry[]> { return (await this.started()).vfs.readdir(path); }
  async read(path: string): Promise<Uint8Array> { return (await this.started()).vfs.read(path); }
  async write(path: string, data: Uint8Array, o?: { create?: boolean; overwrite?: boolean }) { return (await this.started()).vfs.write(path, data, o); }
  async mkdir(path: string) { return (await this.started()).vfs.mkdir(path); }
  async remove(path: string, o?: { recursive?: boolean }) { return (await this.started()).vfs.remove(path, o); }
  async rename(from: string, to: string, o?: { overwrite?: boolean }) { return (await this.started()).vfs.rename(from, to, o); }
  async searchFiles(folder: string, pattern: string, maxResults?: number, scope?: SearchScope): Promise<string[]> { return (await this.started()).vfs.searchFiles(folder, pattern, maxResults, scope); }
  async searchText(folder: string, query: TextQuery, o?: { maxResults?: number; maxFileSize?: number } & SearchScope): Promise<{ matches: TextMatch[]; limitHit: boolean }> {
    return (await this.started()).vfs.searchText(folder, query, o);
  }

  // ---- terminals -----------------------------------------------------------
  //
  // Each terminal owns one serial console (ttyS0, ttyS2, ttyS3) with a login
  // shell on it. Output from a console goes to the terminal holding it.

  private consoleOwner = new Map<number, string>(); // port → terminal id
  private consoleFor(port: number) {
    this.need().vm.onPort(port, (bytes) => {
      const id = this.consoleOwner.get(port);
      if (id) this.emit("term-data", { id, data: bytes });
    });
  }

  /** Attaches a terminal to a free console. Fails when all consoles are in use. */
  async openTerminal(o: { rows?: number; cols?: number } = {}): Promise<TerminalInfo> {
    const { vm } = await this.started();
    const port = CONSOLE_PORTS.find((p) => !this.consoleOwner.has(p));
    if (port === undefined) throw Object.assign(new Error(`all ${CONSOLE_PORTS.length} consoles are in use; close a terminal first`), { code: "NoConsole" });
    const id = `t${this.nextTerminal++}`;
    const tty = `ttyS${port}`;
    this.consoleOwner.set(port, id);
    this.terminals.set(id, { port, dispose: () => this.consoleOwner.delete(port) });
    (async () => {
      await vm.ready;
      if (o.rows && o.cols) await vm.rpc({ cmd: "resize", tty, rows: o.rows, cols: o.cols });
      vm.send(port, "\n"); // nudge the shell to print a fresh prompt
    })();
    return { id, tty };
  }

  writeTerminal(id: string, data: string | Uint8Array) {
    const t = this.terminals.get(id);
    if (t) this.need().vm.send(t.port, data);
  }

  async resizeTerminal(id: string, rows: number, cols: number) {
    const t = this.terminals.get(id);
    // A serial line has no window size; the agent sets it (TIOCSWINSZ), and the
    // kernel sends SIGWINCH to the foreground job.
    if (t && this.vm?.state === "running") await this.vm.rpc({ cmd: "resize", tty: `ttyS${t.port}`, rows, cols });
  }

  /** Detaches the terminal; like closing an SSH session, its shell gets SIGHUP and a fresh one starts. */
  async closeTerminal(id: string) {
    const t = this.terminals.get(id);
    if (!t) return;
    this.terminals.delete(id);
    t.dispose();
    await this.vm?.rpc({ cmd: "hangup", tty: `ttyS${t.port}` });
  }

  // ---- processes, ports, agent -----------------------------------------------

  async exec(argv: string[], o?: { cwd?: string; env?: Record<string, string>; stdin?: Uint8Array; timeoutMs?: number }): Promise<ExecResult> {
    return (await this.started()).vm.exec(argv, o);
  }

  async ports(): Promise<number[]> {
    const r = await (await this.started()).vm.rpc({ cmd: "ports" });
    if (!r.ok) throw new Error(`ports: ${r.error}`);
    return r.ports as number[];
  }

  async agent(req: AgentRequest): Promise<AgentReply> { return (await this.started()).vm.rpc(req); }

  // ---- previews ------------------------------------------------------------------

  /**
   * Serves a PreviewGateway for the guest's `port` on `endpoint` (a MessagePort
   * the host page made for a preview origin; see host/src/runtime-host.ts). Not
   * callable over the protocol (leading "_"): only the worker's owner can.
   */
  async _preview(port: number, endpoint: MessagePort) {
    const { vm } = await this.started();
    const gw = new PreviewGateway(vm, port);
    gw.emit = serve(portEndpoint(endpoint), gw);
  }

  // ---- the network gate --------------------------------------------------------

  /** Shows the gate's own UI, if it has one (the web gate: a card on the page, settings from there). */
  showGate(text: string) { this.gate?.show?.(text); }

  // ---- what this build has -------------------------------------------------------

  /** The playgrounds in the VM folder (empty if it has none). */
  async playgrounds(o: { assetBase?: string } = {}): Promise<PlaygroundInfo[]> {
    const base = o.assetBase?.replace(/\/+$/, "") ?? this.assets;
    if (!base) return [];
    return fetch(`${base}/playgrounds/index.json`).then((r) => (r.ok ? r.json() as Promise<PlaygroundInfo[]> : []), () => []);
  }

  async destroy() {
    await this.vm?.destroy();
  }
}
