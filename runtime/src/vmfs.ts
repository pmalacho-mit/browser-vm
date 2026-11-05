// The guest's files, as a path-based API over v86's in-memory 9p filesystem.
// The guest kernel sees the same inodes over virtio-9p, so a file written here
// is what `cat` in the guest reads next, and vice versa. Editors use this
// through the runtime protocol (protocol.ts); the VS Code extension adapts it
// to a FileSystemProvider.
import type { V86Filesystem, V86Inode } from "v86";

const S_IFMT = 0xf000, S_IFDIR = 0x4000, S_IFREG = 0x8000, S_IFLNK = 0xa000;
const ROOT = 0;

const isDir = (inode: V86Inode) => (inode.mode & S_IFMT) === S_IFDIR;
const isLink = (inode: V86Inode) => (inode.mode & S_IFMT) === S_IFLNK;
const isFile = (inode: V86Inode) => (inode.mode & S_IFMT) === S_IFREG;
const splitPath = (p: string) => p.split("/").filter((c) => c && c !== ".");

export type FileKind = "file" | "directory" | "other";

export interface VmStat {
  kind: FileKind;
  /** The path itself is a symlink (`kind` describes its target). */
  symlink: boolean;
  size: number;
  /** Milliseconds since the epoch. */
  mtime: number;
  ctime: number;
}

/** One directory entry: name, kind (of the target, for symlinks), symlink. */
export type DirEntry = [name: string, kind: FileKind, symlink: boolean];

export interface FsChange {
  type: "created" | "changed" | "deleted";
  path: string;
}

export type FsErrorCode = "FileNotFound" | "FileExists" | "FileNotADirectory" | "FileIsADirectory" | "NoPermissions" | "Unavailable";

/** A filesystem error with a code an editor can map to its own errors. */
export class VmFsError extends Error {
  code: FsErrorCode;
  path?: string;
  constructor(code: FsErrorCode, message: string, path?: string) {
    super(message);
    this.name = "VmFsError";
    this.code = code;
    this.path = path;
  }
}

export interface TextQuery {
  pattern: string;
  isRegExp?: boolean;
  isCaseSensitive?: boolean;
  isWordMatch?: boolean;
}

/** One line with matches: 0-based line number, the line, and [start, end) columns. */
export interface TextMatch {
  path: string;
  line: number;
  text: string;
  ranges: [number, number][];
}

/** `id` is -1 when the path doesn't exist; `parent` is then the directory it would go in (or -1). */
interface Lookup {
  id: number;
  parent?: number;
  name?: string;
}

/** The v86 FS methods that change the tree; wrapped to produce change events. */
type MutatingMethod = "CreateFile" | "CreateDirectory" | "CreateSymlink" | "CreateNode" | "Unlink" | "Rename" | "Write";

const DEFAULT_SKIP = new Set([".git", "node_modules"]);

/**
 * A glob (as in VS Code's search.exclude: "**\/node_modules", "src/*.{js,ts}")
 * as a RegExp over paths relative to the searched folder.
 */
