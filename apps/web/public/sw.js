/* Tessera's service worker: shows push notifications, and answers a prompt from the notification itself. */

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (e) => {
  let d = {};
  try {
    d = e.data ? e.data.json() : {};
  } catch {
    d = { title: "Tessera", body: e.data ? e.data.text() : "" };
  }
  const actions = !d.ask
    ? []
    : d.ask.kind === "plan"
      ? [{ action: "approve", title: "Approve plan" }, { action: "reject", title: "Send back" }]
      : d.ask.kind === "permission"
        ? [{ action: "allow", title: "Allow once" }, { action: "deny", title: "Deny" }]
        : [];
  e.waitUntil(
    self.registration.showNotification(d.title || "Tessera", {
      body: d.body || "",
      tag: d.tag || undefined,
      renotify: d.kind === "waiting",
      requireInteraction: d.kind === "waiting" && !!d.ask,
      icon: "/brand/icon-192.png",
      badge: "/brand/badge-96.png",
      data: d,
      actions,
    }),
  );
});

async function answer(d, decision) {
  let message;
  try {
    const r = await fetch(`/api/fleet/sessions/${encodeURIComponent(d.sessionId)}/answer`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", "x-tessera-client": "web" },
      body: JSON.stringify({ askId: d.ask.id, decision }),
    });
    if (r.ok) message = decision === "deny" || decision === "reject" ? "Sent. The session will see it in a moment." : "Sent. The session continues in a moment.";
    else if (r.status === 401) message = "Sign in to Tessera on this device to answer from notifications.";
    else message = (await r.json().catch(() => ({}))).error || "Could not answer from here. Open Tessera.";
  } catch {
    message = "No connection to Tessera. Open it to answer.";
  }
  await self.registration.showNotification(d.title || "Tessera", { body: message, tag: d.tag || undefined, icon: "/brand/icon-192.png", badge: "/brand/badge-96.png", data: { url: d.url }, silent: true });
}

async function open(url) {
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const w of windows) {
    if (new URL(w.url).origin === self.location.origin) {
      await w.focus();
      if ("navigate" in w) await w.navigate(url).catch(() => {});
      return;
    }
  }
  await self.clients.openWindow(url);
}

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const d = e.notification.data || {};
  if (e.action && d.ask && d.sessionId) e.waitUntil(answer(d, e.action));
  else e.waitUntil(open(d.url || "/app"));
});
