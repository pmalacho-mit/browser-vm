# SvelteKit playground

This is `/root/project` in a Linux VM running in your browser tab. SvelteKit's
dev server is already running on port 5173: the preview shows it (VS Code:
*Linux VM: Preview a Port…*).

- `src/routes/+page.svelte`: the page. Edit and save: the preview updates in place.
- `src/routes/+page.server.js`: its server-side `load`, run by Node in the VM.
- `src/routes/api/time/+server.js`: an API route.

    tail -f /var/log/dev-server.log   # the dev server's output
    npm run build && npm start        # a production build, served on port 3000

The VM emulates a 32-bit x86 CPU in WebAssembly, so the first render of a
changed route takes several seconds. Rollup has no native build for 32-bit
Linux, so package.json swaps in its WebAssembly build (`overrides`).
