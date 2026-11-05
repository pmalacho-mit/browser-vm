// A minimal static file server for a built app, for local use. Nothing
// VM-specific happens here: deployed, each folder goes to any static host.
//
//   node tools/serve.mjs dist/<app> [port=8080] [--gate-port=8081] [--preview-ports=8082,8083,8084,8085]
//
// One port serves all three origins of the app, by host name, the way they're
// laid out deployed:
//   localhost             → dist/<app>/site/
//   gate.localhost        → dist/<app>/gate/
//   *.preview.localhost   → dist/<app>/preview/
//   anything else         → site/ (e.g. VS Code's webview origins, <uuid>.localhost)
// --gate-port serves gate/ alone on a second port, and --preview-ports serves
// preview/ alone on each of a list of ports: for port forwarders that route one
// exact host name per port (see build:desolate in package.json). A port that's
// already taken is skipped with a warning.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith("--"));
const app = path.resolve(positional[0] || "dist/ide");
const port = Number(positional[1] || process.env.PORT || 8080);
const gatePort = Number(args.find((a) => a.startsWith("--gate-port="))?.split("=")[1] || 0);
const previewPorts = (args.find((a) => a.startsWith("--preview-ports="))?.split("=")[1] ?? "").split(",").filter(Boolean).map(Number);
if (!fs.existsSync(path.join(app, "site"))) { console.error(`${app}: no site/ folder (build the app first: npm run build)`); process.exit(1); }

const types = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".json": "application/json", ".wasm": "application/wasm",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".ttf": "font/ttf",
  ".woff": "font/woff", ".woff2": "font/woff2", ".map": "application/json",
};

// Guest file blobs are named by the hash of their contents, so a cached copy is
// never stale. Everything else may change between builds: revalidate it.
const IMMUTABLE = /\/rootfs\/[0-9a-f]{10,}\.bin(\.zst)?$/;

/** Which folder a host name gets. */
const folderFor = (/** @type {string} */ host) => {
  const name = host.replace(/:\d+$/, "");
  if (name === "gate.localhost") return "gate";
  if (name.endsWith(".preview.localhost")) return "preview";
  return "site";
};

/** @param {(req: http.IncomingMessage) => string} pick */
const handler = (pick) => (/** @type {http.IncomingMessage} */ req, /** @type {http.ServerResponse} */ res) => {
  const dir = path.join(app, pick(req));
  const url = new URL(req.url ?? "/", "http://x");
  let file = path.join(dir, decodeURIComponent(url.pathname));
  if (!file.startsWith(dir)) { res.writeHead(403).end(); return; }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
  fs.stat(file, (err, st) => {
    if (err) { res.writeHead(404).end("not found"); return; }
    res.writeHead(200, {
      "Content-Type": types[/** @type {keyof typeof types} */ (path.extname(file))] || "application/octet-stream",
      "Content-Length": st.size,
      "Cache-Control": IMMUTABLE.test(url.pathname) ? "public, max-age=31536000, immutable" : "no-cache",
    });
    fs.createReadStream(file).pipe(res);
  });
};

http.createServer(handler((req) => folderFor(req.headers.host ?? ""))).listen(port, () => {
  console.log(`serving ${path.relative(process.cwd(), app) || app} at http://localhost:${port}/  (gate: http://gate.localhost:${port}/, previews: *.preview.localhost:${port})`);
});
/** An extra port that serves one folder; a port already in use is skipped, not fatal. */
const extra = (/** @type {number} */ p, /** @type {"gate" | "preview"} */ folder) => http.createServer(handler(() => folder))
  .on("error", (/** @type {NodeJS.ErrnoException} */ e) => console.warn(`  port ${p} (${folder}): ${e.code === "EADDRINUSE" ? "already in use, skipped" : e.message}`))
  .listen(p);
if (gatePort) { extra(gatePort, "gate"); console.log(`  the gate alone on :${gatePort}`); }
for (const p of previewPorts) extra(p, "preview");
if (previewPorts.length) console.log(`  previews alone on :${previewPorts.join(", :")}`);
