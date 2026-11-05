// Network policy before the user changes anything, shared by every gate. With
// "enforce", code can reach package registries and nothing else until the user
// allows a site (the web gate asks; the node gate takes --allow). Add the hosts
// your own tool needs.
import type { Mode, Rule } from "./core.ts";

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
