/* Background notifications (Firebase Cloud Messaging).
 * Shows an announcement as a phone notification when the site isn't open,
 * and opens the site's Home when the notification is tapped. */
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');

// Re-use the site's config.js (it sets window.WP_CONFIG; a service worker has no window).
self.window = self;
importScripts('config.js');

const cfg = self.WP_CONFIG && self.WP_CONFIG.FIREBASE;
if (cfg && cfg.apiKey) {
  firebase.initializeApp(cfg);
  const messaging = firebase.messaging();

  // Messages sent with a "notification" part are shown automatically by Firebase.
  // This handles data-only messages, just in case.
  messaging.onBackgroundMessage(payload => {
    if (payload.notification) return;
    const d = payload.data || {};
    self.registration.showNotification(d.title || 'Nupur & Aditya', {
      body: d.body || '',
      icon: '/assets/an-monogram.png',
      badge: '/assets/an-monogram.png',
      data: { link: d.link || '/photos/#home' }
    });
  });
}

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const link = (event.notification.data && (event.notification.data.link || (event.notification.data.FCM_MSG && event.notification.data.FCM_MSG.notification && event.notification.data.FCM_MSG.notification.click_action))) || '/photos/#home';
  event.waitUntil((async () => {
    const all = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if (c.url.includes('/photos/')) { await c.focus(); c.navigate(link).catch(() => {}); return; }
    }
    await clients.openWindow(link);
  })());
});
