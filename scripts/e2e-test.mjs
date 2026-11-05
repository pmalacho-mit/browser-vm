// Browser end-to-end tests of the built site, in headless Chromium (Playwright).
// They cover what only a browser exercises: the workbench and its CSP patch,
// the runtime iframe and worker, the gate relay and iframe, VS Code's
// filesystem and terminals, the lite page, and previews with hot reload.
//
//   npm run build && npx playwright install chromium && npm run test:e2e
//
// Serves dist/ on a free port itself. Playground sections run when the build
// has those playgrounds (npm run playgrounds), and are skipped otherwise.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { chromium } from "playwright";

const root = path.resolve(import.meta.dirname, "..");
const dist = path.join(root, "dist");
const vmDir = path.join(dist, "extensions/linux-vm/vm");
if (!fs.existsSync(path.join(vmDir, "fs.json"))) { console.error("no build in dist/: run npm run build first"); process.exit(1); }
const has = (/** @type {string} */ id) => fs.existsSync(path.join(vmDir, "playgrounds", id, "manifest.json"));
// The build defines __VM_ARCH__: "const arch = true ? \"x86_64\" : …" in the bundle.
const arch = /const arch = true \? "x86_64"/.test(fs.readFileSync(path.join(dist, "runtime/worker.js"), "utf8")) ? "x86_64" : "i686";

const check = (/** @type {string} */ name, /** @type {boolean} */ ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!ok) process.exitCode = 1;
};
const t0 = Date.now();
const secs = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

// ---- serve dist/ ---------------------------------------------------------------------
const port = await new Promise((res) => { const s = http.createServer().listen(0, () => { const p = /** @type {import("node:net").AddressInfo} */ (s.address()).port; s.close(() => res(p)); }); });
const server = spawn(process.execPath, [path.join(root, "scripts/serve.mjs"), dist, String(port)], { stdio: "ignore" });
process.on("exit", () => server.kill());
const base = `http://localhost:${port}/`;
for (let i = 0; i < 50; i++) { if (await fetch(base).then((r) => r.ok, () => false)) break; await new Promise((r) => setTimeout(r, 100)); }

const browser = await chromium.launch();
/** Errors that every build has and that aren't ours (Code-OSS's markdown-math extension under our CSP). */
const KNOWN = /markdown-math|katex|favicon|net::ERR_ABORTED|fake\.html|vscode-cdn|open-vsx|ERR_NAME_NOT_RESOLVED/i;
async function newPage() {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  /** @type {string[]} */
  const errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error" && !KNOWN.test(m.text())) errors.push(m.text().slice(0, 200)); });
  page.on("response", (r) => { if (r.status() >= 400 && r.url().startsWith(base) && !KNOWN.test(r.url())) errors.push(`${r.status()} ${r.url()}`); });
  return { page, errors };
}
/** What the preview frames show, for a failure message. */
const previewText = async (/** @type {import("playwright").Page} */ page) =>
  (await Promise.all(page.frames().filter((f) => /\.preview\.localhost/.test(f.url()))
    .map(async (f) => `${f.url()}: ${JSON.stringify(await f.locator("body").innerText({ timeout: 2000 }).catch(() => "?"))}`))).join(" | ") || "no preview frame";
const previewFrame = (/** @type {import("playwright").Page} */ page) => page.frames().find((f) => /\.preview\.localhost/.test(f.url()) && !/__vm_preview__/.test(f.url()));

// ---- VS Code: boot, Explorer, terminal, gate -------------------------------------------
{
  console.log("# VS Code");
  const { page, errors } = await newPage();
  await page.goto(base);
  await page.locator(".statusbar-item", { hasText: "Linux VM: running" }).first().waitFor({ timeout: 120_000 });
  check("VM running (status bar)", true, secs());
  const row = (/** @type {string} */ name) => page.locator(".explorer-folders-view .monaco-list-row", { hasText: name }).first();
  check("Explorer lists the VM's /root/project", await row("README.md").waitFor({ timeout: 30_000 }).then(() => true, () => false));
  // VS Code draws terminals on a canvas: check through files the command writes.
  const openAndRead = async (/** @type {string} */ name) => {
    if (!(await row(name).waitFor({ timeout: 60_000 }).then(() => true, () => false))) return null;
    await row(name).click();
    await page.waitForTimeout(800);
    return page.locator(".editor-group-container.active .monaco-editor .view-lines").first().innerText().then((t) => t.replace(/\u00a0/g, " "), () => null);
  };
  await page.locator(".xterm").first().waitFor({ timeout: 30_000 });
  await page.locator(".xterm").first().click();
  await page.keyboard.type("echo e2e-$((6*7)) $(uname -m) > /root/project/e2e.txt\n");
  const out = await openAndRead("e2e.txt");
  check("terminal runs a command; its file appears in the Explorer", new RegExp(`e2e-42 ${arch}`).test(out ?? ""), JSON.stringify(out));
  await page.locator(".xterm").first().click();
  await page.keyboard.type("wget -qO- http://unlisted.example.com/ > /root/project/gate.txt 2>&1; echo rc=$? >> /root/project/gate.txt\n");
  const gate = await openAndRead("gate.txt");
  check("the gate refuses an unlisted site", /rc=1/.test(gate ?? ""), JSON.stringify((gate ?? "").slice(0, 120)));
  const gateFrame = page.frames().find((f) => f.url().includes("gate.localhost"));
  const seen = gateFrame ? await gateFrame.evaluate(() => /** @type {any} */ (window).__gate?.state().seen.map((/** @type {any} */ x) => `${x.host}:${x.decision}`)).catch(() => null) : null;
  check("the gate (own origin) recorded it", !!seen?.includes("unlisted.example.com:deny"), JSON.stringify(seen));
  check("no page errors", errors.length === 0, errors.slice(0, 4).join(" | "));
  await page.close();
}

