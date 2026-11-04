// FileSystemProvider for `vmfs:` URIs, operating directly on v86's in-memory
// 9p filesystem object. The guest kernel sees the same inodes over virtio-9p,
// so an edit saved here is what `cat` in the terminal reads, and vice versa.
import * as vscode from "vscode";

const S_IFMT = 0xf000, S_IFDIR = 0x4000, S_IFREG = 0x8000, S_IFLNK = 0xa000;
const ROOT = 0;

const isDir = (inode) => (inode.mode & S_IFMT) === S_IFDIR;
const isLink = (inode) => (inode.mode & S_IFMT) === S_IFLNK;
const splitPath = (p) => p.split("/").filter((c) => c && c !== ".");

export class VmFileSystemProvider {
  /** @param {Promise<any>} fsReady resolves to v86's FS instance */
  constructor(fsReady) {
    this._emitter = new vscode.EventEmitter();
    this.onDidChangeFile = this._emitter.event;
    this.fsReady = fsReady.then((fs) => { this.fs = fs; this._instrument(fs); return fs; });
  }

  // ---- path resolution -------------------------------------------------

  /** Walk `path` component by component, following symlinks (like the kernel would). */
  _lookup(path, followLast = true) {
    const fs = this.fs;
    let parts = splitPath(path);
    let stack = [ROOT]; // inode ids from root to current dir
    for (let hops = 0, i = 0; i < parts.length; ) {
      const name = parts[i];
      const cur = stack[stack.length - 1];
      if (name === "..") { if (stack.length > 1) stack.pop(); i++; continue; }
      const dir = fs.GetInode(cur);
      if (!isDir(dir)) return { id: -1 };
      const id = dir.direntries.get(name);
      if (id === undefined) return { id: -1, parent: i === parts.length - 1 ? cur : -1, name };
      const inode = fs.GetInode(id);
      const last = i === parts.length - 1;
      if (isLink(inode) && (!last || followLast)) {
        if (++hops > 40) throw vscode.FileSystemError.Unavailable("too many symlinks");
        const target = splitPath(inode.symlink);
        if (inode.symlink.startsWith("/")) stack = [ROOT];
        parts = [...target, ...parts.slice(i + 1)];
        i = 0;
        continue;
      }
      stack.push(id);
      i++;
    }
    const id = stack[stack.length - 1];
    return { id, parent: stack.length > 1 ? stack[stack.length - 2] : -1 };
  }

  async _get(uri, followLast = true) {
    await this.fsReady;
    const r = this._lookup(uri.path, followLast);
    if (r.id === -1) throw vscode.FileSystemError.FileNotFound(uri);
    return { ...r, inode: this.fs.GetInode(r.id) };
  }

  _parentOf(uri) {
    const parentPath = uri.path.replace(/\/[^/]*\/?$/, "") || "/";
    const name = uri.path.split("/").filter(Boolean).pop();
    const p = this._lookup(parentPath);
    if (p.id === -1 || !isDir(this.fs.GetInode(p.id))) throw vscode.FileSystemError.FileNotFound(uri.with({ path: parentPath }));
    return { parentId: p.id, name };
  }

  _type(inode, id) {
    if (isDir(inode)) return vscode.FileType.Directory;
    if (isLink(inode)) {
      const r = this._lookup(this._pathOf(id) ?? "/", true);
      const t = r.id === -1 ? vscode.FileType.Unknown : isDir(this.fs.GetInode(r.id)) ? vscode.FileType.Directory : vscode.FileType.File;
      return t | vscode.FileType.SymbolicLink;
    }
    return (inode.mode & S_IFMT) === S_IFREG ? vscode.FileType.File : vscode.FileType.Unknown;
  }

  // ---- FileSystemProvider ----------------------------------------------

  async stat(uri) {
    const { inode } = await this._get(uri);
    return {
      type: isDir(inode) ? vscode.FileType.Directory : vscode.FileType.File,
      ctime: inode.ctime * 1000,
      mtime: inode.mtime * 1000,
      size: inode.size,
    };
  }

  async readDirectory(uri) {
    const { inode } = await this._get(uri);
    if (!isDir(inode)) throw vscode.FileSystemError.FileNotADirectory(uri);
    const out = [];
    for (const [name, id] of inode.direntries) {
      if (name === "." || name === "..") continue;
      const child = this.fs.GetInode(id);
      if (isLink(child)) {
        const r = this._lookup(`${uri.path}/${name}`, true);
        const t = r.id !== -1 && isDir(this.fs.GetInode(r.id)) ? vscode.FileType.Directory : vscode.FileType.File;
        out.push([name, t | vscode.FileType.SymbolicLink]);
      } else {
        out.push([name, isDir(child) ? vscode.FileType.Directory : vscode.FileType.File]);
      }
    }
    return out;
  }

  async readFile(uri) {
    const { id, inode } = await this._get(uri);
    if (isDir(inode)) throw vscode.FileSystemError.FileIsADirectory(uri);
    // Untouched files are fetched lazily from rootfs/<sha256> on first read.
    const data = await this.fs.Read(id, 0, inode.size);
    return data ? data.slice() : new Uint8Array(0);
  }

