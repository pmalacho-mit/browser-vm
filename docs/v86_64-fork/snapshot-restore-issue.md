# Restoring a saved state crashes a 64-bit guest: 64-bit CPU state is missing from `save_state()`

Filed against: <https://github.com/portlandhodl/v86_64> at `c394574477b57eadfc859f593b4aecb08fa37cb6`
(the CI release `latest` of 2026-10-15; also reproduced with a source build of the same commit).

## Summary

`save_state()` on a booted 64-bit Linux guest succeeds. An emulator started from
that state (or `restore_state()` into a fresh one) panics on the next interrupt:

```
panicked at src/rust/cpu/cpu.rs:3756:13:
Triple fault: page fault during #DF delivery, cr2=ec0
RuntimeError: unreachable
    at ...cpu3cpu26trigger_pagefault_extended
    at ...cpu3cpu12do_page_walk
    at ...cpu3cpu21call_interrupt_vector
    at ...cpu3cpu26trigger_pagefault_extended
```

The same save/restore works for a 32-bit guest with upstream v86 and with this fork.

## Cause

The 64-bit work moved several pieces of CPU state into new 64-bit globals in the
wasm memory (`src/rust/cpu/global_pointers.rs`), keeping the old `i32` slots only
as low-half mirrors. `CPU.prototype.get_state` / `set_state` in `src/cpu.js`
save and restore the old `i32` slots (for example `state[5] = this.idtr_offset[0]`)
but none of the new globals, so after a restore they are 0.

`cr2=0xec0` shows the first consequence directly. In x86_64 Linux the IDT lives at
`0xfffffe0000000000` (cpu_entry_area); its low 32 bits are 0. After restore
`idtr_offset64` is 0, so the first timer interrupt (`LOCAL_TIMER_VECTOR` = 0xEC)
reads its gate descriptor from `0 + 0xEC × 16 = 0xec0`, which isn't mapped:
page fault, then #DF, then triple fault. Some runs show `cr2=80` instead: the
double fault's own gate, vector 8 × 16, read from the same zero base.

Globals that are not saved (offsets from `global_pointers.rs`):

| Global | Offset | Why it matters after restore |
|---|---|---|
| `idtr_offset64` | 392 | IDT base: every interrupt (the crash above) |
| `gdtr_offset64` | 400 | GDT base: segment loads, `iretq`, `syscall`/`sysret` selectors |
| `tss_base64` | 456 | RSP0/IST stacks on interrupts from user mode |
| `fs_base`, `gs_base`, `kernel_gs_base` | 336, 344, 352 | TLS and per-CPU data (`swapgs`); kernel faults on first per-CPU access |
| `star`, `lstar`, `cstar`, `sfmask` | 304, 312, 320, 328 | `syscall` entry point and flags: the first system call after restore |
| `sysenter_esp64`, `sysenter_eip64` | 408, 416 | `sysenter` from 64-bit code |
| `cr2_64` | 384 | full fault address (a fault in flight at save time) |
| `cr3_high` | 440 | bits 32–63 of CR3 (0 while RAM < 4 GiB, but should round-trip) |
| `last_op1_64`, `last_result_64` | 280, 288 | lazy flags when `last_op_size` is 64-bit at save time |
| `misc_enable` | 424 | IA32_MISC_ENABLE value |
| `nmi_pending`, `nmi_blocked` | 432, 433 | NMI state |
| `high_memory_size` | 448 | mem64 build only |

`efer` (`state[92]`), `instruction_pointer` / `previous_ip` (`state[37]`, `state[38]`),
the high register halves (`state[94]`, `state[95]`) and the upper XMM halves
(`state[97]`) already round-trip, so the pattern for the fix exists.

## Suggested fix

1. In `src/cpu.js`, add views for the globals above next to the existing ones
   (for example `this.idtr_offset64 = view(Uint32Array, memory, 392, 2)`, as `efer` does).
2. Save them in `get_state` under new indices (99 and up; 0–98 are taken) and
   restore them in `set_state`, defaulting to 0 when an older state image lacks them
   (the same way `state[94]` / `state[96]` are read today).
3. After restoring, recompute anything derived from them, for example whatever
   `update_efer_lma()` or a TLB/JIT flush would otherwise do, so cached translations
   don't outlive the restore.
4. Check that nothing else in `global_pointers.rs` added for 64-bit is missing from
   this list: every global that the 64-bit code reads must either round-trip or be
   derived on restore.

`STATE_VERSION` can stay at 6 if old images still load (new fields default to 0).

## Reproduce

Development environment: `.devcontainer/` next to this file (native linux/arm64 on
Apple Silicon; also works on amd64). In it, `make all-debug` and the release build
succeed, and the bug reproduces with the freshly built `build/libv86.mjs` + `build/v86.wasm`.

**With the fork's own test image** (no outside files): `tests/longmode/alpine.js`
already boots Alpine's x86_64 "virt" ISO to a root shell. After its command runs,
add a save, a restore into a new emulator, and a second command:

```js
const state = await emulator.save_state();
await emulator.stop();
const restored = new V86({ ...same_config, initial_state: { buffer: state }, autostart: true });
// send "uname -m; ls /\n" on the serial console and wait for the output
```

Before the fix: triple fault on the first interrupt after restore. After: the
command's output, with `x86_64` from `uname -m`.

**With browser-linux-ide** (a v86 IDE that has a 64-bit option): in a checkout with
the fixed `libv86.mjs` / `v86.wasm` in `vendor/v86_64/`,

```
npm ci
npm run profile:boot:x86_64     # cold boot, save, restore, "shell answered"
npm run test:boot:x86_64        # cold-boot regression check (14 checks)
```

Before the fix, `profile:boot:x86_64` crashes after "zstd -19 … MB" with the panic above.

## Tests to add

- A save/restore test for a 64-bit guest, run with the JIT and with `DISABLE_JIT=1`.
  `tests/api/state.js` covers only 32-bit images today, which is how this slipped through.
- After the restore, run a user-space program (`ls`, `uname`), not just an `echo` in
  the shell. A user program makes system calls, which go through `lstar`, `kernel_gs_base`
  and the TSS, and some of those paths only fail on the first `syscall`.
- Ideally, restore into a *fresh* emulator (new `V86` with `initial_state`), as an
  application does on page load, and also `restore_state()` into the running one.

## Acceptance

- The Alpine save/restore test passes, with and without the JIT.
- The existing test suites still pass, and 32-bit state images (including older
  ones) still restore.
- `npm run profile:boot:x86_64` in browser-linux-ide prints "shell answered".
