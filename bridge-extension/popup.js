// Approval UI. chrome.permissions.request() must be called from a user
// gesture in the extension's own UI, so a web page can never grant itself
// access. Chrome then shows its own confirmation dialog.
const $ = (id) => document.getElementById(id);

function row(host, label, cls, onClick) {
  const li = document.createElement("li");
  const code = document.createElement("code");
  code.textContent = host;
  const btn = document.createElement("button");
  btn.textContent = label;
  if (cls) btn.className = cls;
  btn.addEventListener("click", onClick);
  li.append(code, btn);
  return li;
}

async function render() {
  const { pending = [] } = await chrome.storage.session.get("pending");
  const { origins = [] } = await chrome.permissions.getAll();
  // Only granted https:// hosts (the IDE origin in content_scripts is listed too; skip it).
  const allowed = origins.filter((o) => o.startsWith("https://")).map((o) => new URL(o.replace("*", "x")).hostname);

  $("pending").replaceChildren(...pending.map((host) => row(host, "Allow", "allow", async () => {
    const ok = await chrome.permissions.request({ origins: [`https://${host}/*`] });
    if (ok) await setPending(pending.filter((h) => h !== host));
    render();
  })));
  if (!pending.length) $("pending").innerHTML = '<li class="empty">Nothing waiting.</li>';

  $("allowed").replaceChildren(...allowed.map((host) => row(host, "Revoke", "", async () => {
    await chrome.permissions.remove({ origins: [`https://${host}/*`] });
    render();
  })));
  if (!allowed.length) $("allowed").innerHTML = '<li class="empty">No sites yet.</li>';
}

async function setPending(pending) {
  await chrome.storage.session.set({ pending });
  await chrome.action.setBadgeText({ text: pending.length ? String(pending.length) : "" });
}

render();
