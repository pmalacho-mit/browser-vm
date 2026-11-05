// Entry point. Runs inside VS Code's *web worker extension host*, i.e. in the
// user's browser. The whole VM lives in this worker; there is no server.
import * as vscode from "vscode";
import { LinuxVM, type VmState } from "./vm.ts";
import { VmFileSystemProvider } from "./fs-provider.ts";
import { ConsoleTerminals } from "./terminal.ts";
import { fileSearchProvider, textSearchProvider } from "./search.ts";

let vm: LinuxVM | undefined;

export function activate(context: vscode.ExtensionContext) {
  const log = vscode.window.createOutputChannel("Linux VM");
  const cfg = vscode.workspace.getConfiguration("linuxVm");
  const asked = new Set<string>();
  const assetBase = vscode.Uri.joinPath(context.extensionUri, "vm").toString(true);

  const theVm = vm = new LinuxVM({
    assetBase,
    memoryMB: cfg.get<number>("memoryMB", 512),
    extraCmdline: cfg.get<string>("kernelCmdline", ""),
    network: cfg.get<"fetch" | "off">("network", "fetch"),
    gateChannel: cfg.get<string>("gateChannel", ""),
    // A secret was needed while the gate is locked: offer to unlock.
    onRefused: async (host) => {
      if (asked.has(`locked:${host}`)) return;
      asked.add(`locked:${host}`);
      if (await vscode.window.showWarningMessage(`The VM needs a secret for ${host}, but the network gate is locked.`, "Unlock the gate")) {
        asked.delete(`locked:${host}`);
        theVm.gate?.showUI(`Code in the VM needs a secret for ${host}. Unlock the gate to use it.`);
      }
    },
    // What the gate wants the user to know. Written for someone who doesn't
    // read code: what happened, whether it's a problem, and what to do.
    onNotice: async ({ kind, host, names = [] }) => {
      const key = `${kind}:${host}:${names.join(",")}`;
      if (asked.has(key)) return;
      asked.add(key);
      const review = "Review in gate settings";
      const open = (text: string) => theVm.gate?.showUI(text);
      const n = names.join(", ");
      switch (kind) {
        case "refused": {
          if (await vscode.window.showWarningMessage(`Code in the VM tried to reach ${host}, which isn't on its list of allowed sites. It was stopped.`, "Allow or review…")) {
            open(`Code in the VM tried to reach ${host}. Allow it under "Sites" if you expected that.`);
          }
          break;
        }
        case "first-use":
          vscode.window.showInformationMessage(`Code in the VM is using your secret ${n} with ${host} for the first time this session.`, review).then((p) => p && open(`Your secret ${n} is being used with ${host}. Turn it off or limit it here if that's unexpected.`));
          break;
        case "leak":
          if (await vscode.window.showErrorMessage(`Warning: code in the VM tried to send your secret ${n} to ${host}, which it isn't meant for. The real value was NOT sent. This can be a sign of malicious code.`, review)) {
            open(`${n} was sent toward ${host} (as a placeholder only). Check the recent requests below.`);
          }
          break;
        case "quota":
          if (await vscode.window.showWarningMessage(`Your secret ${n} hit its usage limit and was refused for ${host}. If that's expected, raise the limit in the gate settings.`, review)) {
            open(`${n} reached its usage limit. Edit the secret to change it.`);
          }
          break;
      }
    },
    log: (s: string) => log.appendLine(s),
  });

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.command = "linuxVm.newTerminal";
  const icons: Record<VmState, string> = { starting: "$(sync~spin)", booting: "$(sync~spin)", running: "$(vm-running)" };
  theVm.onState = (s) => {
    status.text = `${icons[s] ?? "$(vm)"} Linux VM: ${s}`;
    status.tooltip = s === "running" ? "Click to open a terminal in the VM" : "Booting the in-browser VM…";
  };
  theVm.onState("starting");
  status.show();

  const fsp = new VmFileSystemProvider(theVm.fsReady);
  const terminals = new ConsoleTerminals(theVm);

  context.subscriptions.push(
    log, status,
    vscode.workspace.registerFileSystemProvider("vmfs", fsp, { isCaseSensitive: true }),
    vscode.window.registerTerminalProfileProvider("linuxVm.terminal", terminals.profileProvider()),
    vscode.commands.registerCommand("linuxVm.newTerminal", () => terminals.open()),
    vscode.commands.registerCommand("linuxVm.showLog", () => log.show()),
    vscode.commands.registerCommand("linuxVm.manageGate", () => theVm.gate?.showUI("Secrets and network access for this VM. Settings open in a separate window.")),
    vscode.commands.registerCommand("linuxVm.reboot", async () => {
      const ok = await vscode.window.showWarningMessage("Reboot the VM? All changes to its filesystem are lost.", { modal: true }, "Reboot");
      if (ok) vscode.commands.executeCommand("workbench.action.reloadWindow");
    }),
  );

  // Proposed APIs: only available because the host page lists this extension
  // in productConfiguration.extensionEnabledProposedApi.
  try {
    context.subscriptions.push(
      vscode.workspace.registerFileSearchProvider("vmfs", fileSearchProvider(fsp)),
      vscode.workspace.registerTextSearchProvider("vmfs", textSearchProvider(fsp)),
    );
  } catch (e) {
    log.appendLine(`[search] proposed search APIs unavailable: ${(e as Error).message}`);
  }

  theVm.start();
  theVm.fsReady.then(async () => {
    // Show the guest's README on first load (startupEditor can't be set by the host page).
    const readme = vscode.Uri.from({ scheme: "vmfs", path: "/root/project/README.md" });
    if (!vscode.window.activeTextEditor) {
      try { await vscode.commands.executeCommand("markdown.showPreview", readme); } catch {}
    }
  });
  theVm.ready.then(() => {
    if (cfg.get("openTerminalOnStartup", true) && vscode.window.terminals.length === 0) terminals.open();
  });
}

export async function deactivate() {
  await vm?.destroy();
}
