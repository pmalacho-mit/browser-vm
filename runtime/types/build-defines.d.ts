// Constants esbuild substitutes at build time (host/build.mjs, `define`).
// Undefined when the code runs unbundled (e.g. in Node): check with typeof.

/** The machine this build's runtime was bundled with (machines/index.mjs). */
declare const __VM_MACHINE__: {
  /** "i686" or "x86_64". */
  arch: string;
} | undefined;
