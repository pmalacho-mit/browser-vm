// Shared by background.js and popup.js. Edit APP_ORIGINS (and the
// content_scripts "matches" in manifest.json) to the origin(s) your network
// GATE is served on (gates/web/app/). Only the gate talks to this extension: it has
// already applied the network policy and substituted secrets.
export const APP_ORIGINS = ["http://gate.localhost:8080"];

// Hostnames that never go through the bridge, approved or not: anything that
// names the user's own machine or local network. (The bridge exists to reach
// *public* sites; intranet access is exactly the attack it must not enable.)
const LOCAL_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home", ".home.arpa", ".corp", ".intranet"];

/** @returns {string|null} why the URL is refused, or null if it may be considered */
export function refuse(urlString) {
  let url;
  try { url = new URL(urlString); } catch { return "not a valid URL"; }
  if (url.protocol !== "https:") return "only https:// URLs are bridged";
  if (url.port && url.port !== "443") return "only the default HTTPS port is bridged";
  if (url.username || url.password) return "URLs with credentials are not bridged";
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || LOCAL_SUFFIXES.some((s) => host.endsWith(s))) return "local hostnames are never bridged";
  if (/^\d+(\.\d+){3}$/.test(host) || host.startsWith("[")) return "IP addresses are never bridged (use a hostname)";
  if (!host.includes(".")) return "single-label hostnames are never bridged";
  return null;
}

export const originPattern = (urlString) => `https://${new URL(urlString).hostname}/*`;
