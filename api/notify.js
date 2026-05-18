const admin = require('firebase-admin');

// ── Init Firebase Admin (مرة واحدة فقط) ──
if (!admin.apps.length) {
  const credentials = JSON.parse(process.env.FIREBASE_CREDENTIALS);
  admin.initializeApp({
    credential: admin.credential.cert(credentials)
  });
}

const db = admin.firestore();

// ── Replay Protection — آخر 20 timestamp في memory ──
const usedTimestamps = new Set();

module.exports = async (req, res) => {

  // CORS
  res.setHeader('Access-Control-Allow-Origin',  'https://amasushi-prices.vercel.app');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Notify-Secret, X-Timestamp');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ── 1. Secret Check ──
  const secret = req.headers['x-notify-secret'];
  if (!secret || secret !== process.env.NOTIFY_SECRET) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  // ── 2. Origin Check ──
  const origin = req.headers['origin'] || '';
  if (!origin.includes('amasushi-prices.vercel.app')) {
    return res.status(403).json({ error: 'Forbidden origin' });
  }

  // ── 3. Timestamp Check (أحدث من 30 ثانية) ──
  const ts = parseInt(req.headers['x-timestamp'] || '0');
  const now = Date.now();
  if (!ts || Math.abs(now - ts) > 30000) {
    return res.status(403).json({ error: 'Expired request' });
  }

  // ── 4. Replay Protection ──
  if (usedTimestamps.has(ts)) {
    return res.status(403).json({ error: 'Duplicate request' });
  }
  usedTimestamps.add(ts);
  if (usedTimestamps.size > 20) {
    const first = usedTimestamps.values().next().value;
    usedTimestamps.delete(first);
  }

  // ── 5. جيب FCM Token ──
  let token;
  try {
    const doc = await db.collection('fcm_tokens').doc('admin').get();
    if (!doc.exists) {
      return res.status(200).json({ success: false, note: 'No token yet' });
    }
    token = doc.data().token;
    if (!token) {
      return res.status(200).json({ success: false, note: 'Empty token' });
    }
  } catch (e) {
    return res.status(500).json({ error: 'Firestore error', detail: e.message });
  }

  // ── 6. بيانات الإشعار ──
  const body = req.body || {};
  const os       = body.os      || '—';
  const browser  = body.browser || '—';
  const device   = body.device  || '—';
  const time     = new Date().toLocaleTimeString('ar-EG', {
    hour: '2-digit', minute: '2-digit'
  });

  const notifTitle = '🛵 زيارة جديدة — اما سوشي';
  const notifBody  = `${os} · ${browser} · ${device}\n${time}`;

  // ── 7. إرسال FCM ──
  try {
    await admin.messaging().send({
      token,
      notification: {
        title: notifTitle,
        body:  notifBody
      },
      webpush: {
        headers: { Urgency: 'high' },
        notification: {
          icon:               '/logo.jpg',
          badge:              '/logo.jpg',
          tag:                'visit-notif',
          renotify:           true,
          requireInteraction: false,
          vibrate:            [200, 100, 200]
        },
        fcmOptions: {
          link: 'https://amasushi-prices.vercel.app'
        }
      }
    });

    return res.status(200).json({ success: true });

  } catch (e) {
    // لو التوكن فاسد — امسحه تلقائياً
    if (e.code === 'messaging/registration-token-not-registered') {
      await db.collection('fcm_tokens').doc('admin').delete();
      return res.status(200).json({ success: false, note: 'Token deleted — resubscribe needed' });
    }
    return res.status(500).json({ error: 'FCM error', detail: e.message });
  }
};
