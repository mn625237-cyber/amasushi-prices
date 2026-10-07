const admin = require('firebase-admin');

// ── Init Firebase Admin (مرة واحدة فقط) ──
if (!admin.apps.length) {
  const credentials = JSON.parse(process.env.FIREBASE_CREDENTIALS);
  admin.initializeApp({
    credential: admin.credential.cert(credentials)
  });
}

const db = admin.firestore();
const ADMIN_UID = 'jmarGOcrLfd0ryIk2fS3mgltqC73';
const APP_ID = '1:972743740267:web:24eb04cf828b545a41da2e';
const ALLOWED_ORIGIN = 'https://amasushi-prices.vercel.app';
const PAYLOAD_LIMITS = { os: 80, browser: 40, device: 80 };

function validatePayload(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;

  const fields = Object.keys(PAYLOAD_LIMITS);
  if (Object.keys(body).some(key => !fields.includes(key))) return null;

  const result = {};
  for (const field of fields) {
    const value = body[field];
    if (typeof value !== 'string') return null;

    const normalized = value.trim();
    if (!normalized || normalized.length > PAYLOAD_LIMITS[field] || /[\u0000-\u001f\u007f]/.test(normalized)) {
      return null;
    }
    result[field] = normalized;
  }

  return result;
}

module.exports = async (req, res) => {
  // ── CORS ──
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Firebase-AppCheck, X-Timestamp');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ── Origin Check ──
  const origin = req.headers.origin || '';
  if (origin !== ALLOWED_ORIGIN) {
    return res.status(403).json({ error: 'Forbidden origin' });
  }

  // ── Timestamp Check (أحدث من 30 ثانية) ──
  const timestamp = req.headers['x-timestamp'];
  const ts = typeof timestamp === 'string' && /^\d{13}$/.test(timestamp)
    ? Number(timestamp)
    : 0;
  if (!ts || !Number.isSafeInteger(ts) || Math.abs(Date.now() - ts) > 30000) {
    return res.status(403).json({ error: 'Expired request' });
  }

  // ── Firebase App Check ──
  const appCheckToken = req.headers['x-firebase-appcheck'];
  if (typeof appCheckToken !== 'string' || !appCheckToken) {
    return res.status(401).json({ error: 'verification_failed' });
  }

  try {
    const decodedToken = await admin.appCheck().verifyToken(appCheckToken);
    if (decodedToken.app_id !== APP_ID) {
      return res.status(401).json({ error: 'app_id_mismatch' });
    }
  } catch (_) {
    return res.status(401).json({ error: 'verification_failed' });
  }

  // ── Request Content-Type and payload validation ──
  const contentType = req.headers['content-type'] || '';
  if (typeof contentType !== 'string' || !/^application\/json(?:\s*;|$)/i.test(contentType)) {
    return res.status(415).json({ error: 'Content-Type must be application/json' });
  }

  const payload = validatePayload(req.body);
  if (!payload) {
    return res.status(400).json({ error: 'Invalid notification payload' });
  }

  // ── جيب FCM Token ──
  let token;
  try {
    const doc = await db.collection('fcm_tokens').doc(ADMIN_UID).get();
    if (!doc.exists) {
      return res.status(200).json({ success: false, note: 'No token yet' });
    }
    token = doc.data().token;
    if (typeof token !== 'string' || !token.trim()) {
      return res.status(200).json({ success: false, note: 'Empty token' });
    }
  } catch (_) {
    return res.status(500).json({ error: 'Firestore error' });
  }

  // الوقت بتوقيت القاهرة
  const time = new Date().toLocaleTimeString('ar-EG', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Africa/Cairo'
  });

  const notifTitle = '🛵 زيارة جديدة — اما سوشي';
  const notifBody = `${payload.os} · ${payload.browser} · ${payload.device} · ${time}`;

  // ── إرسال FCM — data-only payload ──
  try {
    await admin.messaging().send({
      token,
      data: {
        title: notifTitle,
        body: notifBody
      },
      webpush: {
        headers: { Urgency: 'high' },
        fcmOptions: {
          link: ALLOWED_ORIGIN
        }
      }
    });

    return res.status(200).json({ success: true });
  } catch (e) {
    // لو التوكن فاسد — امسحه تلقائياً
    if (e.code === 'messaging/registration-token-not-registered') {
      await db.collection('fcm_tokens').doc(ADMIN_UID).delete();
      return res.status(200).json({ success: false, note: 'Token deleted — resubscribe needed' });
    }
    return res.status(500).json({ error: 'FCM error' });
  }
};
