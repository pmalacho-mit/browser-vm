// Messages of the web gate, between its three pieces. Types only: this file is
// imported with `import type`, so it never reaches a bundle.
//
//   runtime worker ──BroadcastChannel──► page (relay.ts) ──MessagePort──► gate origin (app/gate.ts)
//   (client.ts)    ◄──────────────────                   ◄─────────────
import type { GateNotice, SecretPlaceholder } from "@browser-vm/runtime";

export type { GateNotice, SecretPlaceholder };

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

/** Runtime worker → page (BroadcastChannel). */
export interface ToRelay {
  ping?: true;
  ui?: "show";
  text?: string;
  msg?: GateRequest;
}

/**
 * Gate → page (MessagePort), forwarded unchanged to the runtime worker
 * (BroadcastChannel). `ready` only travels gate → page; `hello` only page → runtime worker.
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

/** Page → gate (MessagePort). */
export type ToGate = GateRequest | { ui: "show"; text?: string };
