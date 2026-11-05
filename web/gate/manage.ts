// Settings popup. Runs top-level on the gate origin and drives the framed gate
// (window.opener) through its API. Secret values go in and never come out.
// Passkey prompts happen here too: they need a top-level window and a click.
import { rpName } from "./config.ts";
import { passkeysSupported, createPasskey, assertPasskey } from "./webauthn.ts";
import type { GateApi, GateState } from "./gate.ts";
import type { Mode } from "./core.ts";
import type { UnlockMethod } from "./vault.ts";

type Kid = Node | string | null | undefined | false;
type Method = GateState["methods"][number];
type PasskeyMethod = Extract<Method, { type: "passkey" }>;
type SecretRow = GateState["secrets"][number];
/** A form action: returns a problem to show, or nothing on success. */
type Action = () => Promise<string | null | undefined> | string | null | undefined;

/** Creates an element, assigns `props` to it (className, onclick, value…) and appends the children. */
const h = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...kids: (Kid | Kid[])[]): HTMLElementTagNameMap[K] => {
  const el = Object.assign(document.createElement(tag), props);
  for (const k of kids.flat()) if (k != null && k !== false && k !== "") el.append(k);
  return el;
};
/** A form field as text ("" when missing). */
const field = (d: FormData, name: string) => { const v = d.get(name); return typeof v === "string" ? v : ""; };
const blurActive = () => (document.activeElement as HTMLElement | null)?.blur();
const ago = (t: number) => { const s = Math.round((Date.now() - t) / 1000); return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`; };
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

export function render(gate: GateApi) {
  document.title = "VM network gate — settings";
  const root = document.getElementById("manage")!;
  root.hidden = false;
  let editing: string | null = null; // secret name being edited, or "" for new
  let panel: string | null = null;          // which vault sub-form is open: "passphrase" | "add-passkey" | "set-passphrase" | null
  let busy = false;          // a vault action is running: don't redraw under it
  const errors: Record<string, string> = {}; // form → last error, kept across redraws
  const passkeys = (st: GateState) => st.methods.filter((m): m is PasskeyMethod => m.type === "passkey");
  const hasPassphrase = (st: GateState) => st.methods.some((m) => m.type === "passphrase");

  // Runs a vault action with the UI frozen; keeps its error for the redraw.
  const run = async (key: string, action: Action) => {
    busy = true;
    let problem;
    try { problem = await action(); } catch (e) { problem = (e as Error).message; }
    busy = false;
    errors[key] = problem || "";
    if (!problem) panel = null;
    blurActive(); draw();
  };
  const form = (cls: string, fields: [string, string, string?][], submitLabel: string, action: (d: FormData) => ReturnType<Action>, extra: Kid[] = []) => {
    const f = h("form", { className: `vault-form ${cls}`, onsubmit: (e: SubmitEvent) => {
      e.preventDefault();
      const btn = f.querySelector<HTMLButtonElement>("button[type=submit]")!;
      btn.disabled = true; btn.textContent = "Working…"; // PBKDF2 takes a moment, on purpose
      run(cls, () => action(new FormData(f)));
    } },
      fields.map(([name, label, type = "password"]) => h("label", {}, label, h("input", { name, type, required: true, autocomplete: type === "password" ? "off" : undefined }))),
      extra, h("div", { className: "error" }, errors[cls] || ""),
      h("div", { className: "card-actions" }, h("button", { type: "submit", className: "primary" }, submitLabel)));
    return f;
  };
  const credsOf = (st: GateState) => passkeys(st).map((m) => ({ id: m.credential.id, transports: m.credential.transports, prfSalt: m.prfSalt }));
  const labelOf = (m: PasskeyMethod) => m.credential.label || "passkey";

  // --- vault --------------------------------------------------------------------

  const newPasskey = async (st: GateState, label: string, existing?: UnlockMethod) => {
    label = (label || "").trim() || "This computer";
    const { credential, prfSalt, prfBytes } = await createPasskey({ rpName, label, exclude: passkeys(st).map((m) => m.credential) });
    const method = { prfBytes, prfSalt, credential };
    return existing ? gate.addMethod(existing, method) : gate.setupVault(method);
  };
  // "Name this passkey" + the button, in one form (no prompt(): a modal could outlive the click's activation).
  const passkeyRow = (st: GateState, text: string, extraFields: [string, string, string?][], action: (d: FormData) => ReturnType<Action>) => passkeysSupported()
    ? form("passkey", [["label", "Name this passkey (which device or person)", "text"], ...extraFields], text, (d) => action(d))
    : h("p", { className: "muted" }, "This browser can't use passkeys here; use a passphrase.");

  const vaultBox = (st: GateState) => {
    if (st.vault === "none") return h("section", { className: "vault" },
      h("h2", {}, "🔐 Protect your secrets"),
      h("p", {}, "Secret values are encrypted. To use them, you unlock the gate once per session."),
      st.legacy ? h("p", { className: "error" }, "Some secrets are stored unencrypted by an earlier version. Setting this up encrypts them.") : null,
      passkeyRow(st, "Use a passkey (Touch ID, Windows Hello, phone)", [], (d) => newPasskey(st, field(d, "label"))),
      h("p", { className: "muted" }, "Recommended: nothing to remember, and only this site can ask your device for it. ",
        h("button", { className: "link", onclick: () => { panel = panel === "passphrase" ? null : "passphrase"; draw(); } }, "Use a passphrase instead")),
      panel === "passphrase" && form("setup", [["p1", "Passphrase (10+ characters)"], ["p2", "Repeat it"]], "Encrypt with this passphrase", (d) =>
        d.get("p1") !== d.get("p2") ? "the two passphrases differ" : gate.setupVault({ passphrase: field(d, "p1") })));

    if (st.vault === "locked") return h("section", { className: "vault" },
      h("h2", {}, "🔒 Locked"),
      h("p", {}, "Secret values are encrypted. Until you unlock, requests that need one are refused (code in the VM is told why); everything else works."),
      passkeys(st).length ? h("button", { className: "primary big", id: "unlock-passkey", onclick: () => run("passkey", async () => {
        const { credentialId, prfBytes } = await assertPasskey({ credentials: credsOf(st) });
        return gate.unlock({ prfBytes, credentialId }, false);
      }) }, `Unlock with ${passkeys(st).length === 1 ? labelOf(passkeys(st)[0]) : "a passkey"}`) : null,
      h("div", { className: "error" }, errors.passkey || ""),
      hasPassphrase(st) && form("unlock", [["p", "Passphrase"]], "Unlock", (d) => gate.unlock({ passphrase: field(d, "p") }, d.get("remember") === "on"), [
        h("label", { className: "inline" }, h("input", { type: "checkbox", name: "remember" }),
          " Stay unlocked on this device. Anyone using this browser profile can then use the secrets."),
      ]),
      h("p", { className: "muted" }, "Lost every way in? ", h("button", { onclick: () => confirm("Delete every secret value? Placeholders and rules stay; you re-enter the values.") && gate.resetVault() }, "Reset secrets")));

    // unlocked. Adding a method re-proves an existing one: the current passphrase if there is one, else a passkey tap.
    const proofFields: [string, string][] = hasPassphrase(st) ? [["old", "Confirm your current passphrase"]] : [];
    const prove = async (d: FormData): Promise<UnlockMethod> => {
      if (hasPassphrase(st)) return { passphrase: field(d, "old") };
      const { credentialId, prfBytes } = await assertPasskey({ credentials: credsOf(st) });
      return { prfBytes, credentialId };
    };
    return h("section", { className: "vault" },
      h("h2", {}, "🔓 Unlocked"),
      h("p", { className: "muted" }, st.remembered ? "Unlocks automatically on this device." : "Locks again when this tab closes or reloads."),
      h("ul", { className: "methods" },
        st.methods.map((m) => h("li", {},
          m.type === "passkey" ? `🔑 Passkey: ${labelOf(m)}` : "🔤 Passphrase",
          st.methods.length > 1 && h("button", { onclick: () => confirm(`Remove this way to unlock?`) && run("methods", () => gate.removeMethod(m.type === "passkey" ? { type: "passkey", credentialId: m.credential.id } : { type: "passphrase" })) }, "Remove")))),
      h("div", { className: "row" },
        h("button", { onclick: () => gate.lock() }, "Lock now"),
        passkeysSupported() && h("button", { onclick: () => { panel = panel === "add-passkey" ? null : "add-passkey"; draw(); } }, "Add a passkey"),
        h("button", { onclick: () => { panel = panel === "set-passphrase" ? null : "set-passphrase"; draw(); } }, hasPassphrase(st) ? "Change passphrase" : "Add a passphrase"),
        st.remembered && h("button", { onclick: () => gate.forgetDevice() }, "Forget this device")),
      h("div", { className: "error" }, errors.methods || ""),
      panel === "add-passkey" && passkeyRow(st, "Add this passkey", proofFields, async (d) => newPasskey(st, field(d, "label"), await prove(d))),
      panel === "set-passphrase" && form("change", [...proofFields, ["p1", "New passphrase (10+ characters)"], ["p2", "Repeat it"]],
        hasPassphrase(st) ? "Change passphrase" : "Add passphrase", async (d) => {
          if (d.get("p1") !== d.get("p2")) return "the two passphrases differ";
          return gate.addMethod(await prove(d), { passphrase: field(d, "p1") });
        }));
  };

  // --- everything else --------------------------------------------------------------

  const draw = () => {
    if (busy) return;
    const st = gate.state();
    if (document.activeElement?.closest?.("form")) return; // don't redraw under the user's typing

    const modes: [Mode, string, string][] = [
      ["enforce", "Ask first", "Only sites on the list. Code that tries another site is stopped, and you're asked."],
      ["learn", "Learn", "Any public site, and each new one is listed below so you can turn the list into rules."],
      ["open", "Open", "Any public site. Everything is logged."],
    ];
    const modeBox = h("section", {},
      h("h2", {}, "Which sites code may reach"),
      h("div", { className: "modes" }, modes.map(([m, label, desc]) =>
        h("label", { className: "mode" + (st.mode === m ? " on" : "") },
          h("input", { type: "radio", name: "mode", checked: st.mode === m, onchange: () => gate.setMode(m) }),
          h("b", {}, label), h("span", {}, desc)))),
      h("p", { className: "muted" }, "Never reachable, whatever the mode: this computer, your home or office network, and IP addresses."));

    const ruleFor = (host: string) => st.rules.find((r) => r.host === host);
    const hosts = [...new Set([...st.seen.map((s) => s.host), ...st.rules.map((r) => r.host)])];
    const hostBox = h("section", {},
      h("h2", {}, "Sites"),
      hosts.length ? h("table", {},
        h("tr", {}, h("th", {}, "Site"), h("th", {}, "Requests"), h("th", {}, "Rule"), h("th", {})),
        hosts.map((host) => {
          const s = st.seen.find((x) => x.host === host);
          const rule = ruleFor(host);
          return h("tr", {},
            h("td", {}, h("code", {}, host)),
            h("td", {}, s ? `${s.count} · ${ago(s.last)}` : "—"),
            h("td", {}, rule ? h("span", { className: `pill ${rule.action}` }, rule.action + (rule.builtin ? " (default)" : "")) : h("span", { className: "muted" }, s?.decision === "deny" ? "stopped" : "none")),
            h("td", { className: "actions" },
              rule?.action !== "allow" && h("button", { onclick: () => gate.setRule(host, "allow") }, "Allow"),
              rule?.action !== "deny" && h("button", { onclick: () => gate.setRule(host, "deny") }, "Deny"),
              rule && !rule.builtin && h("button", { onclick: () => gate.setRule(host, null) }, "Clear")));
        })) : h("p", { className: "muted" }, "No requests yet."));

    const secretRows = st.secrets.map((s) => h("tr", {},
      h("td", {}, h("code", {}, s.name), " ",
        s.broken ? h("span", { className: "pill deny" }, "re-enter value") : !s.valid ? h("span", { className: "pill deny" }, "invalid") : s.off ? h("span", { className: "pill muted" }, "off") : s.locked ? h("span", { className: "pill muted" }, "locked") : null),
      h("td", {}, s.env ? h("code", {}, `$${s.env}`) : h("span", { className: "muted" }, "—")),
      h("td", {}, s.hosts.map((x) => h("code", {}, x, " "))),
      h("td", {}, s.anywhere ? "headers, URL, body" : s.headers ? s.headers.join(", ") : "any header"),
      h("td", {}, s.quota ? `${s.usedThisSession} of ${s.quota.max} / ${s.quota.perHours} h` : h("span", { className: "muted" }, `${s.usedThisSession} · no limit`)),
      h("td", { className: "actions" },
        h("button", { onclick: () => gate.toggleSecret(s.name) }, s.off ? "Turn on" : "Turn off"),
        h("button", { disabled: st.vault !== "unlocked", onclick: () => { editing = s.name; draw(); } }, "Edit"),
        h("button", { onclick: () => confirm(`Delete ${s.name}?`) && gate.deleteSecret(s.name) }, "Delete"))));
    const sform = editing !== null ? secretForm(st.secrets.find((s) => s.name === editing)) : null;
    const secretBox = h("section", {},
      h("h2", {}, "Secrets"),
      h("p", { className: "muted" }, "Code in the VM only ever sees the placeholder. The gate swaps in the real value on the way out, over HTTPS, only toward the listed sites, and turns echoed values back into the placeholder."),
      st.secrets.length ? h("table", {}, h("tr", {}, h("th", {}, "Placeholder"), h("th", {}, "In the VM as"), h("th", {}, "Only for"), h("th", {}, "Where"), h("th", {}, "Used · limit"), h("th", {})), secretRows) : null,
      st.problems.length ? h("ul", { className: "problems" }, st.problems.map((p) => h("li", {}, p))) : null,
      sform || (st.vault === "unlocked"
        ? h("button", { className: "primary", id: "add-secret", onclick: () => { editing = ""; draw(); } }, "Add a secret")
        : h("p", { className: "muted" }, st.vault === "none" ? "Set up a passkey or passphrase above to add secrets." : "Unlock above to add or edit secrets.")));

    const auditBox = h("section", {},
      h("h2", {}, "Recent requests ", h("button", { className: "link", onclick: () => gate.clearAudit() }, "clear")),
      st.audit.length ? h("table", { className: "audit" }, st.audit.slice(0, 40).map((a) => h("tr", {},
        h("td", { className: "muted" }, ago(a.t)),
        h("td", {}, h("span", { className: `pill v-${a.verdict}` }, a.verdict)),
        h("td", {}, `${a.method} `, h("code", {}, a.host + a.path)),
        h("td", { className: "muted" }, [a.substituted?.length ? `🔑 ${a.substituted.join(", ")}` : "", a.leaks?.length ? `⚠ ${a.leaks.join(", ")} not for this site` : "", a.status ?? ""].filter(Boolean).join(" · "))))) : h("p", { className: "muted" }, "Nothing yet."));

    root.replaceChildren(h("header", {}, h("h1", {}, "🔒 VM network gate"), h("span", { className: "muted" }, location.host)), vaultBox(st), secretBox, modeBox, hostBox, auditBox);
  };

  function secretForm(existing: SecretRow | undefined) {
    const err = h("div", { className: "error" });
    const f = h("form", { className: "secret-form", onsubmit: async (e: SubmitEvent) => {
      e.preventDefault();
      const d = new FormData(f);
      const name = (existing?.name || field(d, "name")).trim();
      const max = parseInt(field(d, "qmax"), 10), perHours = parseFloat(field(d, "qhours"));
      const problem = await gate.setSecret(name, {
        value: field(d, "value"),
        env: field(d, "env").trim(),
        hosts: field(d, "hosts").split(/[\s,]+/).filter(Boolean),
        headers: d.get("where") === "named" ? field(d, "headers").split(/[\s,]+/).filter(Boolean).map((x) => x.toLowerCase()) : null,
        anywhere: d.get("where") === "anywhere",
        quota: max > 0 ? { max, perHours: perHours > 0 ? perHours : 24 } : null,
      });
      if (problem) { err.textContent = problem; return; }
      editing = null; blurActive(); draw();
    } },
      h("label", {}, "Placeholder", h("input", { name: "name", required: true, value: existing?.name || "", disabled: !!existing, placeholder: "GATE-OPENAI-KEY", pattern: "[A-Z][A-Z0-9_\\-]{5,63}" })),
      h("label", {}, "Environment variable in the VM (optional)", h("input", { name: "env", value: existing?.env || "", placeholder: "OPENAI_API_KEY" })),
      h("label", {}, existing ? "New value (leave empty to keep the current one)" : "Value", h("input", { name: "value", type: "password", required: !existing, autocomplete: "off" })),
      h("label", {}, "Only for these sites", h("input", { name: "hosts", required: true, value: existing?.hosts.join(" ") || "", placeholder: "api.openai.com" })),
      h("fieldset", {}, h("legend", {}, "Where it may be substituted"),
        h("label", { className: "inline" }, h("input", { type: "radio", name: "where", value: "named", checked: !existing || !!existing.headers }), "Only these headers (recommended): ",
          h("input", { name: "headers", value: existing?.headers?.join(" ") || "authorization x-api-key", className: "short" })),
        h("label", { className: "inline" }, h("input", { type: "radio", name: "where", value: "headers", checked: !!existing && !existing.headers && !existing.anywhere }), "Any request header"),
        h("label", { className: "inline" }, h("input", { type: "radio", name: "where", value: "anywhere", checked: !!existing?.anywhere }),
          "Headers, URL and body (needed by some webhooks; a service that computes on the body, like an LLM, could hand the value back)")),
      h("fieldset", {}, h("legend", {}, "Limit how often it may be used"),
        h("label", { className: "inline" }, "At most ", h("input", { name: "qmax", type: "number", min: 1, className: "tiny", value: existing?.quota?.max ?? "" }),
          " requests per ", h("input", { name: "qhours", type: "number", min: 0.1, step: "any", className: "tiny", value: existing?.quota?.perHours ?? 24 }), " hours"),
        h("p", { className: "muted" }, "Leave the first box empty for no limit. A limit caps what a runaway or malicious program can spend with this key. It resets when the page reloads.")),
      err,
      h("div", { className: "card-actions" },
        h("button", { type: "button", onclick: () => { editing = null; blurActive(); draw(); } }, "Cancel"),
        h("button", { type: "submit", className: "primary" }, existing ? "Save" : "Add secret")));
    return f;
  }

  draw();
  const off = gate.subscribe(draw);
  addEventListener("pagehide", off);
  setInterval(draw, 2000);
}
