// Messages between the VM's network code and the network gate. Types only: this
// file is imported with `import type`, so it never reaches a bundle.
//
//   extension host ──BroadcastChannel──► host page (web/gate-relay.ts) ──MessagePort──► gate (web/gate/gate.ts)
//                  ◄─────────────────────                              ◄─────────────

/** One HTTP request from the VM. Headers may still carry secret placeholders. */
export interface GateRequest {
  id: string;
  url: string;
  method: string;
  headers: [string, string][];
  body?: Uint8Array;
}

export interface GateResponseHead {
  status: number;
  statusText: string;
  headers: [string, string][];
  url: string;
  redirected: boolean;
}

export type GateErrorCode =
  | "refused" // a local address, a secret rule, or a redirect with a secret attached
  | "denied" // not on the site allowlist
  | "locked" // needs a secret while the vault is locked
  | "quota" // a secret's usage limit
  | "network" // fetch() failed (CORS, DNS, offline)
  | "bridge-not-approved" // the bridge extension hasn't been allowed for this site
  | "internal"
  | "no-gate"; // this deployment has no gate configured

export interface GateErrorInfo {
  code: GateErrorCode;
  message: string;
}

/** Something the user should hear about, shown by the VS Code extension. */
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

/** Extension host → host page (BroadcastChannel). */
export interface ToRelay {
  ping?: true;
  ui?: "show";
  text?: string;
  msg?: GateRequest;
}

/**
 * Gate → host page (MessagePort), forwarded unchanged to the extension host
 * (BroadcastChannel). `ready` only travels gate → page; `hello` only page → extension host.
 */
export interface FromGate {
  ready?: true;
  hello?: "gate";
  secrets?: SecretPlaceholder[];
  notice?: GateNotice;
  id?: string;
  head?: GateResponseHead;
  chunk?: Uint8Array;
  end?: true;
  error?: GateErrorInfo;
}

/** Host page → gate (MessagePort). */
export type ToGate = GateRequest | { ui: "show"; text?: string };
