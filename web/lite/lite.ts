// The lightweight frontend (web/lite/index.html): a file tree, CodeMirror and
// xterm.js on the VM runtime. It uses only the runtime's protocol, the same one
// the VS Code extension uses, so it doubles as the reference for bringing your
// own editor.
import "@xterm/xterm/css/xterm.css";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { EditorView, basicSetup } from "codemirror";
import { keymap } from "@codemirror/view";
import { EditorState, type Extension } from "@codemirror/state";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { markdown } from "@codemirror/lang-markdown";
import { json } from "@codemirror/lang-json";
import { oneDark } from "@codemirror/theme-one-dark";
import { channelEndpoint, connect } from "../../runtime/src/rpc.ts";
import type { Runtime } from "../../runtime/src/runtime.ts";
import type { DirEntry, FsChange } from "../../runtime/src/vmfs.ts";

const ROOT = "/root/project";
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const params = new URLSearchParams(location.search);
const playground = params.get("playground") ?? "";
const siteRoot = new URL("../", location.href);
const assetBase = new URL("extensions/linux-vm/vm", siteRoot).href;
if (playground) ($("full") as HTMLAnchorElement).href = `../?playground=${encodeURIComponent(playground)}`;

const rt = connect<Runtime>(channelEndpoint(new BroadcastChannel(window.__vmRuntimeChannel!)));
rt.on("state", (s: string) => { $("state").textContent = s; $("state").dataset.state = s; });
rt.on("log", (s: string) => console.debug("[vm]", s));
rt.on("notice", (n: { kind: string; host: string }) => console.info("[gate]", n.kind, n.host));
rt.on("refused", ({ host }: { host: string }) => {
  term.write(`\r\n\x1b[33m[gate] ${host} needs a secret, but the network gate is locked.\x1b[0m\r\n`);
  rt.api.showGate(`Code in the VM needs a secret for ${host}. Unlock the gate to use it.`);
});

// ---- terminal ----------------------------------------------------------------

