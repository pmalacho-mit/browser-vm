# Playgrounds

A playground is a VM that starts from a snapshot instead of booting: the
runtime is installed, warmed up and waiting at a shell prompt, with a starter
project in `/root/project`. Open one with `?playground=<id>` on the IDE's URL,
or the VS Code command *Linux VM: Open a Playground…*.

Each folder here is one playground:

- `playground.json`: the manifest (fields below).
- `template/`: the starter project, copied to `/root/project`.

`npm run playgrounds` builds them all (`npm run playgrounds -- python-3.12` for
one) into `build/playgrounds/`, and `npm run build` ships every playground that
matches the site's emulator and kernel. See `scripts/build-playgrounds.mjs`.

| Field | Meaning |
|---|---|
| `title`, `description` | Shown in the playground picker. |
| `alpine` | Alpine release the packages come from (e.g. `"3.23"`). Language versions follow it. |
| `packages` | Alpine packages to install. |
| `warmup` | Shell commands run in `/root/project` before the snapshot is taken, e.g. to load a runtime once so its files are cached. They may use the network (unrestricted at build time). |
| `memoryMB` | Guest RAM. Restore time and snapshot size grow with it. |
| `open` | Files to open in the editor after the restore. |
