// Deployment configuration for the web gate. Edit for your deployment.

// Which IDE origins may use this gate. In production, list your IDE origin,
// e.g. ["https://ide.example.com"] (with the gate served at gate.example.com).
// A site built with IDE_URL + GATE_URL (tools/build.mjs writes them to
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

// The network policy before the user changes anything is gate-core's defaultPolicy.
