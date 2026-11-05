// Browser test of the python app (apps/python): lite alone at the site root,
// opening in the Python playground, with the web gate and no previews.
//
//   npm run build -- python && npm run test:e2e:python
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { chromium } from "playwright";

const root = path.resolve(import.meta.dirname, "../../..");
const app = path.join(root, "dist/python");
if (!fs.existsSync(path.join(app, "site/index.html"))) { console.error("no build in dist/python/: run npm run build -- python first"); process.exit(1); }
const hasPlayground = fs.existsSync(path.join(app, "site/vm/playgrounds/python-3.12/manifest.json"));

const check = (/** @type {string} */ name, /** @type {boolean} */ ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!ok) process.exitCode = 1;
};
const t0 = Date.now();
const secs = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

const port = await new Promise((res) => { const s = http.createServer().listen(0, () => { const p = /** @type {import("node:net").AddressInfo} */ (s.address()).port; s.close(() => res(p)); }); });
const server = spawn(process.execPath, [path.join(root, "tools/serve.mjs"), app, String(port)], { stdio: "ignore" });
process.on("exit", () => server.kill());
const base = `http://localhost:${port}/`;
for (let i = 0; i < 50; i++) { if (await fetch(base).then((r) => r.ok, () => false)) break; await new Promise((r) => setTimeout(r, 100)); }

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
/** @type {string[]} */
const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("response", (r) => { if (r.status() >= 400 && r.url().startsWith(base) && !/favicon/.test(r.url())) errors.push(`${r.status()} ${r.url()}`); });

await page.goto(base);
check("the app's title", (await page.title()) === "Python in a Browser VM", await page.title());
await page.locator("#state[data-state=running]").waitFor({ timeout: 120_000 });
check("VM running", true, secs());
if (hasPlayground) {
  check("it starts in the Python playground", await page.locator("#title", { hasText: "Python 3.12" }).isVisible(), await page.locator("#title").innerText());
  await page.waitForFunction(() => /[#$] *$/m.test(document.querySelector("#terminal .xterm-rows")?.textContent ?? ""), null, { timeout: 30_000 }).catch(() => {});
  await page.locator("#terminal").click();
  await page.keyboard.type("python3 -c 'print(6*7, \"from-python\")'\n");
  const ran = await page.waitForFunction(() => /42 from-python/.test(document.querySelector("#terminal .xterm-rows")?.textContent ?? ""), null, { timeout: 30_000 }).then(() => true, () => false);
  check("python3 runs in the terminal", ran);
} else {
  console.log("SKIP  the Python playground (not built: npm run playgrounds -- python-3.12, then rebuild)");
}
check("no link to VS Code (this app has none)", await page.locator("#full").isHidden());
check("the gate is embedded from its own origin", page.frames().some((f) => f.url().startsWith(`http://gate.localhost:${port}/`)));
check("no page errors", errors.length === 0, errors.slice(0, 4).join(" | "));
await browser.close();
console.log(`done in ${secs()}`);
process.exit();
