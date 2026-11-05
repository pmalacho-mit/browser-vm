# Rust playground

This is `/root/project` in a Linux VM running in your browser tab, with Rust
and Cargo from Alpine Linux. The project is already built, so the first
`cargo run` only links.

    cargo run                  # build (incrementally) and run
    cargo add itoa             # crates from crates.io (allowed by the network gate)
    cargo build --release

The VM emulates a 32-bit x86 CPU in WebAssembly, and rustc is heavy. Measured
here: a rebuild after an edit takes 3–12 s, and adding a small crate like
`itoa` about 45 s. Crates built on procedural macros are another matter:
`serde` with `derive` took over 20 minutes to compile the first time (after
that, rebuilds are quick again).