export function globToRegExp(glob: string): RegExp {
  let re = "", i = 0, braces = 0;
  const g = glob.replace(/^\.?\//, "");
  while (i < g.length) {
    const c = g[i];
    if (g.startsWith("**/", i)) { re += "(?:.*/)?"; i += 3; continue; }
    if (g.startsWith("**", i)) { re += ".*"; i += 2; continue; }
    if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else if (c === "{") { re += "(?:"; braces++; }
    else if (c === "}" && braces) { re += ")"; braces--; }
    else if (c === "," && braces) re += "|";
    else if (c === "[") { const end = g.indexOf("]", i); if (end > i) { re += g.slice(i, end + 1).replace(/^\[!/, "[^"); i = end + 1; continue; } re += "\\["; }
    else re += c.replace(/[.+^${}()|\]\\]/g, "\\$&");
    i++;
  }
  return new RegExp(`^${re}$`);
}

/** Which paths a search looks at: globs relative to its folder. */
export interface SearchScope {
  /** Only files matching one of these (none: all files). */
  includes?: string[];
  /** Not files or folders matching any of these (none given: .git and node_modules). */
  excludes?: string[];
}

export class VmFs {
  fs!: V86Filesystem;
  fsReady: Promise<V86Filesystem>;
  private watchers = new Set<(changes: FsChange[]) => void>();

  /** @param fsReady resolves to v86's FS instance */
  constructor(fsReady: Promise<V86Filesystem>) {
    this.fsReady = fsReady.then((fs) => { this.fs = fs; this.instrument(fs); return fs; });
  }

  // ---- path resolution -------------------------------------------------

  /** Walk `path` component by component, following symlinks (like the kernel would). */
  private lookup(path: string, followLast = true): Lookup {
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
        if (++hops > 40) throw new VmFsError("Unavailable", "too many symlinks", path);
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

  private async get(path: string, followLast = true) {
    await this.fsReady;
    const r = this.lookup(path, followLast);
    if (r.id === -1) throw new VmFsError("FileNotFound", `no such file: ${path}`, path);
    return { ...r, inode: this.fs.GetInode(r.id) };
  }

  private parentOf(path: string) {
    const parentPath = path.replace(/\/[^/]*\/?$/, "") || "/";
    const name = path.split("/").filter(Boolean).pop() ?? "";
    const p = this.lookup(parentPath);
    if (p.id === -1 || !isDir(this.fs.GetInode(p.id))) throw new VmFsError("FileNotFound", `no such directory: ${parentPath}`, parentPath);
    return { parentId: p.id, name };
  }

  private kindOf(inode: V86Inode): FileKind {
    return isDir(inode) ? "directory" : isFile(inode) ? "file" : "other";
  }

  // ---- operations ------------------------------------------------------

  async stat(path: string): Promise<VmStat> {
    await this.fsReady;
    const own = this.lookup(path, false);
    if (own.id === -1) throw new VmFsError("FileNotFound", `no such file: ${path}`, path);
    const symlink = isLink(this.fs.GetInode(own.id));
    const target = symlink ? this.lookup(path, true) : own;
    const inode = this.fs.GetInode(target.id === -1 ? own.id : target.id);
    return {
      kind: target.id === -1 ? "other" : this.kindOf(inode),
      symlink,
      size: inode.size,
      mtime: inode.mtime * 1000,
      ctime: inode.ctime * 1000,
    };
  }

  async readdir(path: string): Promise<DirEntry[]> {
    const { inode } = await this.get(path);
    if (!isDir(inode)) throw new VmFsError("FileNotADirectory", `not a directory: ${path}`, path);
    const out: DirEntry[] = [];
    for (const [name, id] of inode.direntries) {
      if (name === "." || name === "..") continue;
      const child = this.fs.GetInode(id);
      if (isLink(child)) {
        const r = this.lookup(`${path.replace(/\/$/, "")}/${name}`, true);
        out.push([name, r.id === -1 ? "other" : this.kindOf(this.fs.GetInode(r.id)), true]);
      } else {
        out.push([name, this.kindOf(child), false]);
      }
    }
    return out;
  }

  async read(path: string): Promise<Uint8Array> {
    const { id, inode } = await this.get(path);
    if (isDir(inode)) throw new VmFsError("FileIsADirectory", `is a directory: ${path}`, path);
    // Untouched files are fetched lazily from rootfs/<sha256> on first read.
    const data = await this.fs.Read(id, 0, inode.size);
    return data ? data.slice() : new Uint8Array(0);
  }

  async write(path: string, content: Uint8Array, { create = true, overwrite = true } = {}) {
    await this.fsReady;
    const r = this.lookup(path);
    let id = r.id;
    if (id === -1) {
      if (!create) throw new VmFsError("FileNotFound", `no such file: ${path}`, path);
      const { parentId, name } = this.parentOf(path);
      id = this.fs.CreateFile(name, parentId);
    } else {
      if (!overwrite) throw new VmFsError("FileExists", `file exists: ${path}`, path);
      if (isDir(this.fs.GetInode(id))) throw new VmFsError("FileIsADirectory", `is a directory: ${path}`, path);
    }
    // Write into the *existing* inode (the guest may have it open), then fix size.
    await this.fs.ChangeSize(id, content.length);
    if (content.length) await this.fs.Write(id, 0, content.length, content);
    const inode = this.fs.GetInode(id);
    inode.mtime = inode.ctime = Math.floor(Date.now() / 1000);
  }

  async mkdir(path: string) {
    await this.fsReady;
    if (this.lookup(path).id !== -1) throw new VmFsError("FileExists", `file exists: ${path}`, path);
    const { parentId, name } = this.parentOf(path);
    this.fs.CreateDirectory(name, parentId);
  }

  async remove(path: string, { recursive = false } = {}) {
    const { id, inode } = await this.get(path, false);
    const { parentId, name } = this.parentOf(path);
    if (isDir(inode) && inode.direntries.size > 2 && !recursive) throw new VmFsError("NoPermissions", `directory not empty: ${path}`, path);
    this.deleteTree(parentId, name, id);
  }

  private deleteTree(parentId: number, name: string, id: number) {
    const inode = this.fs.GetInode(id);
    if (isDir(inode)) {
      for (const [child, cid] of [...inode.direntries]) {
        if (child !== "." && child !== "..") this.deleteTree(id, child, cid);
      }
    }
    const ret = this.fs.Unlink(parentId, name);
    if (ret < 0) throw new VmFsError("NoPermissions", `unlink failed (${ret})`);
  }

  async rename(from: string, to: string, { overwrite = false } = {}) {
    await this.get(from, false);
    if (this.lookup(to, false).id !== -1) {
      if (!overwrite) throw new VmFsError("FileExists", `file exists: ${to}`, to);
      await this.remove(to, { recursive: true });
    }
    const a = this.parentOf(from), b = this.parentOf(to);
    const ret = await this.fs.Rename(a.parentId, a.name, b.parentId, b.name);
    if (ret < 0) throw new VmFsError("NoPermissions", `rename failed (${ret})`);
  }

  /** Calls `cb` with batches of changes (from the editor and from the guest alike). */
  watch(cb: (changes: FsChange[]) => void) {
    this.watchers.add(cb);
    return { dispose: () => { this.watchers.delete(cb); } };
  }

  // ---- search ------------------------------------------------------------

  /**
   * Depth-first walk over regular files. Yields [path, id, inode]. Excluded
   * folders are never entered, so their files are never read (or downloaded).
   */
  *walk(path: string, scope: SearchScope = {}): Generator<[string, number, V86Inode]> {
    const r = this.lookup(path);
    if (r.id === -1) return;
    const root = path.replace(/\/$/, "");
    const excludes = scope.excludes?.length ? scope.excludes.map(globToRegExp) : null;
    const includes = scope.includes?.length ? scope.includes.map(globToRegExp) : null;
    const excluded = (rel: string, name: string) => excludes ? excludes.some((re) => re.test(rel)) : DEFAULT_SKIP.has(name);
    const stack: [string, number][] = [[root, r.id]];
    while (stack.length) {
      const [p, id] = stack.pop()!;
      const inode = this.fs.GetInode(id);
      if (isDir(inode)) {
        for (const [name, cid] of inode.direntries) {
          if (name === "." || name === "..") continue;
          const child = `${p}/${name}`;
          if (excluded(child.slice(root.length + 1), name)) continue;
          stack.push([child, cid]);
        }
      } else if (isFile(inode)) {
        if (includes && !includes.some((re) => re.test(p.slice(root.length + 1)))) continue;
        yield [p, id, inode];
      }
    }
  }

  /** File paths under `folder` whose path contains `pattern`'s characters in order (case-insensitive). */
  async searchFiles(folder: string, pattern: string, maxResults = 1000, scope: SearchScope = {}): Promise<string[]> {
    await this.fsReady;
    const needle = pattern.toLowerCase().replace(/\s+/g, "");
    const out: string[] = [];
    for (const [path] of this.walk(folder, scope)) {
      if (out.length >= maxResults) break;
      // cheap subsequence filter; editors do their own fuzzy scoring
      if (needle && !isSubsequence(needle, path.toLowerCase())) continue;
      out.push(path);
    }
    return out;
  }

  /** Lines matching `query` in text files under `folder`. Skips binaries and files over maxFileSize. */
  async searchText(folder: string, query: TextQuery, { maxResults = 10_000, maxFileSize = 2 << 20, ...scope }: { maxResults?: number; maxFileSize?: number } & SearchScope = {}): Promise<{ matches: TextMatch[]; limitHit: boolean }> {
    await this.fsReady;
    let source = query.isRegExp ? query.pattern : query.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (query.isWordMatch) source = `\\b${source}\\b`;
    const re = new RegExp(source, query.isCaseSensitive ? "g" : "gi");
    const decoder = new TextDecoder();
    const matches: TextMatch[] = [];
    for (const [path, id, inode] of this.walk(folder, scope)) {
      if (inode.size > maxFileSize) continue;
      const bytes = await this.fs.Read(id, 0, inode.size);
      if (!bytes || bytes.includes(0)) continue; // skip binaries
      const lines = decoder.decode(bytes).split("\n");
      for (let ln = 0; ln < lines.length; ln++) {
        const text = lines[ln];
        re.lastIndex = 0;
        const ranges: [number, number][] = [];
        let m;
        while ((m = re.exec(text))) {
          if (m[0].length === 0) { re.lastIndex++; continue; }
          ranges.push([m.index, m.index + m[0].length]);
        }
        if (ranges.length) {
          matches.push({ path, line: ln, text, ranges });
          if (matches.length >= maxResults) return { matches, limitHit: true };
        }
      }
    }
    return { matches, limitHit: false };
  }

  // ---- change notifications ----------------------------------------------
  //
  // v86's FS has no event API, so wrap the mutating methods on the instance.
  // The guest's virtio-9p server calls these same methods, so files created
  // by `touch foo` in the guest are reported too.

  private instrument(fs: V86Filesystem) {
    const queue = new Map<string, FsChange["type"]>();
    // Written inodes, resolved to paths only when the batch is flushed: finding
    // a file's path means scanning every directory, which was too slow to do on
    // every write (a busy guest writes thousands of times per second).
    const written = new Set<number>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const add = (path: string | undefined, type: FsChange["type"]) => {
      if (path) queue.set(path, queue.get(path) === "created" ? "created" : type);
    };
    const flush = () => {
      timer = undefined;
      if (written.size) {
        for (const path of this.pathsOf(written).values()) add(path, "changed");
        written.clear();
      }
      const changes = [...queue].map(([path, type]) => ({ type, path }));
      queue.clear();
      if (changes.length) for (const w of this.watchers) try { w(changes); } catch {}
    };
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(flush, 50);
    };
    const emit = (path: string | undefined, type: FsChange["type"]) => {
      if (!path) return;
      add(path, type);
      schedule();
    };
    const pathIn = (parentId: number, name: string) => {
      const dir = parentId === ROOT ? "" : "/" + fs.GetFullPath(parentId);
      return `${dir}/${name}`;
    };
    // Replaces fs[method] with a version that calls `before` (to capture state
    // the call destroys, like a path) and `after` (with the result, sync or async).
    const methods = fs as unknown as Record<MutatingMethod, (...args: any[]) => any>;
    const wrap = <C,>(method: MutatingMethod, before: ((...args: any[]) => C) | null, after: (ret: any, ctx: C, ...args: any[]) => void) => {
      const orig = methods[method].bind(fs);
      methods[method] = (...args) => {
        const ctx = before?.(...args) as C;
        const ret = orig(...args);
        Promise.resolve(ret).then((r) => after(r, ctx, ...args)).catch(() => {});
        return ret;
      };
    };
    for (const m of ["CreateFile", "CreateDirectory", "CreateSymlink", "CreateNode"] as const) {
      wrap(m, null, (_id, _ctx, name: string, parentId: number) => emit(pathIn(parentId, name), "created"));
    }
    wrap("Unlink", (parentId: number, name: string) => pathIn(parentId, name), (ret, path) => ret === 0 && emit(path, "deleted"));
    wrap("Rename",
      (od: number, on: string, nd: number, nn: string) => [pathIn(od, on), pathIn(nd, nn)] as const,
      (ret, [a, b]) => { if (ret === 0) { emit(a, "deleted"); emit(b, "created"); } });
    wrap("Write", null, (_r, _ctx, id: number) => { written.add(id); schedule(); });
  }

  /** Paths of several inodes in one scan of all directories (first name found, for hard links). */
  private pathsOf(ids: Set<number>): Map<number, string> {
    const found = new Map<number, string>();
    const inodes = this.fs.inodes;
    for (let d = 0; d < inodes.length && found.size < ids.size; d++) {
      const dir = inodes[d];
      if (!dir || !isDir(dir)) continue;
      for (const [name, cid] of dir.direntries) {
        if (ids.has(cid) && !found.has(cid) && name !== "." && name !== "..") {
          found.set(cid, (d === ROOT ? "" : "/" + this.fs.GetFullPath(d)) + "/" + name);
        }
      }
    }
    return found;
  }
}

function isSubsequence(needle: string, hay: string) {
  let i = 0;
  for (let j = 0; j < hay.length && i < needle.length; j++) if (hay[j] === needle[i]) i++;
  return i === needle.length;
}
