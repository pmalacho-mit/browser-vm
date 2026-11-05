// VS Code terminals backed by the guest's serial consoles, through the VM
// runtime. Each terminal tab owns one console (ttyS0/2/3); the guest runs a
// real tty with a line discipline there, so job control, Ctrl+C, vim, top…
// all work.
import * as vscode from "vscode";
import type { Client } from "../../runtime/src/rpc.ts";
import type { Runtime, TerminalInfo } from "../../runtime/src/runtime.ts";

export class ConsoleTerminals {
  private rt: Client<Runtime>;
  private isRunning: () => boolean;

  constructor(rt: Client<Runtime>, isRunning: () => boolean) {
    this.rt = rt;
    this.isRunning = isRunning;
  }

  createPty(): vscode.ExtensionTerminalOptions {
    const rt = this.rt;
    const writeEmitter = new vscode.EventEmitter<string>();
    const closeEmitter = new vscode.EventEmitter<void>();
    const decoder = new TextDecoder("utf-8");
    let info: TerminalInfo | undefined;
    // Output can arrive before openTerminal() has told us our id: keep it until then.
    const early: { id: string; data: Uint8Array }[] = [];
    const sub = rt.on("term-data", (m: { id: string; data: Uint8Array }) => {
      if (!info) early.push(m);
      else if (m.id === info.id) writeEmitter.fire(decoder.decode(m.data, { stream: true }));
    });

    const pty: vscode.Pseudoterminal = {
      onDidWrite: writeEmitter.event,
      onDidClose: closeEmitter.event,
      open: async (dims) => {
        if (!this.isRunning()) writeEmitter.fire(`\x1b[2mStarting Linux in your browser (v86)…\x1b[0m\r\n`);
        try {
          info = await rt.api.openTerminal({ rows: dims?.rows, cols: dims?.columns });
        } catch (e) {
          vscode.window.showWarningMessage((e as Error).message);
          sub.dispose();
          closeEmitter.fire();
          return;
        }
        for (const m of early.splice(0)) if (m.id === info.id) writeEmitter.fire(decoder.decode(m.data, { stream: true }));
      },
      handleInput: (data) => { if (info) rt.api.writeTerminal(info.id, data); },
      // A serial line has no window size; the guest agent sets it (TIOCSWINSZ).
      setDimensions: (d) => { if (info) rt.api.resizeTerminal(info.id, d.rows, d.columns); },
      close: () => {
        sub.dispose();
        // Like closing an SSH session: the shell gets SIGHUP and the guest starts a fresh one.
        if (info) rt.api.closeTerminal(info.id);
      },
    };
    return { name: "Linux VM", pty, iconPath: new vscode.ThemeIcon("terminal-linux") };
  }

  open() {
    const t = vscode.window.createTerminal(this.createPty());
    t.show();
    return t;
  }

  profileProvider(): vscode.TerminalProfileProvider {
    return { provideTerminalProfile: () => new vscode.TerminalProfile(this.createPty()) };
  }
}
