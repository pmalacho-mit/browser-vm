// Test of the runtime through its protocol, as a surface sees it: a Runtime
// served on one end of an in-process endpoint pair, a client on the other (the
// same rpc.ts code that runs over the BroadcastChannel in a page). Boots the
// built ide app's VM folder under Node, with a fake gate, then a playground
// snapshot if the build has one.
//   npm run build && npm run test:runtime
import fs from "node:fs";
import path from "node:path";
import { Runtime } from "@browser-vm/runtime";
import { connect, endpointPair, portEndpoint, serve } from "@browser-vm/runtime/rpc";
import { parseResponse } from "@browser-vm/runtime/preview";

const root = path.resolve(import.meta.dirname, "../..");
const assetBase = path.join(root, "dist/ide/site/vm");
if (!fs.existsSync(path.join(assetBase, "fs.json"))) {
  console.error(`no VM assets in ${assetBase}: run npm run build first`);
  process.exit(1);
}
// v86 reads its own files from disk under Node; the runtime's fetch() calls
// (the agent binary, playground manifests) get the same treatment here.
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = String(input);
  if (!url.startsWith("/")) return realFetch(input, init);
  try { return new Response(fs.readFileSync(url)); } catch { return new Response(null, { status: 404 }); }
};

const enc = new TextEncoder(), dec = new TextDecoder();
const t0 = Date.now();
const elapsed = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const check = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); if (!ok) process.exitCode = 1; };
const until = (cond, what, ms = 60000) => new Promise((res, rej) => {
  const s = Date.now(), iv = setInterval(() => {
    if (cond()) { clearInterval(iv); res(undefined); } else if (Date.now() - s > ms) { clearInterval(iv); rej(new Error(`timeout: ${what}`)); }
  }, 50);
});

/**
 * A runtime and a connected client.
 * @param {import("@browser-vm/runtime").Gate} [gate]
 */
function start(gate) {
  const [server, client] = endpointPair();
  const runtime = new Runtime({ gate, assets: assetBase });
  runtime.emit = serve(server, runtime);
  /** @type {import("@browser-vm/runtime/rpc").Client<Runtime>} */
  const c = connect(client);
  return { runtime, c };
}

// A gate that answers every request itself, and offers one secret placeholder.
const gated = /** @type {string[]} */ ([]), shown = /** @type {string[]} */ ([]);
/** @type {import("@browser-vm/runtime").Gate} */
const fakeGate = {
  fetch: async (url, init) => { gated.push(`${init.method} ${url}`); return new Response(`gated ${url}\n`); },
  connect: (hooks) => hooks.secrets([{ name: "GATE-TEST-KEY", env: "TEST_KEY" }]),
  show: (text) => { shown.push(text); },
};

