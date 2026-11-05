// Deployment configuration for the gate. Edit for your deployment.
import type { Mode, Rule } from "./core.ts";

// Which IDE origins may use this gate. In production, list your IDE origin,
// e.g. ["https://ide.example.com"] (with the gate served at gate.example.com).
// A site built with IDE_URL + GATE_URL (scripts/build-site.mjs writes them to
// site.js) admits exactly that IDE origin, and only on that gate origin.
// Otherwise, locally: the gate is http://gate.localhost:<port> and the IDE http://localhost:<port>.
export const embedderOrigins = (): string[] => {
  const site = globalThis.SITE_CONFIG;
  if (site?.gateUrl && site?.ideUrl) {
    return new URL(site.gateUrl).origin === location.origin ? [new URL(site.ideUrl).origin] : [];
  }
  return location.hostname === "gate.localhost" ? [`${location.protocol}//localhost${location.port ? ":" + location.port : ""}`] : [];
};

// Shown in the passkey prompt ("Sign in to …").
export const rpName = "VM network gate";

// Network policy before the user changes anything. "enforce" + this list means
// code can reach package registries and nothing else until the user allows it,
// site by site, from a prompt. Add the hosts your own tool needs.
export const defaultPolicy: { mode: Mode; rules: Rule[] } = {
  mode: "enforce",
  rules: [
    "registry.npmjs.org", "registry.yarnpkg.com",             // npm
    "pypi.org", "files.pythonhosted.org",                     // pip
    "index.crates.io", "static.crates.io",                    // cargo
    "proxy.golang.org", "sum.golang.org",                     // go
    "raw.githubusercontent.com", "api.github.com", "objects.githubusercontent.com",
  ].map((host): Rule => ({ host, action: "allow", builtin: true })),
};
