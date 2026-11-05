// Parts of v86 this project uses that its published types (node_modules/v86/v86.d.ts)
// leave out. They are internal APIs, so re-check them when upgrading v86:
//   emulator.fs9p - the 9p filesystem object (lib/filesystem.js in v86)
//   emulator.bus  - the event bus; "tcp-connection" fires for each guest TCP
//                   connection on the fake network (src/browser/fake_network.js)
import "v86";

declare module "v86" {
  interface V86 {
    fs9p: V86Filesystem;
    bus: V86Bus;
  }

  /** One inode of the 9p filesystem. `mode` holds the file type bits (S_IFDIR, …). */
  export interface V86Inode {
    mode: number;
    size: number;
    ctime: number;
    mtime: number;
    atime: number;
    /** Directories only: name → inode id, including "." and "..". */
    direntries: Map<string, number>;
    /** Symlinks only. */
    symlink: string;
    /** Regular files from the image: the blob holding the contents. */
    sha256sum: string;
    /** 2 = contents not fetched from the server yet. */
    status: number;
  }

  export interface V86Filesystem {
    inodes: V86Inode[];
    storage: V86FileStorage;
    GetInode(id: number): V86Inode;
    GetFullPath(id: number): string;
    SearchPath(path: string): { id: number; parentid: number; name: string };
    Read(id: number, offset: number, count: number): Promise<Uint8Array | null>;
    Write(id: number, offset: number, count: number, buffer: Uint8Array): Promise<void>;
    ChangeSize(id: number, size: number): Promise<void>;
    /** Returns the new inode id. */
    CreateFile(name: string, parentId: number): number;
    CreateDirectory(name: string, parentId: number): number;
    CreateSymlink(name: string, parentId: number, target: string): number;
    CreateNode(name: string, parentId: number, major: number, minor: number): number;
    /** 0 on success, a negative errno otherwise. */
    Unlink(parentId: number, name: string): number;
    Rename(oldDir: number, oldName: string, newDir: number, newName: string): Promise<number>;
  }

  /**
   * Where file contents come from: v86's ServerFileStorageWrapper, which fetches
   * blobs lazily from `baseurl` and keeps them in an inner MemoryFileStorage.
   * `sha256` is the blob's file name (e.g. "98d1f85024.bin.zst").
   */
  export interface V86FileStorage {
    read(sha256: string, offset: number, count: number, fileSize: number): Promise<Uint8Array | null>;
    cache(sha256: string, data: Uint8Array): Promise<void>;
    /** Called by FS.CloseInode when the guest closes a file from the image. */
    uncache(sha256: string): void;
    load_from_server(sha256: string, fileSize: number): Promise<Uint8Array>;
    /** URL (or, in Node, path) prefix of the blob files, ending in "/". */
    baseurl: string;
    /** Decompresses a .zst blob with the emulator's own zstd. */
    zstd_decompress(decompressedSize: number, compressed: Uint8Array): ArrayBuffer | Uint8Array;
    /** The in-memory store: blob name → decompressed contents. */
    storage: { filedata: Map<string, Uint8Array> };
  }

  export interface V86Bus {
    register(event: "tcp-connection", listener: (conn: V86TcpConnection) => void, context?: unknown): void;
    register(event: string, listener: (data: any) => void, context?: unknown): void;
    send(event: string, data?: unknown): void;
  }

  /** A guest TCP connection that ends in JavaScript (v86's fake network). */
  export interface V86TcpConnection {
    /** The port the guest connected to. */
    sport: number;
    dport: number;
    /** Takes the connection over (sends SYN-ACK). Leave it unaccepted to refuse it. */
    accept(packet?: unknown): void;
    write(data: Uint8Array): void;
    close(): void;
    on(event: "data", listener: (data: Uint8Array) => void): void;
    on(event: "shutdown" | "close", listener: () => void): void;
  }
}
