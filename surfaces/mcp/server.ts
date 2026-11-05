// An MCP server that gives an AI agent its own Linux VM: a surface for agents.
// It hosts the same runtime as the browser apps (@browser-vm/runtime), in-process
// under Node, with the node gate (@browser-vm/gate-node) deciding where the guest
// may connect. It speaks MCP over stdio (JSON-RPC, one message per line).
//
//   npm run build      (once: the VM folder comes from dist/ide/site/vm)
//   node --experimental-strip-types surfaces/mcp/server.ts [--playground node-24] [--allow host]... [--network off]
//
// Claude Code:  claude mcp add browser-vm -- node --experimental-strip-types /path/to/surfaces/mcp/server.ts --playground node-24
//
// Tools: run_command, read_file, write_file, list_directory, search_text, list_ports.
// Relative paths are relative to /root/project. The VM starts on the first
// tool call and lives as long as the server; nothing is saved when it exits.
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { parseArgs } from "node:util";
import { Runtime } from "@browser-vm/runtime";
import { nodeGate } from "@browser-vm/gate-node";

// stdout carries the protocol: everything else goes to stderr.
console.log = console.info = console.debug = console.warn = (...a: unknown[]) => console.error(...a);

const { values: args } = parseArgs({
  options: {
    playground: { type: "string", default: "" },
    allow: { type: "string", multiple: true, default: [] },
    network: { type: "string", default: "fetch" },
    "memory-mb": { type: "string", default: "512" },
    assets: { type: "string", default: path.resolve(import.meta.dirname, "../../dist/ide/site/vm") },
  },
});
const assetBase = path.resolve(args.assets!);
if (!fs.existsSync(path.join(assetBase, "fs.json"))) {
  console.error(`browser-vm mcp: no VM assets in ${assetBase}. Run npm run build first, or pass --assets <dir>.`);
  process.exit(1);
}
const PROJECT = "/root/project";
const log = (s: string) => console.error(`[browser-vm] ${s}`);

// v86 reads its own files from disk under Node; the runtime's fetch() calls for
// assets (the agent binary, tls.wasm, playground manifests) get the same here.
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (!url.startsWith("/")) return realFetch(input, init);
  try { return new Response(fs.readFileSync(url)); } catch { return new Response(null, { status: 404 }); }
}) as typeof fetch;

// ---- the guest's network: the node gate --------------------------------------------
//
// The default policy (package registries) plus --allow hosts; no secrets.
const gate = args.network === "off" ? undefined : nodeGate({
  allow: args.allow,
  hint: (host) => `Restart the MCP server with --allow ${host} to allow it.`,
  log,
  fetch: realFetch,
});

// ---- the VM ----------------------------------------------------------------------

const runtime = new Runtime({ gate, assets: assetBase });
runtime.emit = (topic, data) => { if (topic === "log") log(String(data)); };
let ready: Promise<string> | undefined;
/** Starts the VM on first use; resolves to a one-line description of it. */
const vm = () => ready ??= (async () => {
  const r = await runtime.boot({
    memoryMB: Number(args["memory-mb"]),
    network: args.network === "off" ? "off" : "fetch",
    playground: args.playground || undefined,
  });
  if (r.missingPlayground) log(`no playground "${r.missingPlayground}" in ${assetBase}/playgrounds; booted the default image`);
  await runtime.whenReady();
  return r.playground ? r.playground.title : "default image (busybox, apk)";
})();

const abs = (p: string) => (p.startsWith("/") ? p : `${PROJECT}/${p}`).replace(/\/+$/, "") || "/";
const dec = new TextDecoder(), enc = new TextEncoder();
const MAX_OUTPUT = 100_000;
const clip = (s: string) => (s.length > MAX_OUTPUT ? s.slice(0, MAX_OUTPUT) + `\n… (${s.length - MAX_OUTPUT} more characters)` : s);

// ---- tools -------------------------------------------------------------------------

