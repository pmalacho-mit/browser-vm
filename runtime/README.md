# Runtime: runs one machine with one image

`Runtime` (`src/runtime.ts`) owns a VM and is the only API above it. It works
the same in-process (Node: the MCP server, tests) and across a message channel
(`src/rpc.ts`: a surface talking to the runtime worker in a page), so no
surface touches the emulator.

```
runtime/
  src/          the host half (TypeScript)
    runtime.ts    Runtime: boot, files, search, terminals, exec, ports, previews, playgrounds
    rpc.ts        the protocol: serve(endpoint, api) / connect<T>(endpoint)
    gate.ts       Gate: the runtime's contract with the network gate
    vm.ts         LinuxVM: boots or restores v86, wires consoles, the agent and the network
    vmfs.ts       files and search over v86's in-memory filesystem, with change events
    net.ts        the guest's network: TCP → HTTP(S) → the gate
    preview.ts    PreviewGateway: TCP connections *into* the guest, for previews
    agent-client.ts, blob-cache.ts, guest-config.ts
  guest/        the guest half: vm-init (PID 1), vm-agent (shell agent), agent/ (the Go agent), prebuilt/
  tls/          tls.wasm (Go crypto/tls → WebAssembly) and its loader
  assets.mjs    for build tools: where tls.wasm and the agent binary are
  test/         runtime-test.mjs: the API through the protocol, under Node
```

## The one idea

The guest's root filesystem is a JavaScript object (v86's 9p server). The
Linux kernel mounts it over virtio-9p, and surfaces read and write **the same
inodes** through the runtime. There is no syncing and no second copy. Two
other channels connect the guest: serial ports (terminals on ttyS0, 2, 3; the
agent on ttyS1) and an emulated network card (outbound through the gate,
inbound for previews).

```
surface ──rpc──► Runtime
                  ├─ files, search ─► v86 FS object (JS, in memory) ◄── virtio-9p ── Linux
                  ├─ terminals ─────► serial ports 0/2/3 ──────────────── shells (vm-init)
                  ├─ exec, ports ───► serial port 1 ───────────────────── agent
                  ├─ guest network ◄─ virtio NIC: TCP ends in JS (net.ts) ─► Gate.fetch()
                  └─ previews ──────► v86 connect(port) ──────────────── a server in the guest
```

## The API

`boot`, files (`stat`, `readdir`, `read`, `write`, `mkdir`, `remove`,
`rename`), search (`searchFiles`, `searchText`, with include/exclude globs),
terminals (`openTerminal`, `writeTerminal`, `resizeTerminal`, `closeTerminal`),
processes (`exec`, `ports`), `playgrounds`, and the gate (`showGate`). Events:
`state`, `log`, `fs` (changes from surfaces and the guest alike), `term-data`,
`notice`, `refused`, `booted`. Methods starting with `_` can't be called over
the protocol.

```ts
import { channelEndpoint, connect } from "@browser-vm/runtime/rpc";
import type { Runtime } from "@browser-vm/runtime";

const rt = connect<Runtime>(channelEndpoint(new BroadcastChannel(window.__vmRuntimeChannel!)));
await rt.api.boot({ playground: "python-3.12" });
rt.on("term-data", ({ id, data }) => term.write(data));
const { id } = await rt.api.openTerminal({ rows: 24, cols: 80 });
await rt.api.write("/root/project/main.py", new TextEncoder().encode("print(42)\n"));
const r = await rt.api.exec(["python3", "main.py"], { cwd: "/root/project" });
```

Calls return promises; errors keep their codes (`FileNotFound`, …). A surface
imports only `@browser-vm/runtime/rpc` and types, so the emulator never lands
in its bundle.

**Whoever hosts the runtime** makes it with two things a surface can't give it
over the protocol: `new Runtime({ gate, assets })`. `assets` is the VM folder
(the machine and images, `<site>/vm/` in an app build); `gate` is its only way
to the network. In a browser that's the runtime frame (`../host/`); in Node,
the MCP server (`../surfaces/mcp/`).

## The gate seam

The runtime makes no network request for the guest itself. `src/gate.ts`:

```ts
interface Gate {
  fetch: FetchLike;                 // one guest HTTP(S) request; reject with a GuestError to refuse
  connect?(hooks: GateHooks): void; // notice(n) → every surface; secrets(list) → placeholders in the guest
  show?(text: string): void;        // the gate's own UI, if it has one
}
```

No gate: every guest request is refused. Implementations live in `../gates/`.

## The guest half (`guest/`)

