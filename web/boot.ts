// Workbench configuration for the IDE page. Built to dist/boot.js as a classic
// script and loaded by index.html after gate-relay.js and before VS Code's
// loader, so `window.product` exists when the workbench starts.
export {}; // a module for type checking; esbuild emits a self-contained classic script

performance.mark("code/didStartRenderer");

// ---- deployment settings ------------------------------------------------------

// Webviews (Markdown preview, extension UIs) run in iframes on their own origin:
// https://<hash>.<webview host>/. The bootstrap page refuses to run anywhere else,
// so self-hosting them needs a wildcard hostname that serves these same static
// files. `*.localhost` works out of the box in browsers. In production, set this
// to e.g. "webview.example.com" if *.webview.example.com serves this site
// (wildcard DNS + TLS certificate), or leave it null to fall back to
// Microsoft's CDN copy (*.vscode-cdn.net).
const WEBVIEW_HOST: string | null = location.hostname === "localhost" ? location.host : null;

// Let users install editor extensions from Open VSX? Off by default: an editor
// extension can read and change every file in the VM and use the network gate
// (within its policy), so for users who can't vet one it's the biggest hole.
// Ship the extensions you need as built-ins instead (additionalBuiltinExtensions).
const ENABLE_EXTENSION_GALLERY: boolean = false;

// ---- workbench options -----------------------------------------------------------

// Works from any path, e.g. https://you.github.io/some-repo/
const pageBase = new URL(".", location.href);

// ?playground=python-3.12 starts that playground (a snapshot) instead of booting
// the default image. The extension checks that this build has it.
const playground = new URLSearchParams(location.search).get("playground") ?? "";
const extensionUrl = new URL("extensions/linux-vm", pageBase);

// IWorkbenchConstructionOptions, read by vscode/out/vs/code/browser/workbench/workbench.js
window.product = {
  productConfiguration: {
    nameShort: "Code - OSS (Browser VM)",
    nameLong: "Code - OSS (Browser VM)",
    applicationName: "code-browser-vm",
    dataFolderName: ".code-browser-vm",
    // Open VSX instead of Microsoft's marketplace (whose terms forbid this use).
    // Only *web* extensions (package.json "browser" entry) can run here.
    ...(ENABLE_EXTENSION_GALLERY
      ? {
          extensionsGallery: {
            serviceUrl: "https://open-vsx.org/vscode/gallery",
            itemUrl: "https://open-vsx.org/vscode/item",
            resourceUrlTemplate: "https://open-vsx.org/vscode/unpkg/{publisher}/{name}/{version}/{path}",
          },
        }
      : {}),
    // Lets our extension use the (proposed) search APIs for Ctrl+P / Find in Files.
    extensionEnabledApiProposals: {
      "local.linux-vm": ["fileSearchProvider", "textSearchProvider"],
    },
  },
  webviewEndpoint: WEBVIEW_HOST
    ? `${location.protocol}//{{uuid}}.${WEBVIEW_HOST}${pageBase.pathname}vscode/out/vs/workbench/contrib/webview/browser/pre`
    : undefined,
  folderUri: { scheme: "vmfs", path: "/root/project" },
  additionalBuiltinExtensions: [
    {
      scheme: extensionUrl.protocol.replace(":", ""),
      authority: extensionUrl.host,
      path: extensionUrl.pathname,
    },
  ],
  configurationDefaults: {
    "workbench.colorTheme": "Default Dark Modern",
    "workbench.startupEditor": "none",
    "terminal.integrated.defaultProfile.linux": "Linux VM",
    "terminal.integrated.defaultProfile.osx": "Linux VM",
    "terminal.integrated.defaultProfile.windows": "Linux VM",
    "security.workspace.trust.enabled": false,
    "extensions.ignoreRecommendations": true,
    "linuxVm.gateChannel": window.__vmGateChannel,
    "linuxVm.runtimeChannel": window.__vmRuntimeChannel,
    "linuxVm.playground": /^[a-z0-9][a-z0-9.-]{0,63}$/.test(playground) ? playground : "",
  },
};

// Read by amd-config.ts. No trailing slash.
window.__vscodeBase = new URL("vscode", pageBase).toString();