  async writeFile(uri, content, { create, overwrite }) {
    await this.fsReady;
    const r = this._lookup(uri.path);
    let id = r.id;
    if (id === -1) {
      if (!create) throw vscode.FileSystemError.FileNotFound(uri);
      const { parentId, name } = this._parentOf(uri);
      id = this.fs.CreateFile(name, parentId);
    } else {
      if (!overwrite) throw vscode.FileSystemError.FileExists(uri);
      if (isDir(this.fs.GetInode(id))) throw vscode.FileSystemError.FileIsADirectory(uri);
    }
    // Write into the *existing* inode (the guest may have it open), then fix size.
    await this.fs.ChangeSize(id, content.length);
    if (content.length) await this.fs.Write(id, 0, content.length, content);
    const inode = this.fs.GetInode(id);
    inode.mtime = inode.ctime = Math.floor(Date.now() / 1000);
  }

  async createDirectory(uri) {
    await this.fsReady;
    if (this._lookup(uri.path).id !== -1) throw vscode.FileSystemError.FileExists(uri);
    const { parentId, name } = this._parentOf(uri);
    this.fs.CreateDirectory(name, parentId);
  }

  async delete(uri, { recursive }) {
    const { id, inode } = await this._get(uri, false);
    const { parentId, name } = this._parentOf(uri);
    if (isDir(inode) && inode.direntries.size > 2 && !recursive) throw vscode.FileSystemError.NoPermissions("directory not empty");
    this._deleteTree(parentId, name, id);
  }

  _deleteTree(parentId, name, id) {
    const inode = this.fs.GetInode(id);
    if (isDir(inode)) {
      for (const [child, cid] of [...inode.direntries]) {
        if (child !== "." && child !== "..") this._deleteTree(id, child, cid);
      }
    }
    const ret = this.fs.Unlink(parentId, name);
    if (ret < 0) throw vscode.FileSystemError.NoPermissions(`unlink failed (${ret})`);
  }

  async rename(oldUri, newUri, { overwrite }) {
    await this._get(oldUri, false);
    const existing = this._lookup(newUri.path, false);
    if (existing.id !== -1) {
      if (!overwrite) throw vscode.FileSystemError.FileExists(newUri);
      await this.delete(newUri, { recursive: true });
    }
    const from = this._parentOf(oldUri), to = this._parentOf(newUri);
    const ret = await this.fs.Rename(from.parentId, from.name, to.parentId, to.name);
    if (ret < 0) throw vscode.FileSystemError.NoPermissions(`rename failed (${ret})`);
  }

  watch() {
    // Change events are global (see _instrument); VS Code filters by watcher.
    return new vscode.Disposable(() => {});
  }

  // ---- change notifications ----------------------------------------------
  //
  // v86's FS has no event API, so wrap the mutating methods on the instance.
  // The guest's virtio-9p server calls these same methods, so files created
  // by `touch foo` in the terminal show up in the Explorer immediately.

  _instrument(fs) {
    const queue = new Map(); // path -> FileChangeType
    let timer;
    const emit = (path, type) => {
      if (!path) return;
      queue.set(path, queue.get(path) === vscode.FileChangeType.Created ? vscode.FileChangeType.Created : type);
      clearTimeout(timer);
      timer = setTimeout(() => {
        const events = [...queue].map(([p, t]) => ({ type: t, uri: vscode.Uri.from({ scheme: "vmfs", path: p }) }));
        queue.clear();
        this._emitter.fire(events);
      }, 50);
    };
    const pathIn = (parentId, name) => {
      const dir = parentId === ROOT ? "" : "/" + fs.GetFullPath(parentId);
      return `${dir}/${name}`;
    };
    const wrap = (method, before, after) => {
      const orig = fs[method].bind(fs);
      fs[method] = (...args) => {
        const ctx = before?.(...args);
        const ret = orig(...args);
        if (after) Promise.resolve(ret).then((r) => after(r, ctx, ...args)).catch(() => {});
        return ret;
      };
    };
    const C = vscode.FileChangeType;
    for (const m of ["CreateFile", "CreateDirectory", "CreateSymlink", "CreateNode"]) {
      wrap(m, null, (_id, _ctx, name, parentId) => emit(pathIn(parentId, name), C.Created));
    }
    wrap("Unlink", (parentId, name) => pathIn(parentId, name), (ret, path) => ret === 0 && emit(path, C.Deleted));
    wrap("Rename",
      (od, on, nd, nn) => [pathIn(od, on), pathIn(nd, nn)],
      (ret, [a, b]) => { if (ret === 0) { emit(a, C.Deleted); emit(b, C.Created); } });
    wrap("Write", null, (_r, _ctx, id) => emit(this._pathOf(id), C.Changed));
  }

  /** Files have no ".." entry, so find a file's path by scanning directories (cheap: ~10k entries). */
  _pathOf(id) {
    const inodes = this.fs.inodes;
    for (let d = 0; d < inodes.length; d++) {
      const dir = inodes[d];
      if (!dir || !isDir(dir)) continue;
      for (const [name, cid] of dir.direntries) {
        if (cid === id && name !== "." && name !== "..") return (d === ROOT ? "" : "/" + this.fs.GetFullPath(d)) + "/" + name;
      }
    }
    return undefined;
  }

  /** Depth-first walk used by the search providers. Yields [path, id, inode] for regular files. */
  *walk(path, { skip = new Set([".git", "node_modules"]) } = {}) {
    const r = this._lookup(path);
    if (r.id === -1) return;
    const stack = [[path.replace(/\/$/, ""), r.id]];
    while (stack.length) {
      const [p, id] = stack.pop();
      const inode = this.fs.GetInode(id);
      if (isDir(inode)) {
        for (const [name, cid] of inode.direntries) {
          if (name === "." || name === ".." || skip.has(name)) continue;
          stack.push([`${p}/${name}`, cid]);
        }
      } else if ((inode.mode & S_IFMT) === S_IFREG) {
        yield [p, id, inode];
      }
    }
  }
}
