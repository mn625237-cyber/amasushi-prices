importScripts('https://www.gstatic.com/firebasejs/10.7.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.7.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey:            "AIzaSyBRSTsBy_2rgfqWASSFAF3jNXe2fgvnWw8",
  authDomain:        "amasushi-prices.firebaseapp.com",
  projectId:         "amasushi-prices",
  storageBucket:     "amasushi-prices.firebasestorage.app",
  messagingSenderId: "972743740267",
  appId:             "1:972743740267:web:24eb04cf828b545a41da2e"
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage(payload => {
  const title = payload.notification?.title || '🛵 زيارة جديدة';
  const body  = payload.notification?.body  || '';

  return self.registration.showNotification(title, {
    body,
    icon:               '/logo.jpg',
    badge:              '/logo.jpg',
    requireInteraction: false,
    vibrate:            [200, 100, 200],
    data: { url: 'https://amasushi-prices.vercel.app' }
  });
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) {
        if (c.url.includes('amasushi-prices') && 'focus' in c) return c.focus();
      }
      if (clients.openWindow) {
        return clients.openWindow('https://amasushi-prices.vercel.app');
      }
    })
  );
});