// ---- cold boot -------------------------------------------------------------------
{
  const { runtime, c } = start(fakeGate);
  const fsEvents = [], states = [];
  void runtime;
  c.on("fs", (changes) => fsEvents.push(...changes));
  c.on("state", (s) => states.push(s));
  let termOut = "";
  c.on("term-data", (m) => (termOut += dec.decode(m.data)));

  // A frontend may ask for files before boot(): the call waits for it.
  const early = c.api.stat("/root/project/README.md");
  // No assetBase: the one the Runtime was made with.
  const booted = await c.api.boot({ memoryMB: 256, network: "fetch" });
  check("boot() answers", typeof booted === "object", JSON.stringify(booted));
  const st = await early;
  check("a call made before boot() waits for the VM", st.kind === "file" && st.size > 0, `${st.kind}, ${st.size} bytes`);

  await c.api.whenReady();
  check("VM ready", true, `${elapsed()}, states ${states.join(" → ")}`);

  // files
  await c.api.mkdir("/root/project/rt");
  await c.api.write("/root/project/rt/hello.txt", enc.encode("hello from the runtime\n"));
  check("write + read round trip", dec.decode(await c.api.read("/root/project/rt/hello.txt")) === "hello from the runtime\n");
  const ls = await c.api.readdir("/root/project/rt");
  check("readdir", JSON.stringify(ls) === JSON.stringify([["hello.txt", "file", false]]), JSON.stringify(ls));
  const err = await c.api.read("/root/project/nope").then(() => null, (e) => e);
  check("errors keep their code across the protocol", err?.code === "FileNotFound" && err?.name === "VmFsError", `${err?.name} ${err?.code}`);
  const noMethod = await c.api["_boot"]?.().then(() => null, (e) => e.message);
  check("private methods aren't callable", /no such method/.test(noMethod ?? ""), noMethod);
  await until(() => fsEvents.some((e) => e.path === "/root/project/rt/hello.txt"), "fs event", 5000).catch(() => {});
  check("fs events reach the client", fsEvents.some((e) => e.path === "/root/project/rt/hello.txt" && e.type === "created"), `${fsEvents.length} events`);

  // processes
  const r = await c.api.exec(["sh", "-c", "cat /root/project/rt/hello.txt | tr a-z A-Z; echo out-$((6*7)) > /root/project/rt/from-guest.txt"]);
  check("exec sees the runtime's write", r.code === 0 && dec.decode(r.stdout) === "HELLO FROM THE RUNTIME\n", `rc=${r.code} ${JSON.stringify(dec.decode(r.stdout))}`);
  check("the runtime sees the guest's write", dec.decode(await c.api.read("/root/project/rt/from-guest.txt")) === "out-42\n");
  await until(() => fsEvents.some((e) => e.path === "/root/project/rt/from-guest.txt"), "guest fs event", 5000).catch(() => {});
  check("guest writes produce fs events", fsEvents.some((e) => e.path === "/root/project/rt/from-guest.txt"));

  // the gate: every guest request goes to it, and nowhere else
  const web = await c.api.exec(["sh", "-c", "wget -qO- http://example.com/via-gate"]);
  check("guest HTTP goes through the gate", dec.decode(web.stdout) === "gated http://example.com/via-gate\n" && gated.includes("GET http://example.com/via-gate"),
    `rc=${web.code} ${JSON.stringify(dec.decode(web.stdout))}`);
  const key = await c.api.exec(["sh", "-lc", "echo $TEST_KEY"]);
  check("the gate's secret placeholders reach the guest's shells", dec.decode(key.stdout) === "GATE-TEST-KEY\n", JSON.stringify(dec.decode(key.stdout)));
  await c.api.showGate("hello gate");
  check("showGate() reaches the gate", shown.includes("hello gate"));

  // search
  const files = await c.api.searchFiles("/root/project", "hello", 50);
  check("searchFiles", files.includes("/root/project/rt/hello.txt"), files.join(", "));
  const text = await c.api.searchText("/root/project", { pattern: "from the runtime" });
  check("searchText", text.matches.some((m) => m.path === "/root/project/rt/hello.txt" && m.line === 0), JSON.stringify(text.matches).slice(0, 160));

  const excluded = await c.api.searchText("/root/project", { pattern: "from the runtime" }, { excludes: ["**/rt"] });
  check("searchText: excluded folders are skipped", excluded.matches.length === 0, `${excluded.matches.length} matches`);
  const included = await c.api.searchFiles("/root/project", "", 50, { includes: ["**/*.txt"] });
  check("searchFiles: includes", included.length > 0 && included.every((p) => p.endsWith(".txt")), included.join(", "));

  // terminals
  const t1 = await c.api.openTerminal({ rows: 30, cols: 100 });
  await until(() => /\$ (\x1b\[6n)?$/.test(termOut), "prompt");
  termOut = "";
  await c.api.writeTerminal(t1.id, "stty size; echo term-$((6*7))\n");
  await until(() => /term-42/.test(termOut), "terminal output").catch(() => {});
  check("terminal runs a command", /term-42/.test(termOut), JSON.stringify(termOut.slice(-60)));
  check("terminal got its size", /30 100/.test(termOut), t1.tty);
  const t2 = await c.api.openTerminal(), t3 = await c.api.openTerminal();
  const full = await c.api.openTerminal().then(() => null, (e) => e.code);
  check("consoles run out after three, with a clear error", full === "NoConsole", `${t1.tty} ${t2.tty} ${t3.tty}`);
  await c.api.closeTerminal(t2.id);
  const t4 = await c.api.openTerminal();
  check("closing a terminal frees its console", t4.tty === t2.tty, t4.tty);

  const ports = await c.api.ports();
  check("ports()", Array.isArray(ports), JSON.stringify(ports));

  // previews: a gateway for one guest port, on a MessagePort of its own
  const r1 = parseResponse(enc.encode("HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nX-A: 1\r\n\r\n5\r\nhello\r\n6;ext=1\r\n world\r\n0\r\n\r\n"));
  check("parseResponse: 100-continue, chunked, headers", r1.status === 200 && dec.decode(r1.body) === "hello world" && r1.headers.some(([k, v]) => k === "x-a" && v === "1") && !r1.headers.some(([k]) => k === "transfer-encoding"));
  const r2 = parseResponse(enc.encode("HTTP/1.0 404 Not Found\r\nContent-Length: 3\r\n\r\nabcdef"));
  check("parseResponse: content-length", r2.status === 404 && dec.decode(r2.body) === "abc");
  // A one-request HTTP server: busybox nc runs the script with the connection as stdin/stdout.
  await c.api.write("/root/srv.sh", enc.encode("read line; echo \"$line\" > /root/request\n" +
    "printf 'HTTP/1.1 200 OK\\r\\nContent-Type: text/plain\\r\\nTransfer-Encoding: chunked\\r\\n\\r\\n5\\r\\nhello\\r\\n0\\r\\n\\r\\n'\n"));
  await c.api.exec(["sh", "-c", "nc -l -p 8000 -e sh /root/srv.sh </dev/null >/dev/null 2>&1 &"]);
  await c.api.exec(["sh", "-c", "nc -l -p 8001 -e cat </dev/null >/dev/null 2>&1 &"]);
  for (let i = 0; i < 40; i++) { if ((await c.api.ports()).includes(8001)) break; await new Promise((r) => setTimeout(r, 100)); }
  const pick = (port) => {
    const ch = new MessageChannel();
    runtime._preview(port, ch.port1);
    /** @type {import("@browser-vm/runtime/internals/rpc").Client<import("@browser-vm/runtime/internals/preview").PreviewGateway>} */
    const gw = connect(portEndpoint(ch.port2));
    return { gw, ch };
  };
  const p8000 = pick(8000);
  const res = await p8000.gw.api.http({ method: "GET", path: "/hi?x=1", headers: [["accept", "text/plain"], ["cookie", "dropped"]] });
  check("preview: HTTP into the guest", res.status === 200 && dec.decode(res.body) === "hello", `${res.status} ${JSON.stringify(dec.decode(res.body))}`);
  check("preview: the guest saw the request", dec.decode(await c.api.read("/root/request")).startsWith("GET /hi?x=1 HTTP/1.1"));
  const refused = await p8000.gw.api.http({ method: "GET", path: "/", headers: [] }).then(() => null, (e) => e.code);
  check("preview: a closed port is refused", refused === "Refused", refused);
  const p8001 = pick(8001);
  const got = [];
  p8001.gw.on("socket-data", (m) => got.push(dec.decode(m.data)));
  const sid = await p8001.gw.api.socketOpen();
  await p8001.gw.api.socketWrite(sid, enc.encode("ping over tcp\n"));
  await until(() => got.join("").includes("ping over tcp"), "echo", 10000).catch(() => {});
  check("preview: raw socket round trip (WebSockets use these)", got.join("").includes("ping over tcp"), JSON.stringify(got.join("")));
  await p8001.gw.api.socketClose(sid);
  for (const p of [p8000, p8001]) { p.ch.port1.close(); p.ch.port2.close(); }
  await c.api.destroy();
}

// ---- playground restore ------------------------------------------------------------
const pg = ["python-3.12", "node-24"].find((id) => fs.existsSync(path.join(assetBase, "playgrounds", id, "manifest.json")));
if (!pg) {
  console.log("SKIP  playground restore (this build has none: npm run playgrounds, then npm run build)");
} else {
  const { c } = start();
  const t = Date.now();
  const listed = await c.api.playgrounds();
  check("playgrounds() lists the build's playgrounds", listed.some((p) => p.id === pg), listed.map((p) => p.id).join(", "));
  const res = await c.api.boot({ assetBase, network: "off", playground: pg });
  await c.api.whenReady();
  check(`playground ${pg} restored`, res.playground?.id === pg, `${res.playground?.title}, ready in ${Date.now() - t} ms`);
  const r = await c.api.exec(pg.startsWith("python") ? ["python3", "-c", "print(6*7)"] : ["node", "-e", "console.log(6*7)"]);
  check("its toolchain runs", r.code === 0 && dec.decode(r.stdout) === "42\n", `rc=${r.code} ${JSON.stringify(dec.decode(r.stdout) + dec.decode(r.stderr))} in ${r.ms} ms`);
  const missing = start();
  const m = await missing.c.api.boot({ assetBase, network: "off", playground: "no-such-playground" });
  check("an unknown playground is reported, not fatal", m.missingPlayground === "no-such-playground");
  await missing.c.api.destroy();
  await c.api.destroy();
}
console.log(`done in ${elapsed()}`);
process.exit();
