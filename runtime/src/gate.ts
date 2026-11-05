// The runtime's contract with the network gate: the VM's only way out.
//
// The runtime makes no network request for the guest by itself. Every HTTP(S)
// request the guest makes (net.ts turns its TCP connections into requests) goes
// to the Gate the runtime was given, which decides whether it leaves, and may
// swap secret placeholders for real values on the way. No gate: no network.
//
// Implementations live in gates/: the web gate's client (gates/web/src/client.ts,
// for the browser, where the gate runs on its own origin) and the node gate
// (gates/node, policy only, for in-process hosts such as the MCP server).
import type { FetchLike } from "./net.ts";

export interface Gate {
  /**
   * One HTTP(S) request from the guest. Rejects with a GuestError: its
   * `guestMessage` is what the guest's program sees; `code: "locked"` means the
   * request needs a secret while the gate is locked (surfaces offer to unlock).
   */
  fetch: FetchLike;
  /** Called once, before the first request, with what the gate may tell the runtime. */
  connect?(hooks: GateHooks): void;
  /** Shows the gate's own UI to the user, with a reason. Gates without a UI leave this out. */
  show?(text: string): void;
}

export interface GateHooks {
  /** Something the user should hear about; the runtime passes it on to every surface. */
  notice(n: GateNotice): void;
  /** The secrets the guest may use, by placeholder; the runtime exports them in the guest. */
  secrets(list: SecretPlaceholder[]): void;
}

/** Something the user should hear about, shown by a surface. */
export interface GateNotice {
  kind: "refused" | "first-use" | "leak" | "quota";
  host: string;
  names?: string[];
}

/** A secret as the VM sees it: the placeholder and the environment variable that holds it. Never the value. */
export interface SecretPlaceholder {
  name: string;
  env: string;
}
