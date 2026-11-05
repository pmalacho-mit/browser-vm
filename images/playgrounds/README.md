# Playgrounds

A playground is a VM that starts from a snapshot instead of booting: the
runtime is installed, warmed up and waiting at a shell prompt, with a starter
project in `/root/project`. Open one with `?playground=<id>` on the IDE's URL,
or the VS Code command *Linux VM: Open a Playground…*.

Each folder here is one playground:

- `playground.json`: the manifest (fields below).
- `template/`: the starter project, copied to `/root/project`.

`npm run playgrounds` builds them all (`npm run playgrounds -- python-3.12` for
one) into `build/playgrounds/`, and an app build ships the ones the app asks for
(its `playgrounds` setting) that match its machine's emulator and kernel. See
`images/builder/build-playgrounds.mjs`, and `images/README.md` for how a
playground is built and what one costs.

| Field | Meaning |
|---|---|
| `title`, `description` | Shown in the playground picker. |
| `alpine` | Alpine release the packages come from (e.g. `"3.23"`). Language versions follow it. |
| `packages` | Alpine packages to install. |
| `warmup` | Shell commands run in `/root/project` before the snapshot is taken, e.g. to load a runtime once so its files are cached. They may use the network (unrestricted at build time). |
| `memoryMB` | Guest RAM. Restore time and snapshot size grow with it. |
| `open` | Files to open in the editor after the restore. |
| `npm` | `true`: run `npm ci` for the template (it needs a `package-lock.json`) on the build host, for the guest's platform (`--os=linux --cpu=ia32 --libc=musl`), with install scripts skipped. Much faster than npm in the emulator. |
| `server` | A dev server to have running in the snapshot: `{ "command": "npm run dev", "port": 5173, "warm": ["/"] }`. The builder starts it (output in `/var/log/dev-server.log`), waits for the port, then fetches `warm` and every module the served code imports, so the server has done its first transforms. Surfaces open a preview of the port after the restore. It must listen on `0.0.0.0` and poll for file changes (see "Previews" in `host/README.md`). |
