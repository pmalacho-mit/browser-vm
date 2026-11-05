// VS Code terminals backed by the guest's serial consoles.
// Each terminal tab owns one port (ttyS0/2/3). The guest runs a real tty with
// a line discipline there, so job control, Ctrl+C, vim, top... all work.
import * as vscode from "vscode";
import { CONSOLE_PORTS, type LinuxVM } from "./vm.ts";

export class ConsoleTerminals {
  vm: LinuxVM;
  inUse = new Set<number>();

  constructor(vm: LinuxVM) {
    this.vm = vm;
  }

  createPty(): vscode.ExtensionTerminalOptions | undefined {
    const port = CONSOLE_PORTS.find((p) => !this.inUse.has(p));
    if (port === undefined) {
      vscode.window.showWarningMessage(`All ${CONSOLE_PORTS.length} VM consoles are in use. Close a terminal first.`);
      return undefined;
    }
    this.inUse.add(port);
    const tty = `ttyS${port}`;
    const vm = this.vm;
    const writeEmitter = new vscode.EventEmitter<string>();
    const decoder = new TextDecoder("utf-8");
    let sub: { dispose(): void } | undefined, dims: vscode.TerminalDimensions | undefined;

    const pty: vscode.Pseudoterminal = {
      onDidWrite: writeEmitter.event,
      open: async (initialDims) => {
        dims = initialDims;
        sub = vm.onPort(port, (bytes) => writeEmitter.fire(decoder.decode(bytes, { stream: true })));
        if (vm.state !== "running") {
          writeEmitter.fire(`\x1b[2mBooting Linux in your browser (v86)… attaching to /dev/${tty}\x1b[0m\r\n`);
        }
        await vm.ready;
        if (dims) await vm.rpc("resize", tty, dims.rows, dims.columns);
        vm.send(port, "\n"); // nudge the shell to print a fresh prompt
      },
      handleInput: (data) => vm.send(port, data),
      setDimensions: (d) => {
        dims = d;
        // A serial line has no window size; the agent sets it with stty
        // (TIOCSWINSZ), and the kernel sends SIGWINCH to the foreground job.
        if (vm.state === "running") vm.rpc("resize", tty, d.rows, d.columns);
      },
      close: () => {
        sub?.dispose();
        this.inUse.delete(port);
        // Like closing an SSH session: SIGHUP everything on that tty; init respawns a shell.
        vm.rpc("hangup", tty);
      },
    };
    return { name: `Linux VM (${tty})`, pty, iconPath: new vscode.ThemeIcon("terminal-linux") };
  }

  open() {
    const opts = this.createPty();
    if (!opts) return;
    const t = vscode.window.createTerminal(opts);
    t.show();
    return t;
  }

  profileProvider(): vscode.TerminalProfileProvider {
    return {
      provideTerminalProfile: () => {
        const opts = this.createPty();
        return opts ? new vscode.TerminalProfile(opts) : undefined;
      },
    };
  }
}
