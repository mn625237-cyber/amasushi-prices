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

// ── SW Lifecycle ──
// skipWaiting: يمنع الـ stale SW من التعلق بعد update
// clients.claim: يضمن أن الـ SW الجديد يتحكم فوراً في كل tabs
self.addEventListener('install',  ()  => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(clients.claim()));

const messaging = firebase.messaging();

// ── Background Message Handler ──
// يُستدعى فقط عندما الـ app في الخلفية أو مغلق
// data-only payload: FCM لا يعرض إشعاراً تلقائياً — نحن المسؤولون عن العرض هنا
// tag: 'visit-notif' → يمنع stacking — الإشعار الجديد يستبدل القديم
// renotify: false → لا صوت/اهتزاز إضافي لو الإشعار لم يُغلق بعد
messaging.onBackgroundMessage(payload => {
  const title = payload.data?.title || '🛵 زيارة جديدة';
  const body  = payload.data?.body  || '';

  return self.registration.showNotification(title, {
    body,
    tag:              'visit-notif',
    renotify:         false,
    icon:             '/logo.jpg',
    badge:            '/logo.jpg',
    requireInteraction: false,
    vibrate:          [200, 100, 200],
    data: { url: 'https://amasushi-prices.vercel.app' }
  });
});

// ── Notification Click ──
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
