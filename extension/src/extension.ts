// Entry point. Runs inside VS Code's *web worker extension host*, i.e. in the
// user's browser. The VM itself runs in the VM runtime (runtime/src/runtime.ts),
// a worker the host page starts (web/runtime-host.ts); this extension is one of
// its frontends, talking to it over a BroadcastChannel. There is no server.
import * as vscode from "vscode";
import { channelEndpoint, connect, type Client } from "../../runtime/src/rpc.ts";
import type { BootResult, Runtime } from "../../runtime/src/runtime.ts";
import type { VmState } from "../../runtime/src/vm.ts";
import type { GateNotice } from "../../types/gate-protocol.ts";
import { VmFileSystemProvider } from "./fs-provider.ts";
import { ConsoleTerminals } from "./terminal.ts";
import { fileSearchProvider, textSearchProvider } from "./search.ts";

let rt: Client<Runtime> | undefined;

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

  const channel = cfg.get<string>("runtimeChannel", "");
  if (!channel) {
    vscode.window.showErrorMessage("The Linux VM runtime isn't available: this page didn't start it (see web/runtime-host.ts).");
    return;
  }
  const runtime = rt = connect<Runtime>(channelEndpoint(new BroadcastChannel(channel)));
  const showGate = (text: string) => runtime.api.showGate(text);

  runtime.on("log", (s: string) => log.appendLine(s));
  // A secret was needed while the gate is locked: offer to unlock.
  runtime.on("refused", async ({ host }: { host: string }) => {
    if (asked.has(`locked:${host}`)) return;
    asked.add(`locked:${host}`);
    if (await vscode.window.showWarningMessage(`The VM needs a secret for ${host}, but the network gate is locked.`, "Unlock the gate")) {
      asked.delete(`locked:${host}`);
      showGate(`Code in the VM needs a secret for ${host}. Unlock the gate to use it.`);
    }
  });
  // What the gate wants the user to know. Written for someone who doesn't
  // read code: what happened, whether it's a problem, and what to do.
  runtime.on("notice", async ({ kind, host, names = [] }: GateNotice) => {
    const key = `${kind}:${host}:${names.join(",")}`;
    if (asked.has(key)) return;
    asked.add(key);
    const review = "Review in gate settings";
    const n = names.join(", ");
    switch (kind) {
      case "refused": {
        if (await vscode.window.showWarningMessage(`Code in the VM tried to reach ${host}, which isn't on its list of allowed sites. It was stopped.`, "Allow or review…")) {
          showGate(`Code in the VM tried to reach ${host}. Allow it under "Sites" if you expected that.`);
        }
        break;
      }
      case "first-use":
        vscode.window.showInformationMessage(`Code in the VM is using your secret ${n} with ${host} for the first time this session.`, review).then((p) => p && showGate(`Your secret ${n} is being used with ${host}. Turn it off or limit it here if that's unexpected.`));
        break;
      case "leak":
        if (await vscode.window.showErrorMessage(`Warning: code in the VM tried to send your secret ${n} to ${host}, which it isn't meant for. The real value was NOT sent. This can be a sign of malicious code.`, review)) {
          showGate(`${n} was sent toward ${host} (as a placeholder only). Check the recent requests below.`);
        }
        break;
      case "quota":
        if (await vscode.window.showWarningMessage(`Your secret ${n} hit its usage limit and was refused for ${host}. If that's expected, raise the limit in the gate settings.`, review)) {
          showGate(`${n} reached its usage limit. Edit the secret to change it.`);
        }
        break;
    }
  });

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.command = "linuxVm.newTerminal";
  const icons: Record<VmState, string> = { starting: "$(sync~spin)", booting: "$(sync~spin)", running: "$(vm-running)" };
  let label = "Linux VM", state: VmState = "starting";
  const showState = () => {
    status.text = `${icons[state] ?? "$(vm)"} ${label}: ${state}`;
    status.tooltip = state === "running" ? "Click to open a terminal in the VM" : "Starting the in-browser VM…";
  };
  runtime.on("state", (s: VmState) => { state = s; showState(); });
  showState();
  status.show();

  const fsp = new VmFileSystemProvider(runtime);
  const terminals = new ConsoleTerminals(runtime, () => state === "running");

  context.subscriptions.push(
    log, status,
    vscode.workspace.registerFileSystemProvider("vmfs", fsp, { isCaseSensitive: true }),
    vscode.window.registerTerminalProfileProvider("linuxVm.terminal", terminals.profileProvider()),
    vscode.commands.registerCommand("linuxVm.newTerminal", () => terminals.open()),
    vscode.commands.registerCommand("linuxVm.showLog", () => log.show()),
    vscode.commands.registerCommand("linuxVm.openPlayground", () => pickPlayground(assetBase, pageUrl, playgroundId)),
    vscode.commands.registerCommand("linuxVm.manageGate", () => showGate("Secrets and network access for this VM. Settings open in a separate window.")),
    vscode.commands.registerCommand("linuxVm.reboot", async () => {
      const ok = await vscode.window.showWarningMessage("Reboot the VM? All changes to its filesystem are lost.", { modal: true }, "Reboot");
      if (ok) vscode.commands.executeCommand("workbench.action.reloadWindow");
    }),
  );

  // Proposed APIs: only available because the host page lists this extension
  // in productConfiguration.extensionEnabledProposedApi.
  try {
    context.subscriptions.push(
      vscode.workspace.registerFileSearchProvider("vmfs", fileSearchProvider(runtime)),
      vscode.workspace.registerTextSearchProvider("vmfs", textSearchProvider(runtime)),
    );
  } catch (e) {
    log.appendLine(`[search] proposed search APIs unavailable: ${(e as Error).message}`);
  }

  // Everything above is registered right away, so VS Code can resolve vmfs:
  // while the VM starts (the runtime holds file calls until it has a VM).
  (async () => {
    let result: BootResult;
    try {
      result = await runtime.api.boot({
        assetBase,
        memoryMB: cfg.get<number>("memoryMB", 512),
        extraCmdline: cfg.get<string>("kernelCmdline", ""),
        fileCacheMB: cfg.get<number>("fileCacheMB", 256),
        network: cfg.get<"fetch" | "off">("network", "fetch"),
        gateChannel: cfg.get<string>("gateChannel", ""),
        playground: playgroundId,
      });
    } catch (e) {
      vscode.window.showErrorMessage(`The Linux VM didn't start: ${(e as Error).message}`);
      return;
    }
    if (result.playground) { label = `Linux VM (${result.playground.title})`; showState(); }
    if (result.missingPlayground) {
      vscode.window.showWarningMessage(`This site has no playground "${result.missingPlayground}". Starting the default Linux VM instead.`, "Open a Playground…")
        .then((pick) => pick && pickPlayground(assetBase, pageUrl, playgroundId));
    }

    await runtime.api.whenFilesReady();
    if (!vscode.window.activeTextEditor) {
      const open = result.playground?.open ?? [];
      if (open.length) {
        // The playground's own files, side by side.
        for (const [i, f] of open.entries()) {
          const uri = vscode.Uri.from({ scheme: "vmfs", path: `/root/project/${f}` });
          try { await vscode.window.showTextDocument(uri, { preview: false, viewColumn: i === 0 ? vscode.ViewColumn.One : vscode.ViewColumn.Two }); } catch {}
        }
      } else {
        // Show the guest's README on first load (startupEditor can't be set by the host page).
        const readme = vscode.Uri.from({ scheme: "vmfs", path: "/root/project/README.md" });
        try { await vscode.commands.executeCommand("markdown.showPreview", readme); } catch {}
      }
    }
    await runtime.api.whenReady();
    if (cfg.get("openTerminalOnStartup", true) && vscode.window.terminals.length === 0) terminals.open();
  })();
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
  await rt?.api.destroy();
}
