// FileSystemProvider for `vmfs:` URIs: VS Code's view of the guest's files,
// served by the VM runtime (runtime/src/vmfs.ts) over its protocol. The guest
// kernel reads the same inodes, so a file saved here is what `cat` in the
// terminal reads, and vice versa.
import * as vscode from "vscode";
import type { Client } from "../../runtime/src/rpc.ts";
import type { Runtime } from "../../runtime/src/runtime.ts";
import type { FileKind, FsChange, FsErrorCode } from "../../runtime/src/vmfs.ts";

const fileType = (kind: FileKind, symlink: boolean) =>
  (kind === "directory" ? vscode.FileType.Directory : kind === "file" ? vscode.FileType.File : vscode.FileType.Unknown) |
  (symlink ? vscode.FileType.SymbolicLink : 0);

const CHANGE: Record<FsChange["type"], vscode.FileChangeType> = {
  created: vscode.FileChangeType.Created,
  changed: vscode.FileChangeType.Changed,
  deleted: vscode.FileChangeType.Deleted,
};

/** Runtime errors (by code) as the errors VS Code understands. */
function vscodeError(e: unknown, uri: vscode.Uri): Error {
  const code = (e as { code?: FsErrorCode }).code;
  switch (code) {
    case "FileNotFound": return vscode.FileSystemError.FileNotFound(uri);
    case "FileExists": return vscode.FileSystemError.FileExists(uri);
    case "FileNotADirectory": return vscode.FileSystemError.FileNotADirectory(uri);
    case "FileIsADirectory": return vscode.FileSystemError.FileIsADirectory(uri);
    case "NoPermissions": return vscode.FileSystemError.NoPermissions((e as Error).message);
    default: return vscode.FileSystemError.Unavailable((e as Error).message);
  }
}

export class VmFileSystemProvider implements vscode.FileSystemProvider {
  private emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  onDidChangeFile = this.emitter.event;
  private rt: Client<Runtime>;

  constructor(rt: Client<Runtime>) {
    this.rt = rt;
    // Changes come from the editor and from the guest alike; VS Code filters by watcher.
    rt.on("fs", (changes: FsChange[]) =>
      this.emitter.fire(changes.map((c) => ({ type: CHANGE[c.type], uri: vscode.Uri.from({ scheme: "vmfs", path: c.path }) }))));
  }

  /** Runs a runtime call, translating its errors for `uri`. */
  private async call<T>(uri: vscode.Uri, f: () => Promise<T>): Promise<T> {
    try { return await f(); } catch (e) { throw vscodeError(e, uri); }
  }

  stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    return this.call(uri, async () => {
      const s = await this.rt.api.stat(uri.path);
      return { type: fileType(s.kind, s.symlink), size: s.size, mtime: s.mtime, ctime: s.ctime };
    });
  }

  readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    return this.call(uri, async () => (await this.rt.api.readdir(uri.path)).map(([name, kind, symlink]): [string, vscode.FileType] => [name, fileType(kind, symlink)]));
  }

  readFile(uri: vscode.Uri): Promise<Uint8Array> {
    return this.call(uri, () => this.rt.api.read(uri.path));
  }

  writeFile(uri: vscode.Uri, content: Uint8Array, o: { create: boolean; overwrite: boolean }) {
    return this.call(uri, () => this.rt.api.write(uri.path, content, o));
  }

  createDirectory(uri: vscode.Uri) {
    return this.call(uri, () => this.rt.api.mkdir(uri.path));
  }

  delete(uri: vscode.Uri, o: { recursive: boolean }) {
    return this.call(uri, () => this.rt.api.remove(uri.path, o));
  }

  rename(oldUri: vscode.Uri, newUri: vscode.Uri, o: { overwrite: boolean }) {
    return this.call(oldUri, () => this.rt.api.rename(oldUri.path, newUri.path, o));
  }

  watch() {
    // Change events are global (see the constructor).
    return new vscode.Disposable(() => {});
  }
}
