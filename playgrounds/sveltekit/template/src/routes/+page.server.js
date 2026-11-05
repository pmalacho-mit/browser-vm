// Runs on the server (Node, in the VM) for every request to "/".
import os from "node:os";

export function load() {
  return {
    renderedAt: new Date().toISOString(),
    machine: `${os.type()} ${os.release()} (${os.arch()})`,
    node: process.version,
  };
}
