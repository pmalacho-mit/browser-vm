// Constants esbuild substitutes at build time (scripts/esbuild.config.mjs, `define`).
// Undefined when the code runs unbundled (e.g. in the Node tests): check with typeof.

/** The VM architecture this site was built for: "i686" or "x86_64". */
declare const __VM_ARCH__: string | undefined;
