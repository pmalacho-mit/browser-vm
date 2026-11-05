# Svelte + Vite playground

This is `/root/project` in a Linux VM running in your browser tab. Vite's dev
server is already running on port 5173: open the preview to see the app
(VS Code: *Linux VM: Preview a Port…*; it's offered when the playground opens).

Edit `src/App.svelte` and save: the preview updates in place (hot reload).

    tail -f /var/log/dev-server.log   # the dev server's output
    npm run build                     # a production build into dist/
    npm install some-package          # packages from npm (allowed by the network gate)

The VM emulates a 32-bit x86 CPU in WebAssembly. Rollup has no native build for
that, so package.json swaps in its WebAssembly build (`overrides`). The first
transform of a file takes a few seconds; after that, hot reload is quicker.