// ---- lite: tree, editor, terminal ----------------------------------------------------------
{
  console.log("# lite");
  const { page, errors } = await newPage();
  await page.goto(`${base}lite/`);
  await page.locator("#state[data-state=running]").waitFor({ timeout: 120_000 });
  check("VM running", true, secs());
  await page.waitForFunction(() => /[#$] *$/m.test(document.querySelector("#terminal .xterm-rows")?.textContent ?? ""), null, { timeout: 30_000 }).catch(() => {});
  await page.locator("#terminal").click();
  await page.keyboard.type("echo lite-$((6*7)) > /root/project/lite.txt\n");
  const row = page.locator("#tree button", { hasText: "lite.txt" });
  check("a file the guest creates appears in the tree", await row.waitFor({ timeout: 20_000 }).then(() => true, () => false));
  await row.click();
  await page.locator(".cm-content", { hasText: "lite-42" }).waitFor({ timeout: 10_000 });
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("saved-by-lite");
  await page.keyboard.press("Control+s");
  await page.waitForTimeout(300);
  await page.locator("#terminal").click();
  await page.keyboard.type("tr a-z A-Z < /root/project/lite.txt\n");
  const ok = await page.waitForFunction(() => /SAVED-BY-LITE/.test(document.querySelector("#terminal .xterm-rows")?.textContent ?? ""), null, { timeout: 15_000 }).then(() => true, () => false);
  check("the guest reads what the editor saved", ok);
  check("no page errors", errors.length === 0, errors.slice(0, 4).join(" | "));
  await page.close();
}

// ---- previews: a dev server in the VM, with hot reload ----------------------------------------
if (!has("svelte-vite")) {
  console.log("SKIP  previews (this build has no svelte-vite playground)");
} else {
  console.log("# preview (svelte-vite, in lite)");
  const { page, errors } = await newPage();
  await page.goto(`${base}lite/?playground=svelte-vite`);
  const app = page.frameLocator("#preview-frame");
  // The first load may show "Nothing is listening yet", which retries every 2 s: wait for the app.
  const shown = await app.locator("h1", { hasText: "Hello from Svelte" }).waitFor({ timeout: 120_000 }).then(() => true, () => false);
  const what = shown ? "" : await previewText(page);
  check("the preview shows the app from the VM's dev server", shown, shown ? secs() : what);
  const frame = previewFrame(page);
  check("on its own origin", !!frame && new URL(frame.url()).origin !== new URL(base).origin, frame?.url());
  await frame?.evaluate(() => { /** @type {any} */ (window).__marker = 1; });
  await page.locator("#terminal").click();
  await page.keyboard.type("sed -i 's/Hello from Svelte/Hello from e2e/' src/App.svelte\n");
  const hot = await app.locator("h1", { hasText: "Hello from e2e" }).waitFor({ timeout: 90_000 }).then(() => true, () => false);
  check("hot reload over the WebSocket tunnel", hot, secs());
  check("as an update, not a page reload", (await previewFrame(page)?.evaluate(() => /** @type {any} */ (window).__marker).catch(() => 0)) === 1);
  check("no page errors", errors.length === 0, errors.slice(0, 4).join(" | "));
  await page.close();
}

if (has("svelte-vite")) {
  console.log("# preview (svelte-vite, in VS Code)");
  const { page, errors } = await newPage();
  await page.goto(`${base}?playground=svelte-vite`);
  let frame;
  for (let i = 0; i < 240 && !frame; i++) { frame = previewFrame(page); if (!frame) await page.waitForTimeout(500); }
  check("the Simple Browser opens the preview by itself", !!frame, secs());
  const shown = frame ? await frame.locator("h1", { hasText: "Hello from Svelte" }).waitFor({ timeout: 90_000 }).then(() => true, () => false) : false;
  check("and shows the app", shown, shown ? secs() : await previewText(page));
  check("no page errors", errors.length === 0, errors.slice(0, 4).join(" | "));
  await page.close();
}

await browser.close();
console.log(`done in ${secs()}`);
process.exit();
