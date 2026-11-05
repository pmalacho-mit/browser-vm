// The runtime's own files in a VM folder, for build tools (Node): the TLS
// terminator the guest's HTTPS goes through, and the guest agent binary for a
// machine. Locally built copies (build/, from `npm run tls` / `npm run agent`)
// win over the prebuilt ones checked in here.
import fs from "node:fs";
import path from "node:path";

const here = import.meta.dirname;
const repo = path.resolve(here, "..");

const first = (/** @type {string[]} */ ...candidates) => candidates.find((c) => fs.existsSync(c));

/**
 * @param {string} arch  the machine's architecture ("i686", "x86_64")
 * @param {{ agent: boolean }} o  whether to ship the Go agent (the machine can run Go programs)
 * @returns {{ tls: string, agent: string | null }}  absolute paths
 */
export function runtimeAssets(arch, { agent }) {
  const tls = first(path.join(repo, "build/tls/tls.wasm"), path.join(here, "tls/prebuilt/tls.wasm"));
  if (!tls) throw new Error("no tls.wasm (npm run tls)");
  const agentBin = agent ? first(path.join(repo, `build/agent/vm-agent-${arch}`), path.join(here, `guest/prebuilt/vm-agent-${arch}`)) : null;
  if (agent && !agentBin) throw new Error(`no guest agent for ${arch} (npm run agent)`);
  return { tls, agent: agentBin ?? null };
}

/** The guest half of the runtime, which every image must contain (images/). */
export const guestFiles = {
  /** PID 1: consoles on ttyS0/2/3, the agent on ttyS1. */
  init: path.join(here, "guest/vm-init"),
  /** The shell agent: the fallback when no Go agent is written in at boot. */
  shellAgent: path.join(here, "guest/vm-agent"),
};
