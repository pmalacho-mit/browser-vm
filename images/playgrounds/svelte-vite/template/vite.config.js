import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

export default defineConfig({
  plugins: [svelte()],
  server: {
    // The VM's root filesystem (9p) delivers no inotify events, so the watcher
    // polls. That's also what notices files saved from the editor.
    watch: { usePolling: true, interval: 250 },
  },
  // Rollup's native binaries don't exist for 32-bit Linux; package.json swaps in
  // its WebAssembly build (@rollup/wasm-node). esbuild has an ia32 build.
});
