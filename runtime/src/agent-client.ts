// Talks to the guest's control-plane agent (/sbin/vm-agent on ttyS1).
//
// Two agents exist:
//   - guest/agent (Go, JSON lines): written into the guest by the extension
//     before boot. Supports every command below.
//   - guest/vm-agent (shell, "<id> <cmd> args" lines): shipped inside images as
//     a fallback. Supports ping, resize and hangup only.
// The client detects which one answered from its ready line. No VS Code or
// browser dependencies, so the Node scripts use it too.
import type { V86Filesystem } from "v86";

export type AgentRequest =
  | { cmd: "ping" }
  | { cmd: "resize"; tty: string; rows: number; cols: number }
  | { cmd: "hangup"; tty: string }
  | { cmd: "exec"; argv: string[]; cwd?: string; env?: Record<string, string>; stdin?: string; timeoutMs?: number }
  | { cmd: "ports" }
  | { cmd: "refresh"; seed?: string; timeMs?: number };

export interface AgentReply {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

/** Output of a command run with exec(). */
export interface ExecResult {
  code: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
  ms: number;
  timedOut: boolean;
  truncated: boolean;
}

export interface AgentReady {
  kernel: string;
  /** 0 = the shell agent; 2+ = the Go agent's JSON protocol version. */
  protocol: number;
}

const b64decode = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const b64encode = (b: Uint8Array) => { let s = ""; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); };

export class AgentClient {
  /** Sends one line to the agent (without the newline). */
  private sendLine: (line: string) => void;
  private buffer = "";
  private decoder = new TextDecoder();
  private nextId = 1;
  private pending = new Map<string, { resolve: (r: AgentReply) => void; reject: (e: Error) => void }>();
  protocol = -1; // unknown until the ready line, or until assume() is called
  onReady?: (r: AgentReady) => void;

  constructor(sendLine: (line: string) => void) {
    this.sendLine = sendLine;
  }

  /**
   * For a VM restored from a snapshot: the agent printed its ready line before
   * the snapshot was taken, so there won't be another one.
   */
  assume(protocol: number) {
    this.protocol = protocol;
  }

  /** Feed bytes received from the agent's serial port. */
  feed(bytes: Uint8Array) {
    this.buffer += this.decoder.decode(bytes, { stream: true });
    let nl;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl).replace(/\r$/, "").trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (line) this.onLine(line);
    }
  }

  private onLine(line: string) {
    if (line.startsWith("{")) {
      let m: Record<string, unknown>;
      try { m = JSON.parse(line); } catch { return; }
      if (m.event === "ready") {
        this.protocol = Number(m.agent) || 2;
        this.onReady?.({ kernel: String(m.kernel ?? ""), protocol: this.protocol });
        return;
      }
      const id = String(m.id ?? "");
      const p = this.pending.get(id);
      if (p) { this.pending.delete(id); p.resolve(m as AgentReply); }
      return;
    }
    // The shell agent: "0 ready <kernel>" or "<id> ok|err [data]"
    const [id, status, ...rest] = line.split(" ");
    if (id === "0" && status === "ready") {
      this.protocol = 0;
      this.onReady?.({ kernel: rest.join(" "), protocol: 0 });
      return;
    }
    const p = this.pending.get(id);
    if (p) {
      this.pending.delete(id);
      p.resolve(status === "ok" ? { ok: true, data: rest.join(" ") } : { ok: false, error: rest.join(" ") || "error" });
    }
  }

  /** Sends a request; resolves with the agent's reply (check `ok`). */
  request(req: AgentRequest): Promise<AgentReply> {
    const id = String(this.nextId++);
    const reply = new Promise<AgentReply>((resolve, reject) => this.pending.set(id, { resolve, reject }));
    if (this.protocol === 0) {
      const line = req.cmd === "resize" ? `${id} resize ${req.tty} ${req.rows} ${req.cols}`
        : req.cmd === "hangup" ? `${id} hangup ${req.tty}`
        : req.cmd === "ping" ? `${id} ping`
        : null;
      if (!line) {
        this.pending.delete(id);
        return Promise.resolve({ ok: false, error: `the shell agent doesn't support ${req.cmd}` });
      }
      this.sendLine(line);
    } else {
      this.sendLine(JSON.stringify({ id, ...req }));
    }
    return reply;
  }

  /** Runs a program in the guest (no shell; use ["sh", "-c", "…"] for one). */
  async exec(argv: string[], o: { cwd?: string; env?: Record<string, string>; stdin?: Uint8Array; timeoutMs?: number } = {}): Promise<ExecResult> {
    const r = await this.request({ cmd: "exec", argv, cwd: o.cwd, env: o.env, stdin: o.stdin && b64encode(o.stdin), timeoutMs: o.timeoutMs });
    if (!r.ok) throw new Error(`exec ${argv[0]}: ${r.error}`);
    return {
      code: Number(r.code),
      stdout: b64decode(String(r.stdout ?? "")),
      stderr: b64decode(String(r.stderr ?? "")),
      ms: Number(r.ms),
      timedOut: Boolean(r.timedOut),
      truncated: Boolean(r.truncated),
    };
  }

  /** Fails every request still waiting (the VM stopped). */
  close(reason: string) {
    for (const p of this.pending.values()) p.reject(new Error(reason));
    this.pending.clear();
  }
}

/**
 * Writes the Go agent into the guest as /sbin/vm-agent, before boot, so vm-init
 * starts it instead of the image's shell agent. Returns false if there's no
 * /sbin directory (an unexpected image), leaving the image as it is.
 */
export async function installAgent(fs9p: V86Filesystem, binary: Uint8Array): Promise<boolean> {
  const sbin = fs9p.SearchPath("/sbin");
  if (sbin.id === -1) return false;
  let id = fs9p.SearchPath("/sbin/vm-agent").id;
  if (id === -1) id = fs9p.CreateFile("vm-agent", sbin.id);
  await fs9p.ChangeSize(id, binary.length);
  await fs9p.Write(id, 0, binary.length, binary);
  const inode = fs9p.GetInode(id);
  inode.mode = (inode.mode & ~0o777) | 0o755;
  return true;
}

/** Random bytes for `refresh`, base64-encoded. */
export function freshSeed(bytes = 64): string {
  return b64encode(crypto.getRandomValues(new Uint8Array(bytes)));
}
