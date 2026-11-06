Running **openvscode-server 1.109.5** (its bundled Node 22.21.1, glibc, x86-64) on a Debian bookworm guest, the JIT hands `codegen_finalize` a module that V8 refuses to compile, and the emulator dies:

```
CompileError: WebAssembly.Module(): Compiling function #30 failed:
  i64.store[0] expected type i32, found i64.load of type i64 @+110835
    at v86_64.wasm._RNvNtCs8E8liV3rqD7_6v86_643jit24jit_analyze_and_generate
    at v86_64.wasm.main_loop
```

So an `i64.store` is being emitted with a 64-bit *address* operand (the result of an `i64.load`) where wasm32 wants an `i32`: some 64-bit addressing path writes the effective address to the store without wrapping it.

**When.** Reproduced 3 out of 3 runs with commit `d26cf8d2` (the current `latest` CI release), each time ~20 s after a browser opens the workbench, i.e. when the server accepts the workbench's WebSocket and forks its extension host. It never happens while the server only serves static files, and `node -e`, `claude --version` (a Bun binary) and the Go agent all run fine on the same guest. The code page is V8-generated machine code (so the physical address differs per run; the error is identical every time, always "function #30", the module about 231 KB, `state_flags=0x16`).

**Artifacts** (this folder in browser-vm, `images/claude-probe/repro/`):

- `jit-refused-module.wasm`: the bytes passed to `codegen_finalize` (`index=242, start=0x3154000, len=230976`). `new WebAssembly.Module(bytes)` in Node 22 reproduces the CompileError on its own, so the emitter can be found from the module alone (`wasm2wat`, look at the `i64.store` at that offset and the `i64.load` feeding its address).
- `guest-code-page-0x3154000.bin` + `.disasm.txt`: the 4 KiB guest physical page the block was compiled from (block entry at offset 0), and its disassembly (capstone).

**How to reproduce end to end** (browser-vm, branch `issue/5`): `images/claude-probe/build.sh` builds the guest image (Docker, linux/amd64), then
`node --experimental-strip-types images/test/vscode-server-probe.mjs --image=build/guest-claude --mem=1536 --browser`
boots it under Node with this emulator, starts the server, and opens the workbench in headless Chromium. On failure the probe writes the refused module and the code page to `build/probe/`.

With `disable_jit: true` the same workload runs (slowly) without the error, so it is the JIT, not the interpreter.
