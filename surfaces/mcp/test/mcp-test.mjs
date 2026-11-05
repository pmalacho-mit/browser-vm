// Test of the MCP server (surfaces/mcp/server.ts) as an MCP client sees it: spawns it,
// speaks JSON-RPC over its stdio, and calls each tool.
//   npm run build && npm run test:mcp
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const root = path.resolve(import.meta.dirname, "../../..");
const vmDir = path.join(root, "dist/ide/site/vm");
const playground = fs.existsSync(path.join(vmDir, "playgrounds/node-24/manifest.json")) ? "node-24" : "";
const t0 = Date.now();
const elapsed = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const check = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); if (!ok) process.exitCode = 1; };

const server = spawn(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", path.join(root, "surfaces/mcp/server.ts"),
  ...(playground ? ["--playground", playground] : []), "--allow", "allowed.example.com"], { stdio: ["pipe", "pipe", "pipe"] });
let stderr = "";
server.stderr.on("data", (d) => (stderr += d));
const pending = new Map();
let nextId = 1, badLines = 0;
readline.createInterface({ input: server.stdout }).on("line", (line) => {
  let m;
  try { m = JSON.parse(line); } catch { badLines++; console.log(`stdout noise: ${line.slice(0, 120)}`); return; }
  pending.get(m.id)?.(m);
  pending.delete(m.id);
});
const rpc = (method, params) => new Promise((res) => {
  const id = nextId++;
  pending.set(id, res);
  server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
});
const call = async (name, args) => {
  const r = await rpc("tools/call", { name, arguments: args });
  return { text: r.result?.content?.[0]?.text ?? JSON.stringify(r.error), isError: !!r.result?.isError, error: r.error };
};

const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "mcp-test", version: "0" } });
check("initialize", init.result?.protocolVersion === "2025-06-18" && !!init.result?.capabilities?.tools, init.result?.serverInfo?.name);
server.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
const tools = (await rpc("tools/list", {})).result?.tools?.map((t) => t.name) ?? [];
check("tools/list", ["run_command", "read_file", "write_file", "list_directory", "search_text", "list_ports"].every((n) => tools.includes(n)), tools.join(", "));

const w = await call("write_file", { path: "mcp/hello.txt", content: "hello from mcp\n" });
check("write_file (creates parent directories)", !w.isError, `${w.text} (${elapsed()}, includes the VM start${playground ? `, playground ${playground}` : ""})`);
const r = await call("run_command", { command: "tr a-z A-Z < mcp/hello.txt; echo err >&2; exit 3" });
check("run_command: output, stderr and exit code", /exit code: 3/.test(r.text) && /HELLO FROM MCP/.test(r.text) && /stderr:\nerr/.test(r.text), JSON.stringify(r.text));
const rf = await call("read_file", { path: "/root/project/mcp/hello.txt" });
check("read_file", rf.text === "hello from mcp\n", JSON.stringify(rf.text));
const ls = await call("list_directory", {});
check("list_directory", /^mcp\/$/m.test(ls.text), ls.text.replace(/\n/g, " "));
const st = await call("search_text", { pattern: "from mcp" });
check("search_text", /\/root\/project\/mcp\/hello\.txt:1: hello from mcp/.test(st.text), st.text);
const missing = await call("read_file", { path: "nope.txt" });
check("a tool error is a result, not a crash", missing.isError && /error:/.test(missing.text), missing.text);

const net = await call("run_command", { command: "wget -qO- http://not-allowed.example.com/ 2>&1; wget -qO- http://10.1.2.3/ 2>&1; true" });
check("the gate policy refuses unlisted hosts", /not-allowed\.example\.com is not on the allowed list/.test(stderr) || /not on the allowed list/.test(net.text), net.text.split("\n").slice(0, 4).join(" | "));

if (playground) {
  await call("run_command", { command: "node -e \"require('http').createServer((q,s)=>s.end('ok')).listen(4321)\" > /tmp/srv.log 2>&1 &" });
  let ports = "";
  for (let i = 0; i < 40 && !/4321/.test(ports); i++) { ports = (await call("list_ports", {})).text; await new Promise((r) => setTimeout(r, 250)); }
  check("list_ports sees a background server", /4321/.test(ports), ports);
  const v = await call("run_command", { command: "node --version" });
  check("playground toolchain", /v24\./.test(v.text), v.text.split("\n")[2]);
}
const unknown = await rpc("tools/call", { name: "nope", arguments: {} });
check("unknown tool is a protocol error", unknown.error?.code === -32602);
check("nothing but protocol messages on stdout", badLines === 0, `${badLines} stray lines`);
server.stdin.end();
await new Promise((r) => server.on("exit", r));
console.log(`done in ${elapsed()}`);
