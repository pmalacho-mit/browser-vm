// How the guest kernel is booted. Shared by the extension (vm.ts) and the
// Node scripts (boot-test, boot-profile, compare-64), so they all boot it the
// same way. No VS Code or browser dependencies.

/**
 * The kernel command line, before any user-supplied extras.
 *
 * The root filesystem is the 9p device "host9p" (v86's JavaScript filesystem,
 * which the editor also reads and writes). `cache=mmap` lets the kernel cache
 * memory-mapped files (program binaries and libraries) while ordinary reads and
 * writes stay uncached, so a file the editor saves is what the guest reads next.
 * With `cache=none`, every page of a program was read over 9p as it ran:
 * `node -e 1` took 40 s instead of 12.5 s. (See the roadmap, F2.)
 */
export const GUEST_CMDLINE = [
  "console=ttyS0",
  "root=host9p rootfstype=9p rw",
  "rootflags=trans=virtio,cache=mmap",
  "init=/sbin/vm-init",
  "tsc=reliable quiet",
].join(" ");

/** Extra quiet kernel logging for interactive use (the boot log goes to the first terminal). */
export const QUIET_LOGLEVEL = "loglevel=3";

/** Memory budget for cached file contents (decompressed), unless configured. */
export const DEFAULT_FILE_CACHE_MB = 256;