interface Tool {
  description: string;
  inputSchema: Record<string, unknown>;
  run(a: Record<string, any>): Promise<string>;
}
const str = (description: string) => ({ type: "string", description });
const TOOLS: Record<string, Tool> = {
  run_command: {
    description: "Run a shell command (sh -c) in the Linux VM, an i686 Alpine guest emulated in WebAssembly. " +
      "Returns the exit code, stdout and stderr. The working directory defaults to /root/project. " +
      "For servers and other long-running processes, start them in the background with output to a file " +
      "(e.g. `node server.js > /tmp/server.log 2>&1 &`). The VM is slow (an emulated CPU): allow for that in timeouts.",
    inputSchema: {
      type: "object",
      properties: {
        command: str("The command line, run with sh -c."),
        cwd: str("Working directory (default /root/project)."),
        timeout_ms: { type: "number", description: "Kill the command after this many milliseconds (default 120000)." },
      },
      required: ["command"],
    },
    async run({ command, cwd, timeout_ms }) {
      const r = await runtime.exec(["sh", "-lc", command], { cwd: abs(cwd ?? PROJECT), timeoutMs: timeout_ms ?? 120_000 });
      const parts = [`exit code: ${r.code}${r.timedOut ? " (timed out)" : ""} (${r.ms} ms)`];
      if (r.stdout.length) parts.push(`stdout:\n${clip(dec.decode(r.stdout))}`);
      if (r.stderr.length) parts.push(`stderr:\n${clip(dec.decode(r.stderr))}`);
      if (r.truncated) parts.push("(output truncated by the guest agent at 8 MB)");
      return parts.join("\n");
    },
  },
  read_file: {
    description: "Read a text file from the VM.",
    inputSchema: { type: "object", properties: { path: str("Absolute, or relative to /root/project.") }, required: ["path"] },
    async run({ path: p }) { return clip(dec.decode(await runtime.read(abs(p)))); },
  },
  write_file: {
    description: "Create or overwrite a file in the VM (parent directories are created).",
    inputSchema: { type: "object", properties: { path: str("Absolute, or relative to /root/project."), content: str("The whole file.") }, required: ["path", "content"] },
    async run({ path: p, content }) {
      const file = abs(p);
      const dirs = file.split("/").slice(1, -1);
      for (let i = 1; i <= dirs.length; i++) await runtime.mkdir("/" + dirs.slice(0, i).join("/")).catch(() => {});
      await runtime.write(file, enc.encode(content));
      return `wrote ${enc.encode(content).length} bytes to ${file}`;
    },
  },
  list_directory: {
    description: "List a directory in the VM (directories end with /).",
    inputSchema: { type: "object", properties: { path: str("Absolute, or relative to /root/project (default: /root/project).") } },
    async run({ path: p }) {
      const entries = await runtime.readdir(abs(p ?? PROJECT));
      return entries.map(([name, kind, symlink]) => name + (kind === "directory" ? "/" : "") + (symlink ? " (symlink)" : "")).sort().join("\n") || "(empty)";
    },
  },
  search_text: {
    description: "Search file contents under a directory of the VM (skips node_modules and .git). Returns path:line: text.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: str("Text to find (a regular expression if is_regex)."),
        path: str("Directory to search (default /root/project)."),
        is_regex: { type: "boolean" },
        case_sensitive: { type: "boolean" },
      },
      required: ["pattern"],
    },
    async run({ pattern, path: p, is_regex, case_sensitive }) {
      const { matches, limitHit } = await runtime.searchText(abs(p ?? PROJECT), { pattern, isRegExp: !!is_regex, isCaseSensitive: !!case_sensitive }, { maxResults: 200 });
      return (matches.map((m) => `${m.path}:${m.line + 1}: ${m.text}`).join("\n") || "no matches") + (limitHit ? "\n(more matches not shown)" : "");
    },
  },
  list_ports: {
    description: "List the TCP ports that programs in the VM are listening on.",
    inputSchema: { type: "object", properties: {} },
    async run() { const ports = await runtime.ports(); return ports.length ? ports.join("\n") : "nothing is listening"; },
  },
};

// ---- MCP over stdio ------------------------------------------------------------------

const SUPPORTED = ["2025-06-18", "2025-03-26", "2024-11-05"];
const send = (m: unknown) => process.stdout.write(JSON.stringify(m) + "\n");

async function handle(m: { id?: number | string; method?: string; params?: any }) {
  switch (m.method) {
    case "initialize": {
      const asked = m.params?.protocolVersion;
      vm().then((what) => log(`VM ready: ${what}`), (e) => log(`VM failed to start: ${e.message}`)); // start booting now
      return {
        protocolVersion: SUPPORTED.includes(asked) ? asked : SUPPORTED[0],
        capabilities: { tools: {} },
        serverInfo: { name: "browser-vm", version: "0.1.0" },
        instructions: "A Linux VM (i686 Alpine, emulated in WebAssembly) for running code. Files live under /root/project. " +
          "Network access is limited to package registries and hosts the user allowed.",
      };
    }
    case "ping": return {};
    case "tools/list":
      return { tools: Object.entries(TOOLS).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema })) };
    case "tools/call": {
      const tool = TOOLS[m.params?.name];
      if (!tool) throw Object.assign(new Error(`unknown tool: ${m.params?.name}`), { rpcCode: -32602 });
      try {
        await vm();
        return { content: [{ type: "text", text: await tool.run(m.params.arguments ?? {}) }] };
      } catch (e) {
        // A tool error is a result the model sees, not a protocol error.
        return { content: [{ type: "text", text: `error: ${(e as Error).message}` }], isError: true };
      }
    }
    default:
      throw Object.assign(new Error(`method not found: ${m.method}`), { rpcCode: -32601 });
  }
}

readline.createInterface({ input: process.stdin }).on("line", async (line) => {
  if (!line.trim()) return;
  let m;
  try { m = JSON.parse(line); } catch { return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }); }
  if (m.id === undefined) return; // notifications (initialized, cancelled): nothing to answer
  try {
    send({ jsonrpc: "2.0", id: m.id, result: await handle(m) });
  } catch (e) {
    send({ jsonrpc: "2.0", id: m.id, error: { code: (e as { rpcCode?: number }).rpcCode ?? -32603, message: (e as Error).message } });
  }
}).on("close", async () => {
  await runtime.destroy().catch(() => {});
  process.exit(0);
});
