// Minimal static file server for local testing — nothing VM-specific happens
// here. Any static host works (nginx, GitHub Pages, S3, `python3 -m http.server`).
//   node scripts/serve.mjs [dir=dist] [port=8080]
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const dir = path.resolve(process.argv[2] || "dist");
// Extra ports serve the same files on another origin (e.g. for the network gate).
const ports = (process.argv.length > 3 ? process.argv.slice(3) : [process.env.PORT || 8080]).map(Number);
const types = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".json": "application/json", ".wasm": "application/wasm",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".ttf": "font/ttf",
  ".woff": "font/woff", ".woff2": "font/woff2", ".map": "application/json",
};

// Guest file blobs are named by the hash of their contents, so a cached copy is
// never stale. Everything else may change between builds: revalidate it.
const IMMUTABLE = /\/rootfs\/[0-9a-f]{10,}\.bin(\.zst)?$/;

const handler = (/** @type {http.IncomingMessage} */ req, /** @type {http.ServerResponse} */ res) => {
  const url = new URL(req.url ?? "/", "http://x");
  let file = path.join(dir, decodeURIComponent(url.pathname));
  if (!file.startsWith(dir)) { res.writeHead(403).end(); return; }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
  fs.stat(file, (err, st) => {
    if (err) { res.writeHead(404).end("not found"); return; }
    res.writeHead(200, {
      "Content-Type": types[path.extname(file)] || "application/octet-stream",
      "Content-Length": st.size,
      "Cache-Control": IMMUTABLE.test(url.pathname) ? "public, max-age=31536000, immutable" : "no-cache",
    });
    fs.createReadStream(file).pipe(res);
  });
};
for (const port of ports) http.createServer(handler).listen(port, () => console.log(`serving ${dir} at http://localhost:${port}/`));
