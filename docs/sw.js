// Al-Wilayat service worker — powers azan prayer reminders (notifications).
// Client-scheduled reminders call registration.showNotification(); the "push"
// handler is here so a backend can later deliver reminders when the app is closed.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

// Tapping an azan notification focuses the app and opens the Prayer page (to mark it → streak).
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || "./#prayer";
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ("focus" in c) { if (c.navigate) { try { c.navigate(url); } catch (_) {} } return c.focus(); }
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});

// Future: server-sent Web Push (works when the app is fully closed).
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { body: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(d.title || "🕌 Azan", {
    body: d.body || "",
    tag: d.tag || "azan",
    data: d.data || { url: "./#prayer" },
    icon: "assets/al-wilayat-logo.jpeg?v=5",
    badge: "assets/al-wilayat-logo.jpeg?v=5",
    requireInteraction: true,
    vibrate: [200, 100, 200],
  }));
});