const term = new Terminal({ fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace', fontSize: 13, cursorBlink: true, theme: { background: "#000000" } });
const fit = new FitAddon();
term.loadAddon(fit);
term.open($("terminal"));
fit.fit();
addEventListener("resize", () => fit.fit());
term.write("\x1b[2mStarting Linux in your browser (v86)…\x1b[0m\r\n");

let termId: string | undefined;
const decoder = new TextDecoder();
rt.on("term-data", (m: { id: string; data: Uint8Array }) => { if (m.id === termId) term.write(decoder.decode(m.data, { stream: true })); });
term.onData((d) => termId && rt.api.writeTerminal(termId, d));
term.onResize(({ rows, cols }) => termId && rt.api.resizeTerminal(termId, rows, cols));

// ---- editor --------------------------------------------------------------------

const LANGS: Record<string, () => Extension> = {
  js: javascript, mjs: javascript, cjs: javascript, ts: () => javascript({ typescript: true }),
  jsx: () => javascript({ jsx: true }), tsx: () => javascript({ jsx: true, typescript: true }),
  py: python, md: markdown, json,
};

let current: { path: string; view: EditorView; saved: string } | undefined;

function setDirty() {
  $("dirty").hidden = !current || current.view.state.doc.toString() === current.saved;
}

async function save() {
  if (!current) return;
  const text = current.view.state.doc.toString();
  await rt.api.write(current.path, new TextEncoder().encode(text));
  current.saved = text;
  setDirty();
}

async function openFile(path: string) {
  const text = decoder.decode(await rt.api.read(path));
  const ext = path.split(".").pop() ?? "";
  current?.view.destroy();
  $("editor").replaceChildren();
  const view = new EditorView({
    parent: $("editor"),
    state: EditorState.create({
      doc: text,
      extensions: [
        basicSetup, oneDark, LANGS[ext]?.() ?? [],
        keymap.of([{ key: "Mod-s", preventDefault: true, run: () => { save(); return true; } }]),
        EditorView.updateListener.of((u) => u.docChanged && setDirty()),
      ],
    }),
  });
  current = { path, view, saved: text };
  $("path").textContent = path;
  setDirty();
  for (const b of $("tree").querySelectorAll("button")) b.setAttribute("aria-current", String(b.dataset.path === path));
  view.focus();
}

/** A file changed underneath us (the guest wrote it): reload unless there are unsaved edits. */
async function reloadIfClean(path: string) {
  if (!current || current.path !== path || current.view.state.doc.toString() !== current.saved) return;
  const text = decoder.decode(await rt.api.read(path));
  if (text === current.saved) return;
  current.saved = text;
  current.view.dispatch({ changes: { from: 0, to: current.view.state.doc.length, insert: text } });
  setDirty();
}

// ---- file tree -------------------------------------------------------------------
//
// Directories load when expanded and reload when the runtime reports a change in them.

const expanded = new Map<string, HTMLUListElement>(); // dir path → its <ul>

async function renderDir(dir: string, ul: HTMLUListElement) {
  let entries: DirEntry[];
  try { entries = await rt.api.readdir(dir); } catch { entries = []; }
  entries.sort((a, b) => (a[1] === "directory" ? 0 : 1) - (b[1] === "directory" ? 0 : 1) || a[0].localeCompare(b[0]));
  ul.replaceChildren(...entries.map(([name, kind]) => {
    const path = `${dir}/${name}`;
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.textContent = name;
    b.dataset.path = path;
    b.className = kind === "directory" ? "dir" : "file";
    li.append(b);
    if (kind === "directory") {
      b.setAttribute("aria-expanded", String(expanded.has(path)));
      b.onclick = () => toggleDir(path, li, b);
      const open = expanded.get(path);
      if (open) { li.append(open); renderDir(path, open); }
    } else {
      b.onclick = () => openFile(path);
      if (current?.path === path) b.setAttribute("aria-current", "true");
    }
    return li;
  }));
}

function toggleDir(path: string, li: HTMLLIElement, b: HTMLButtonElement) {
  const open = expanded.get(path);
  if (open) { open.remove(); expanded.delete(path); b.setAttribute("aria-expanded", "false"); return; }
  const ul = document.createElement("ul");
  expanded.set(path, ul);
  li.append(ul);
  b.setAttribute("aria-expanded", "true");
  renderDir(path, ul);
}

let pending = new Set<string>(), timer: ReturnType<typeof setTimeout> | undefined;
rt.on("fs", (changes: FsChange[]) => {
  for (const c of changes) {
    const parent = c.path.slice(0, c.path.lastIndexOf("/")) || "/";
    if (c.type !== "changed" && expanded.has(parent)) pending.add(parent);
    if (c.type === "changed") reloadIfClean(c.path);
  }
  // Coalesce: an `npm install` creates thousands of files.
  timer ??= setTimeout(() => {
    for (const dir of pending) { const ul = expanded.get(dir); if (ul) renderDir(dir, ul); }
    pending = new Set(); timer = undefined;
  }, 300);
});

// ---- start -----------------------------------------------------------------------

(async () => {
  const result = await rt.api.boot({ assetBase, gateChannel: window.__vmGateChannel, playground });
  if (result.playground) $("title").textContent = result.playground.title;
  if (result.missingPlayground) term.write(`\x1b[33mThis site has no playground "${result.missingPlayground}"; starting the default VM.\x1b[0m\r\n`);
  document.title = result.playground ? `${result.playground.title} · Browser VM Lite` : "Browser VM Lite";

  await rt.api.whenFilesReady();
  const rootUl = document.createElement("ul");
  expanded.set(ROOT, rootUl);
  $("tree").append(rootUl);
  await renderDir(ROOT, rootUl);
  const first = result.playground?.open[0] ?? "README.md";
  openFile(`${ROOT}/${first}`).catch(() => {});

  const t = await rt.api.openTerminal({ rows: term.rows, cols: term.cols });
  termId = t.id;
  term.focus();
})().catch((e) => term.write(`\r\n\x1b[31m${(e as Error).message}\x1b[0m\r\n`));
