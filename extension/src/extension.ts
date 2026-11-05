// Entry point. Runs inside VS Code's *web worker extension host*, i.e. in the
// user's browser. The whole VM lives in this worker; there is no server.
import * as vscode from "vscode";
import { LinuxVM, type VmState } from "./vm.ts";
import { VmFileSystemProvider } from "./fs-provider.ts";
import { ConsoleTerminals } from "./terminal.ts";
import { fileSearchProvider, textSearchProvider } from "./search.ts";

let vm: LinuxVM | undefined;

/** A built playground, as listed in vm/playgrounds/index.json and described by its manifest.json. */
interface PlaygroundInfo {
  id: string;
  title: string;
  description: string;
  memoryMB: number;
  packages: string[];
  state?: string;
  open?: string[];
}

export function activate(context: vscode.ExtensionContext) {
  const log = vscode.window.createOutputChannel("Linux VM");
  const cfg = vscode.workspace.getConfiguration("linuxVm");
  const asked = new Set<string>();
  const assetBase = vscode.Uri.joinPath(context.extensionUri, "vm").toString(true);
  // The IDE page: assets live at <page>/extensions/linux-vm/vm.
  const pageUrl = new URL("../../../", assetBase + "/").href;
  const playgroundId = cfg.get<string>("playground", "");

  const theVm = vm = new LinuxVM({
    assetBase,
    memoryMB: cfg.get<number>("memoryMB", 512),
    extraCmdline: cfg.get<string>("kernelCmdline", ""),
    fileCacheMB: cfg.get<number>("fileCacheMB", 256),
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
  let label = "Linux VM";
  theVm.onState = (s) => {
    status.text = `${icons[s] ?? "$(vm)"} ${label}: ${s}`;
    status.tooltip = s === "running" ? "Click to open a terminal in the VM" : "Starting the in-browser VM…";
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
    vscode.commands.registerCommand("linuxVm.openPlayground", () => pickPlayground(assetBase, pageUrl, playgroundId)),
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

  // A playground restores its snapshot instead of booting (vm.ts); it needs its
  // manifest first. Everything above is registered right away, so VS Code can
  // resolve vmfs: while the manifest loads.
  let openOnStart: string[] = [];
  (async () => {
    if (playgroundId) {
      const m = await fetchJSON<PlaygroundInfo>(`${assetBase}/playgrounds/${playgroundId}/manifest.json`);
      if (m?.state) {
        theVm.opts.snapshot = { url: `${assetBase}/playgrounds/${playgroundId}/${m.state}` };
        theVm.opts.memoryMB = m.memoryMB; // a snapshot restores only with the memory it was taken with
        label = `Linux VM (${m.title})`;
        openOnStart = m.open ?? [];
        theVm.onState(theVm.state);
      } else {
        vscode.window.showWarningMessage(`This site has no playground "${playgroundId}". Starting the default Linux VM instead.`, "Open a Playground…")
          .then((pick) => pick && pickPlayground(assetBase, pageUrl, playgroundId));
      }
    }
    theVm.start();
  })();
  theVm.fsReady.then(async () => {
    if (vscode.window.activeTextEditor) return;
    if (openOnStart.length) {
      // The playground's own files, side by side.
      for (const [i, f] of openOnStart.entries()) {
        const uri = vscode.Uri.from({ scheme: "vmfs", path: `/root/project/${f}` });
        try { await vscode.window.showTextDocument(uri, { preview: false, viewColumn: i === 0 ? vscode.ViewColumn.One : vscode.ViewColumn.Two }); } catch {}
      }
      return;
    }
    // Show the guest's README on first load (startupEditor can't be set by the host page).
    const readme = vscode.Uri.from({ scheme: "vmfs", path: "/root/project/README.md" });
    try { await vscode.commands.executeCommand("markdown.showPreview", readme); } catch {}
  });
  theVm.ready.then(() => {
    if (cfg.get("openTerminalOnStartup", true) && vscode.window.terminals.length === 0) terminals.open();
  });
}

async function fetchJSON<T>(url: string): Promise<T | undefined> {
  try {
    const r = await fetch(url);
    return r.ok ? await r.json() as T : undefined;
  } catch {
    return undefined;
  }
}

/** Lists this site's playgrounds and opens the chosen one in a new tab. */
async function pickPlayground(assetBase: string, pageUrl: string, current: string) {
  const list = (await fetchJSON<PlaygroundInfo[]>(`${assetBase}/playgrounds/index.json`)) ?? [];
  type Item = vscode.QuickPickItem & { id: string };
  const items: Item[] = [
    ...list.map((p) => ({ id: p.id, label: p.title, description: p.id === current ? "(this one)" : p.packages.join(", "), detail: p.description })),
    { id: "", label: "Default Linux VM", description: current ? "" : "(this one)", detail: "Boots the default image (busybox and apk)." },
  ];
  if (!list.length) vscode.window.showInformationMessage("This site was built without playgrounds (npm run playgrounds, then npm run build).");
  const pick = await vscode.window.showQuickPick(items, { title: "Open a playground in a new tab", matchOnDescription: true, matchOnDetail: true });
  if (!pick) return;
  const url = new URL(pageUrl);
  if (pick.id) url.searchParams.set("playground", pick.id); else url.searchParams.delete("playground");
  vscode.env.openExternal(vscode.Uri.parse(url.href));
}

export async function deactivate() {
  await vm?.destroy();
}