| Piece | What it does |
|---|---|
| `vm-init` (PID 1) | Mounts `/proc`, `/sys`, `/dev`, `/tmp`. Runs a respawning `setsid -c` login shell per console (that gives job control and Ctrl+C) and starts the agent. Independent of the distro's init system. |
| `agent/` (Go) | JSON-lines RPC on ttyS1: `resize` (TIOCSWINSZ → SIGWINCH, so vim/top re-layout), `hangup` (closing a terminal SIGHUPs that session, like SSH), `exec` (exit code, stdout, stderr), `ports` (listening sockets) and `refresh` (after a snapshot restore: reseed the RNG, set the clock, swap in this tab's CA). The runtime writes the binary into the guest before boot, so it works with any image. `npm run agent` rebuilds it, reproducibly. |
| `vm-agent` (shell) | The fallback every image ships: `resize` and `hangup` only. Used when the machine can't run Go (x86_64). |

## Gotchas (each is commented where it's handled)

- **Write into the existing inode.** v86's `create_file()` makes a *new* inode,
  while the guest still holds the old one. `vmfs.ts` does `ChangeSize` +
  `Write` on the existing id instead.
- **Guest page cache.** With 9p `cache=loose`, the guest kept serving stale
  bytes after editor saves. The root is mounted with `cache=mmap`: ordinary
  reads and writes stay uncached (coherent with the editor), while memory-mapped
  files (program binaries and libraries) are cached. With `cache=none`, every
  page of a program was read over 9p as it ran: `node -e 1` took 40 s instead
  of 12.5 s. The kernel command line is in `src/guest-config.ts`.
- **File contents stay cached.** v86 drops a file's downloaded contents when the
  guest closes it, so every run of a program fetched and decompressed it again.
  `src/blob-cache.ts` keeps them in a memory LRU instead (default 256 MiB), and
  keeps the compressed blobs in the browser's Cache Storage, so a second visit
  downloads none. Blob names are content hashes, so serve `vm/rootfs/*` with a
  long `max-age` (`tools/serve.mjs` marks them `immutable`).
- **Change events.** v86's FS has no event API, so `vmfs.ts` wraps
  `CreateFile`/`Write`/`Unlink`/`Rename` on the instance. The guest's 9p server
  calls the same methods, so `touch foo` in a terminal shows up in the editor.
- **No inotify.** The 9p root delivers no inotify events, so dev servers must
  poll for changes (see Previews in `../host/README.md`).
- **Nested workers.** v86 schedules itself with a blob-URL Worker and revokes
  the URL immediately; inside VS Code's extension host (where the VM used to
  run) `Worker` is wrapped and loads the URL later, so `vm.ts` defers
  `URL.revokeObjectURL`.
- **COM4.** Linux runs a loopback self-test only on COM4, and v86's UART doesn't
  emulate loopback, so ttyS3 probed as "unknown". `vm-init` runs
  `setserial /dev/ttyS3 uart 16550A` to declare it.
- **Docker owns `/etc/hostname`**, so it isn't in `docker export`. `vm-init`
  sets the hostname itself.

## Networking (still no server)

The guest has a virtio NIC on v86's fake network stack (ARP, DNS and TCP,
implemented in JavaScript). `src/net.ts` takes over TCP connections to ports 80
and 443 and turns each HTTP request into a call to the gate:

```
guest: wget https://registry.npmjs.org/left-pad
  │ DNS  → v86 answers every name with one fake IP
  │ TCP  → ends in JavaScript (v86 fake TCP stack)
  ▼
:443 → tls.wasm  (Go crypto/tls → WASM, tls/main.go) completes the handshake with a
       certificate for the SNI hostname, signed by a CA generated in this tab
:80  → as is
  ▼
HttpSession: parse HTTP/1.1 (over TLS, the Host must match the SNI) → Gate.fetch()
             → stream the response back as HTTP/1.1
```

- **Per-tab CA.** `tls.wasm` generates a CA when it starts. The runtime writes
  its certificate to `/etc/ssl/certs/browser-vm-ca.pem` before boot, and
  `vm-init` appends it to the system bundle. `/etc/profile.d/browser-vm-network.sh`
  points Node, pip and requests at it, because they ship their own CA lists. The
  private key never leaves the tab's memory. The interception only touches the
  guest's own traffic, and the gate does real TLS to the real site.
- **In a browser, the limit is CORS.** A site is reachable only if it sends
  `Access-Control-Allow-Origin`; otherwise the guest gets `502` with an
  explanation. Measured from Chromium: registry.npmjs.org, pypi.org,
  files.pythonhosted.org, raw.githubusercontent.com, api.github.com and
  index.crates.io work; github.com's git endpoint (`git clone`) is refused
  (the web gate's bridge extension can reach it).
- **Headers.** Ordinary requests forward only CORS-safelisted headers plus
  `authorization`, to avoid preflights. Requests that carry a secret keep all of
  theirs. Cookies are never sent.
- **Ports.** Only 80 and 443 are handled. Anything else (ssh, `git://`, raw TCP)
  is refused, because a page can't open raw sockets.
- **Inside the VM, `localhost` works normally.** `vm-init` writes `/etc/hosts`.
- **Turning it off.** `boot({ network: "off" })` (VS Code: `linuxVm.network`).
- **Cost.** `tls.wasm` is 7.6 MB (2 MB gzipped), loaded in parallel with the VM.
  `npm run tls` rebuilds it (needs Go).

## Tests

`npm run test:runtime` (after `npm run build`) drives the runtime through the
protocol under Node, with a fake gate: files, events, search, exec, terminals,
the gate seam (guest HTTP, secret placeholders, `showGate`), previews, and a
playground restore. `npm run test:boot` (in `../images/test/`) boots the
pieces below the runtime directly.
