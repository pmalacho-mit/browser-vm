// Keeps the guest's file contents cached (roadmap F1).
//
// v86 fetches each file of the image lazily (rootfs/<hash>.bin.zst), keeps the
// decompressed bytes in memory while the guest has the file open, and drops
// them when the guest closes it (FS.CloseInode → storage.uncache). So every
// run of a program downloads and decompresses its binary again: about 70 MB
// for each `node` start, and 34 MB of busybox re-reads during boot.
//
// This replaces that with:
//   1. a memory cache bounded by bytes, evicting the least recently used file,
//      instead of dropping files on close;
//   2. optionally, a persistent cache of the compressed blobs in the browser's
//      Cache Storage, so a second visit downloads nothing. Blob names are
//      content hashes, so a cached blob never goes stale.
import type { V86Filesystem, V86FileStorage } from "v86";

export interface BlobCacheOptions {
  /** Memory budget for decompressed file contents, in bytes. */
  maxBytes: number;
  /** Cache Storage name for compressed blobs; omit to keep only the memory cache. */
  persistentCache?: string;
  log?: (s: string) => void;
}

export interface BlobCacheStats {
  /** Blobs fetched from the network (or, in Node, read from disk). */
  fetches: number;
  /** Bytes those fetches loaded: compressed with the persistent cache, decompressed without it. */
  fetchedBytes: number;
  /** Blobs found in the persistent cache instead of fetched. */
  persistentHits: number;
  /** Bytes currently held in memory, and how many files that is. */
  memoryBytes: number;
  memoryFiles: number;
  evictions: number;
}

/** Installs the cache on the emulator's filesystem. Call after "emulator-loaded", before the guest reads files. */
export function installBlobCache(fs: V86Filesystem, opts: BlobCacheOptions): BlobCacheStats {
  const storage: V86FileStorage = fs.storage;
  const memory = storage.storage.filedata;
  const stats: BlobCacheStats = { fetches: 0, fetchedBytes: 0, persistentHits: 0, memoryBytes: 0, memoryFiles: 0, evictions: 0 };
  // Map iteration order is insertion order, so re-inserting on use makes the
  // first key the least recently used one.
  const lru = new Map<string, number>(); // blob name → size in bytes

  const touch = (sha: string) => {
    const size = lru.get(sha);
    if (size === undefined) return;
    lru.delete(sha);
    lru.set(sha, size);
  };
  const evictFor = (incoming: number) => {
    for (const [sha, size] of lru) {
      if (stats.memoryBytes + incoming <= opts.maxBytes) break;
      lru.delete(sha);
      memory.delete(sha);
      stats.memoryBytes -= size;
      stats.evictions++;
    }
    stats.memoryFiles = lru.size;
  };

  const origCache = storage.cache.bind(storage);
  storage.cache = async (sha, data) => {
    const old = lru.get(sha);
    if (old !== undefined) { lru.delete(sha); stats.memoryBytes -= old; }
    // A single file larger than the budget is still cached (v86 needs it while
    // it's open); it just pushes everything else out.
    evictFor(data.byteLength);
    await origCache(sha, data);
    lru.set(sha, data.byteLength);
    stats.memoryBytes += data.byteLength;
    stats.memoryFiles = lru.size;
  };

  const origRead = storage.read.bind(storage);
  storage.read = async (sha, offset, count, fileSize) => {
    touch(sha);
    return origRead(sha, offset, count, fileSize);
  };

  // Closing a file no longer drops it; the LRU decides when it goes.
  storage.uncache = () => {};

  const origLoad = storage.load_from_server.bind(storage);
  const persistent = opts.persistentCache && typeof caches !== "undefined" ? caches.open(opts.persistentCache) : null;
  // v86 can ask for the same blob several times before the first fetch finishes
  // (several inodes with the same contents, or readahead): fetch it once.
  const inflight = new Map<string, Promise<Uint8Array>>();
  const load = async (sha: string, fileSize: number): Promise<Uint8Array> => {
    if (!persistent) {
      // v86 fetches it (XHR in a browser, the filesystem in Node) and calls cache().
      stats.fetches++;
      const data = await origLoad(sha, fileSize);
      stats.fetchedBytes += data.byteLength;
      return data;
    }
    const url = new URL(storage.baseurl + sha, globalThis.location?.href).href;
    const cache = await persistent;
    let response = await cache.match(url);
    if (response) {
      stats.persistentHits++;
    } else {
      response = await fetch(url);
      if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
      stats.fetches++;
      // Store a copy; failures (quota, private mode) only cost a re-download later.
      cache.put(url, response.clone()).catch((e) => opts.log?.(`[vm] blob cache: could not store ${sha}: ${e.message}`));
    }
    const compressed = new Uint8Array(await response.arrayBuffer());
    stats.fetchedBytes += compressed.byteLength;
    const data = sha.endsWith(".zst") ? new Uint8Array(storage.zstd_decompress(fileSize, compressed)) : compressed;
    await storage.cache(sha, data);
    return data;
  };
  storage.load_from_server = (sha, fileSize) => {
    let p = inflight.get(sha);
    if (!p) {
      p = load(sha, fileSize).finally(() => inflight.delete(sha));
      inflight.set(sha, p);
    }
    return p;
  };

  return stats;
}
