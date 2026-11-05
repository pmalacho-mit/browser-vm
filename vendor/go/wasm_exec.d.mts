// Types for wasm_exec.mjs (Go's WebAssembly runtime glue; see the header there).

export interface Go {
  importObject: WebAssembly.Imports;
  run(instance: WebAssembly.Instance): Promise<void>;
}

/** Returns Go's `Go` class, installing its globals on `globalThis` (a private object). */
export function makeGo(globalThis: object): new () => Go;
