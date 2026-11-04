// Service worker. Performs fetch() on behalf of the IDE page for sites the
// user has approved. What makes this safe is mostly NOT this code:
//
//  * Chrome only lets an extension read cross-origin responses from hosts it
//    holds a host permission for. This extension ships with none; each host is
//    an *optional* permission the user grants in a native browser dialog
//    (popup.js → chrome.permissions.request). A page cannot fake or skip that
//    dialog, and it can be revoked any time in the popup or chrome://extensions.
//  * Every request is credentials: "omit": no cookies, no HTTP auth cache, no
//    client certificates. To the remote site this looks like an anonymous
//    server-side request, which is all a CORS-bypass needs to be.
//  * Only content.js, which Chrome injects only into APP_ORIGINS (the gate's
//    origin), can connect. The gate is an iframe, so frameId isn't checked;
//    the gate itself only serves the IDE origin it is configured for.
//
// This file adds: the local-network blocklist (policy.js), a check that a
// redirect didn't land somewhere unapproved, and request/response streaming.
import { APP_ORIGINS, refuse, originPattern } from "./policy.js";

const b64 = (u8) => { let s = ""; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const approved = (url) => chrome.permissions.contains({ origins: [originPattern(url)] });

async function addPending(url) {
  const host = new URL(url).hostname;
  const { pending = [] } = await chrome.storage.session.get("pending");
  if (!pending.includes(host)) pending.push(host);
  await chrome.storage.session.set({ pending });
  await chrome.action.setBadgeText({ text: String(pending.length) });
  await chrome.action.setBadgeBackgroundColor({ color: "#d97706" });
}

chrome.runtime.onConnect.addListener((port) => {
  const origin = port.sender?.origin;
  if (port.name !== "vm-net" || !APP_ORIGINS.includes(origin)) {
    port.disconnect();
    return;
  }
  const inflight = new Map(); // id -> AbortController

  port.onMessage.addListener(async (msg) => {
    if (msg.abort) { inflight.get(msg.id)?.abort(); return; }
    const { id, url, method = "GET", headers = [], body } = msg;
    const fail = (code, message) => port.postMessage({ id, error: { code, message } });

    const why = refuse(url);
    if (why) return fail("refused", why);
    if (!(await approved(url))) {
      await addPending(url);
      return fail("not-approved", `${new URL(url).hostname} is not approved yet. Click the Browser VM Network Bridge icon in the toolbar to allow it.`);
    }

    const ac = new AbortController();
    inflight.set(id, ac);
    try {
      const resp = await fetch(url, {
        method, headers, signal: ac.signal,
        body: body ? unb64(body) : undefined,
        credentials: "omit",
        cache: "no-store",
        redirect: "follow",
      });
      // A redirect may have taken us to another host. Only hand back the
      // response if that host is approved and public, too.
      if (resp.redirected && (refuse(resp.url) || !(await approved(resp.url)))) {
        resp.body?.cancel();
        if (!refuse(resp.url)) await addPending(resp.url);
        return fail("not-approved", `redirected to ${new URL(resp.url).hostname}, which is not approved`);
      }
      port.postMessage({ id, head: { status: resp.status, statusText: resp.statusText, headers: [...resp.headers], url: resp.url, redirected: resp.redirected } });
      const reader = resp.body?.getReader();
      for (;;) {
        const { value, done } = reader ? await reader.read() : { done: true };
        if (done) break;
        port.postMessage({ id, chunk: b64(value) });
      }
      port.postMessage({ id, end: true });
    } catch (e) {
      fail("network", e.message);
    } finally {
      inflight.delete(id);
    }
  });

  port.onDisconnect.addListener(() => { for (const ac of inflight.values()) ac.abort(); });
});
