// @browser-vm/gate-node: a gate for hosts that run the runtime in-process, such
// as the MCP server (surfaces/mcp) and tests. It applies gate-core's site rules
// and nothing that only makes sense in a browser: no secrets (there is no vault
// to keep them from the host), no CORS header limits. Private networks and IP
// addresses are never reachable.
//
//   const gate = nodeGate({ allow: ["example.com"], log: console.error });
//   const rt = new Runtime({ gate, assets });
import { decide, defaultPolicy, forwardHeaders, refuseDestination, validate, type GateConfig, type Rule } from "@browser-vm/gate-core";
import type { Gate, GuestError } from "@browser-vm/runtime";

export interface NodeGateOptions {
  /** Hosts allowed on top of the default policy (package registries). Patterns like "*.example.com" work. */
  allow?: string[];
  /** Replace the default rules entirely. */
  rules?: Rule[];
  /** What to tell the guest when a host is refused, after "<host> is not on the allowed list." */
  hint?: (host: string) => string;
  log?: (s: string) => void;
  /** The real network (default: globalThis.fetch). */
  fetch?: typeof fetch;
}

export function nodeGate(o: NodeGateOptions = {}): Gate & { policy: GateConfig } {
  const log = o.log ?? (() => {});
  const realFetch = o.fetch ?? globalThis.fetch;
  const policy = validate({
    mode: "enforce",
    rules: [...(o.allow ?? []).map((host): Rule => ({ host, action: "allow" })), ...(o.rules ?? defaultPolicy.rules)],
  });
  for (const p of policy.problems) log(`policy: ${p}`);
  const refuse = (message: string): never => {
    throw Object.assign(new Error(message), { guestMessage: message + "\n" }) as GuestError;
  };
  return {
    policy,
    fetch: async (url, init) => {
      const u = new URL(url);
      const why = refuseDestination(u);
      if (why) refuse(`browser-vm: ${u.hostname}: ${why}`);
      if (decide(policy, u.hostname) === "deny") {
        log(`refused ${u.hostname} (not allowed)`);
        refuse(`browser-vm: ${u.hostname} is not on the allowed list.${o.hint ? " " + o.hint(u.hostname) : ""}`);
      }
      log(`${init.method} ${u.origin}${u.pathname}`);
      return realFetch(url, { method: init.method, headers: forwardHeaders(init.headers, true), body: init.body, redirect: init.redirect ?? "follow" });
    },
  };
}
